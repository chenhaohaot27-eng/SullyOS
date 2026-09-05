/**
 * giftChatBridge — GiftRecord → Chat 的投影 + 角色回应触发（Phase 3）。
 *
 * 原则：GiftRecord = canonical truth；聊天礼物卡只是投影（metadata.gift 只存 giftId +
 * 极简快照，reaction/status 永远以 GiftRecord 为准）。
 *
 * 角色回应**严格复用聊天主链路**（禁止第二套聊天实现）：
 *   buildChatRequestPayload（ContextBuilder 人设 + 世界书 + 记忆宫殿 + 历史）
 *   → 末尾追加礼物回应指令（utils/giftIntent.buildGiftReactionInstruction）
 *   → safeFetchJson（当前聊天 API）
 *   → applyAssistantPostProcessing（既有气泡拆分 / 动作 / 剥标签全链路，
 *     经 ctx.giftReactionContext 限定本轮允许回应的 giftId）
 *
 * 失败语义：回应失败/超时 ≠ 送礼失败 —— GiftRecord 保持 delivered，本模块不改礼物状态。
 */

import type { APIConfig, CharacterProfile, GroupProfile, RealtimeConfig, UserProfile } from '../types';
import { DB } from './db';
import { safeFetchJson } from './safeApi';
import { buildChatRequestPayload } from './chatRequestPayload';
import { ChatPrompts } from './chatPrompts';
import { applyAssistantPostProcessing, type XhsCaches } from './applyAssistantPostProcessing';
import { getGiftRecord, updateGiftRecord } from './giftStore';
import type { GiftRecord } from './giftTypes';
import { buildGiftReactionInstruction } from './giftIntent';

// ─── 聊天礼物卡快照（metadata.gift） ─────────────────────────────────────────

export interface GiftCardSnapshot {
    /** 唯一指针：卡片渲染/reaction 状态都以它回读 GiftRecord。 */
    giftId: string;
    direction: 'user_to_character' | 'character_to_user';
    /** 极简 fallback 展示快照（GiftRecord 才是真相源，这里仅供断图/离线兜底与历史 prompt）。 */
    name: string;
    description?: string;
    note?: string;
    imageRef?: string;
    /** vision 完成后由 refreshGiftCardSnapshot 同步进来，供后续轮次历史 prompt 使用。 */
    visualSummary?: string;
}

const snapshotOf = (gift: GiftRecord): GiftCardSnapshot => ({
    giftId: gift.id,
    direction: gift.sender.type === 'user' ? 'user_to_character' : 'character_to_user',
    name: gift.gift.name,
    description: gift.gift.description,
    note: gift.gift.note,
    imageRef: gift.image.imageRef,
    visualSummary: gift.image.visualSummary,
});

// ─── 投影：GiftRecord → 聊天礼物卡（持久幂等） ────────────────────────────────

export interface ProjectGiftResult {
    cardMessageId: string;
    created: boolean;
}

async function findGiftCardMessage(gift: GiftRecord): Promise<{ id: number; metadata?: any } | null> {
    const messages = await DB.getMessagesByCharId(gift.charId, true);
    return messages.find(m => m.type === 'gift_card' && m.metadata?.gift?.giftId === gift.id) || null;
}

/**
 * 把一份礼物投影成对应角色对话里的礼物卡消息（Phase 4 起支持双向）。幂等：
 *  - chat.cardMessageId 已存在且消息仍在 → 直接返回；
 *  - cardMessageId 缺失但聊天里已有同 giftId 的卡 → 回写链接，不重复插入；
 *  - 都没有 → 插一张礼物卡消息并回写 cardMessageId。
 * 覆盖双击 / StrictMode / rerender / bridge 重跑 / 页面刷新：one gift, one logical card。
 */
export async function projectGiftToChat(gift: GiftRecord): Promise<ProjectGiftResult> {
    if (gift.chat?.cardMessageId) {
        const cardId = Number(gift.chat.cardMessageId);
        const existing = Number.isFinite(cardId)
            ? (await DB.getMessagesByCharId(gift.charId, true)).find(m => m.id === cardId)
            : null;
        if (existing) return { cardMessageId: gift.chat.cardMessageId, created: false };
        // 消息被删了 → 落到下面按 metadata 扫描 / 重建。
    }

    const orphan = await findGiftCardMessage(gift);
    if (orphan) {
        const cardMessageId = String(orphan.id);
        if (gift.chat?.cardMessageId !== cardMessageId) {
            await updateGiftRecord(gift.id, { chat: { ...(gift.chat || {}), cardMessageId } });
        }
        return { cardMessageId, created: false };
    }

    const messageId = await DB.saveMessage({
        charId: gift.charId,
        // 玩家送的卡在用户侧；角色送的卡在角色侧（Phase 4）。
        role: gift.sender.type === 'user' ? 'user' : 'assistant',
        type: 'gift_card',
        content: '',
        metadata: { gift: snapshotOf(gift) },
    });
    const cardMessageId = String(messageId);
    await updateGiftRecord(gift.id, { chat: { ...(gift.chat || {}), cardMessageId } });
    return { cardMessageId, created: true };
}

/**
 * vision 摘要晚于投影落定时，把 visualSummary 同步进礼物卡的快照，
 * 让后续轮次的 history prompt（chatPrompts 的 [礼物记录]）能看到识别结果。
 */
export async function refreshGiftCardSnapshot(gift: GiftRecord): Promise<void> {
    const summary = gift.image.visualSummary?.trim();
    if (!summary || !gift.chat?.cardMessageId) return;
    const cardId = Number(gift.chat.cardMessageId);
    if (!Number.isFinite(cardId)) return;
    const messages = await DB.getMessagesByCharId(gift.charId, true);
    const card = messages.find(m => m.id === cardId && m.type === 'gift_card');
    if (card && card.metadata?.gift && card.metadata.gift.visualSummary !== summary) {
        await DB.updateMessageMetadata(cardId, prev => ({
            ...(prev || {}),
            gift: { ...(prev?.gift || {}), visualSummary: summary },
        }));
    }
}

// ─── 角色回应：复用聊天主链路触发一次生成 ────────────────────────────────────

export interface TriggerGiftReactionDeps {
    char: CharacterProfile;
    userProfile: UserProfile;
    groups: GroupProfile[];
    /** 当前聊天 API 配置（OSContext apiConfig 原样传入）。 */
    apiConfig: APIConfig;
    realtimeConfig?: RealtimeConfig;
    addToast?: (msg: string, type: 'info' | 'success' | 'error') => void;
}

export interface TriggerGiftReactionResult {
    ok: boolean;
    /** 失败原因（脱敏，可进日志；送礼状态不受影响）。 */
    reason?: string;
}

/**
 * 触发角色对一份已投递礼物的一次真实聊天回应。
 * 不重复触发：GiftRecord 已有正式 reaction 时直接跳过（与 applyGiftReaction 的
 * first-reaction-wins 一致，避免重放生成）。
 */
export async function triggerGiftReaction(
    giftId: string,
    deps: TriggerGiftReactionDeps,
): Promise<TriggerGiftReactionResult> {
    const fail = (reason: string): TriggerGiftReactionResult => ({ ok: false, reason });
    try {
        const gift = await getGiftRecord(giftId);
        if (!gift) return fail('gift_not_found');
        if (gift.charId !== deps.char.id) return fail('char_mismatch');
        if (gift.sender.type !== 'user') return fail('not_user_gift');
        if (gift.reaction?.acceptance) return fail('already_reacted');

        // vision 摘要若已落定，先同步进礼物卡快照（历史 prompt 能看到）。
        await refreshGiftCardSnapshot(gift);

        const { char, userProfile, groups, apiConfig } = deps;
        const contextLimit = Math.max(1, char.contextLimit || 500);
        const historyMsgs = await DB.getRecentMessagesByCharId(char.id, contextLimit, true);
        const { emojis, categories } = ChatPrompts.filterVisibleEmojis(
            await DB.getEmojis(),
            await DB.getEmojiCategories(),
            char.id,
        );

        const payload = await buildChatRequestPayload({
            char, userProfile, groups, emojis, categories,
            historyMsgs,
            contextLimit: Math.max(1, historyMsgs.length),
            realtimeConfig: deps.realtimeConfig,
            visionApiConfig: apiConfig.visionApi,
        });

        const instruction = buildGiftReactionInstruction(gift, { userName: userProfile?.name || '' });
        const fullMessages = [...payload.fullMessages, { role: 'system', content: instruction }];

        const baseUrl = (apiConfig.baseUrl || '').replace(/\/+$/, '');
        const data = await safeFetchJson(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiConfig.apiKey || 'sk-none'}`,
            },
            body: JSON.stringify({
                model: apiConfig.model,
                messages: fullMessages,
                temperature: apiConfig.temperature ?? 0.85,
                stream: false,
            }),
        }, 2, 0, { appName: '消息', charId: char.id, charName: char.name, purpose: '礼物回应' });

        const aiContent: string = data?.choices?.[0]?.message?.content || '';
        if (!aiContent.trim()) return fail('empty_reply');

        // 全链路后处理：气泡拆分 / 既有动作 / GIFT_REACT 剥离与执行（经 giftReactionContext 限定）。
        const xhsCaches: XhsCaches = {
            xsecTokenCache: new Map(),
            noteTitleCache: new Map(),
            commentUserIdCache: new Map(),
            commentAuthorNameCache: new Map(),
            commentParentIdCache: new Map(),
        };
        await applyAssistantPostProcessing(aiContent, {
            char,
            userProfile,
            emojis,
            realtimeConfig: deps.realtimeConfig,
            groups,
            contextMsgs: historyMsgs,
            fullMessages,
            initialData: data,
            historyMsgCount: historyMsgs.length,
            xhsCaches,
            api: {
                baseUrl,
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey || 'sk-none'}` },
                effectiveApi: { baseUrl, apiKey: apiConfig.apiKey || '', model: apiConfig.model },
            },
            hooks: {
                // Chat App 此刻多半未挂载（用户在 Gift App），落库后由下次打开时从 DB 读取；
                // setMessages 只是 ctx 必填钩子，这里安全置空。
                setMessages: () => {},
                addToast: deps.addToast || (() => {}),
            },
            instantRender: true,
            giftReactionContext: { giftId: gift.id },
        });
        return { ok: true };
    } catch (e) {
        // 回应失败 ≠ 送礼失败：只记一行脱敏日志，GiftRecord 保持 delivered。
        console.warn('[Gift] 角色礼物回应未完成，礼物不受影响:', e instanceof Error ? e.message : e);
        return fail(e instanceof Error ? e.message : 'unknown');
    }
}
