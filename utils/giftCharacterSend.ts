/**
 * giftCharacterSend — 角色 → 玩家送礼的图片生成服务（Phase 4）。
 *
 * 硬性顺序（防刷新丢事件 / 防重复扣费）：
 *   合法 GIFT_SEND → persistent eventKey → createGiftRecord(pending) → projectGiftToChat
 *   （UI 立刻看到「生成中」）→ claim → imageGenerationService.generateImage（唯一生图入口，
 *   绝不回退聊天 API / visionApi）→ 成功：Blob→blob_assets→blobref，ready/delivered；
 *   失败：failed + 脱敏 failureReason（礼物不再标 delivered）。
 *
 * 幂等：eventKey（角色+意图指纹）持久防逻辑重复；giftId 级 in-memory claim 防并发双请求；
 *   同一 eventKey 重放 / 并发重放 → 一份礼物、一张卡、一次生图调用。
 * Retry：仅用户显式点击；同 gift.id / 同 eventKey，只重跑生成，不建新礼物；刷新遗留的
 *   长期 pending 判定为 interrupted，绝不自动重新调用 API。
 */

import type { CharacterProfile } from '../types';
import { putImageBlob } from './blobRef';
import { createGiftRecord, getGiftRecord, listGiftRecordsByChar, updateGiftRecord } from './giftStore';
import type { GiftRecord } from './giftTypes';
import { projectGiftToChat } from './giftChatBridge';
import { giftSendIntentKey, type GiftSendIntent } from './giftIntent';
import { collectCharacterReferenceImages } from './chatPhotoGeneration';
import { loadImageGenerationConfig } from './imageGenerationConfig';
import {
    generateImage,
    generatedImageToBlob,
    ImageGenerationError,
} from './imageGenerationService';

/** 与 ChatPhoto 的 CHAT_PHOTO_PENDING_STALE_MS 同口径：超过视为「生成中断」，可手动重试。 */
export const GIFT_SEND_PENDING_STALE_MS = 150_000;

/** 角色自主送礼 cooldown（同一角色 24h 内最多一份新的自主 AI 礼物）。 */
export const GIFT_SEND_COOLDOWN_MS = 24 * 60 * 60 * 1000;

// ─── 运行期 generation claim：同一 giftId 同时只允许一次真实生图请求 ─────────

const CLAIM_TTL_MS = 180_000;
const generationClaims = new Map<string, number>();

// 运行期 eventKey claim：executeGiftSend 进入 createGiftRecord 前先占坑，
// 并发重放直接等首份记录落库后返回 already_exists（持久 unique index 仍是最终防线）。
const sendActionClaims = new Map<string, number>();

function claimSendAction(eventKey: string, now = Date.now()): boolean {
    for (const [key, at] of sendActionClaims) {
        if (now - at > CLAIM_TTL_MS) sendActionClaims.delete(key);
    }
    if (sendActionClaims.has(eventKey)) return false;
    sendActionClaims.set(eventKey, now);
    return true;
}

function releaseSendAction(eventKey: string): void {
    sendActionClaims.delete(eventKey);
}

/** 等 eventKey 对应记录出现（并发重放时首份记录正在创建中）。 */
async function waitForEventKeyRecord(eventKey: string, timeoutMs = 5000): Promise<GiftRecord | null> {
    const { getGiftRecordByEventKey } = await import('./giftStore');
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const found = await getGiftRecordByEventKey(eventKey);
        if (found) return found;
        if (Date.now() >= deadline) return null;
        await new Promise(r => setTimeout(r, 25));
    }
}

function claimGeneration(giftId: string, now = Date.now()): boolean {
    for (const [id, at] of generationClaims) {
        if (now - at > CLAIM_TTL_MS) generationClaims.delete(id);
    }
    if (generationClaims.has(giftId)) return false;
    generationClaims.set(giftId, now);
    return true;
}

function releaseGeneration(giftId: string): void {
    generationClaims.delete(giftId);
}

/** 测试专用：清空 claim 表。 */
export function resetGiftGenerationClaimsForTests(): void {
    generationClaims.clear();
    sendActionClaims.clear();
}

// ─── Cooldown：只统计角色自主送礼（sender=character && source=chat_action） ────

export async function hasRecentCharacterGift(charId: string, withinMs = GIFT_SEND_COOLDOWN_MS): Promise<boolean> {
    const records = await listGiftRecordsByChar(charId);
    const since = Date.now() - withinMs;
    return records.some(g =>
        g.sender.type === 'character'
        && g.source === 'chat_action'
        && g.createdAt > since,
    );
}

// ─── 状态同步：把 image.status 同步进聊天礼物卡快照（history prompt 的「状态」行） ──

async function syncGiftCardStatus(gift: GiftRecord): Promise<void> {
    const cardId = Number(gift.chat?.cardMessageId);
    if (!gift.chat?.cardMessageId || !Number.isFinite(cardId)) return;
    try {
        const { DB } = await import('./db');
        await DB.updateMessageMetadata(cardId, prev => ({
            ...(prev || {}),
            gift: { ...(prev?.gift || {}), status: gift.image.status },
        }));
    } catch (e) {
        console.warn('[Gift] 礼物卡状态同步失败（不影响礼物本体）:', e instanceof Error ? e.message : e);
    }
}

const errMessage = (e: unknown): string =>
    e instanceof Error ? e.message : (typeof e === 'string' && e.trim() ? e : '未知错误');

/** 写库前最后一道脱敏：按当前生图配置的 key 兜底替换 + 截断（chatPhoto redactReason 同款）。 */
const redactReason = (reason: string, secret?: string): string => {
    let text = secret ? reason.split(secret).join('[REDACTED]') : reason;
    text = text.slice(0, 300);
    return text || '礼物图片生成失败';
};

// includeCharacter / style 是意图层信息，不落 GiftRecord；经模块级 Map 透传给生成流程。
const sendIntentMeta = new Map<string, { includeCharacter: boolean; style: string }>();
function giftIncludeCharacterOf(gift: GiftRecord): boolean {
    return sendIntentMeta.get(gift.id)?.includeCharacter === true;
}
function giftStyleOf(gift: GiftRecord): string {
    return sendIntentMeta.get(gift.id)?.style || '';
}

// ─── 核心生图流程（execute 与 retry 共用，调用方负责 claim） ─────────────────

async function runGiftImageGeneration(gift: GiftRecord, char: CharacterProfile): Promise<GiftRecord | null> {
    const config = loadImageGenerationConfig();
    const fail = async (reason: string): Promise<null> => {
        const safe = redactReason(reason, config.apiKey);
        const updated = await updateGiftRecord(gift.id, {
            status: 'failed',
            image: { ...gift.image, status: 'failed', failureReason: safe },
        });
        if (updated) await syncGiftCardStatus(updated);
        console.warn('[Gift] 角色礼物图片生成失败:', safe);
        return null;
    };

    // 独立生图未启用：礼物保留（failed），明确原因，绝不回退聊天 API。
    if (!config.enabled) {
        return fail('生图 API 未启用，请先在「设置 → 生图」中开启并测试通过');
    }

    let referenceImages: Parameters<typeof generateImage>[0]['referenceImages'] = [];
    if (giftIncludeCharacterOf(gift)) {
        try {
            referenceImages = await collectCharacterReferenceImages(char);
        } catch (e) {
            console.warn('[Gift] 角色参考图读取失败，改为不带参考图生成:', e);
            referenceImages = [];
        }
    }

    let result;
    try {
        result = await generateImage({
            prompt: gift.image.prompt || gift.gift.name,
            style: giftStyleOf(gift) || undefined,
            referenceImages,
            // 分辨率/比例不传 → 服务层按 imageGenerationConfig 默认值。
        });
    } catch (e) {
        // 与 ChatPhoto 同款：provider 不支持参考图 → 去掉参考图降级再试一次（仅一次，非自动重试）。
        if (e instanceof ImageGenerationError && e.code === 'REFERENCE_NOT_SUPPORTED' && referenceImages && referenceImages.length > 0) {
            try {
                result = await generateImage({
                    prompt: gift.image.prompt || gift.gift.name,
                    style: giftStyleOf(gift) || undefined,
                    referenceImages: [],
                });
            } catch (e2) {
                return fail(errMessage(e2));
            }
        } else {
            return fail(errMessage(e));
        }
    }

    try {
        const first = result.images[0];
        const blob = await generatedImageToBlob(first);
        const imageRef = await putImageBlob(blob); // 一张礼物图片只存一个 Blob
        const now = Date.now();
        const updated = await updateGiftRecord(gift.id, {
            status: 'delivered',
            deliveredAt: now,
            image: { ...gift.image, status: 'ready', imageRef },
        });
        if (updated) await syncGiftCardStatus(updated);
        return updated;
    } catch (e) {
        return fail(errMessage(e));
    }
}

// ─── 公开 API ────────────────────────────────────────────────────────────────

export type GiftSendSkipReason = 'cooldown' | 'already_exists' | 'generation_in_progress';

export interface ExecuteGiftSendResult {
    gift?: GiftRecord;
    created: boolean;
    skipped?: GiftSendSkipReason;
}

export interface ExecuteGiftSendOptions {
    intent: GiftSendIntent;
    char: CharacterProfile;
    userName?: string;
    /** 玩家明确要求送礼 → 绕过自主 cooldown（默认 false，不做关键词 NLP）。 */
    explicitGiftRequest?: boolean;
    onToast?: (msg: string, type: 'info' | 'success' | 'error') => void;
    refresh?: () => Promise<void> | void;
}

/**
 * 执行一次 GIFT_SEND：先落 pending GiftRecord + 聊天卡（UI 立即可见），再生成图片。
 * eventKey = 角色 + 意图指纹 → post-processing 重放 / 并发重放只落一份礼物、
 * 只发一次生图请求。cooldown 命中时静默跳过（标签已剥、正文照常显示，不改角色文本）。
 */
export async function executeGiftSend(opts: ExecuteGiftSendOptions): Promise<ExecuteGiftSendResult> {
    const { intent, char, userName, explicitGiftRequest, onToast, refresh } = opts;

    // 1. 持久幂等优先于 cooldown：同一逻辑动作的重放不是新礼物，必须返回已有记录。
    //    eventKey = 角色 + 意图指纹 → post-processing 重放 / 并发重放只落一份礼物。
    const eventKey = giftSendIntentKey(char.id, intent);
    const { getGiftRecordByEventKey } = await import('./giftStore');
    const existing = await getGiftRecordByEventKey(eventKey);
    if (existing) {
        return { gift: existing, created: false, skipped: 'already_exists' };
    }

    // 1b. 运行期 claim：并发重放（同一轮 post-processing 双跑 / StrictMode）在此短路，
    //     等首份记录落库后按 already_exists 返回。
    if (!claimSendAction(eventKey)) {
        const winner = await waitForEventKeyRecord(eventKey);
        return winner
            ? { gift: winner, created: false, skipped: 'already_exists' }
            : { created: false, skipped: 'generation_in_progress' };
    }
    try {
        return await executeGiftSendLocked({ ...opts, eventKey });
    } finally {
        releaseSendAction(eventKey);
    }
}

/** claim 已持有下的实际执行（拆出来保证 finally 释放）。 */
async function executeGiftSendLocked(opts: ExecuteGiftSendOptions & { eventKey: string }): Promise<ExecuteGiftSendResult> {
    const { intent, char, userName, explicitGiftRequest, onToast, refresh, eventKey } = opts;

    // 2. Cooldown（角色自主送礼 24h 一份；玩家明确要求可绕过；retry 不走这里所以不受影响）。
    if (!explicitGiftRequest && await hasRecentCharacterGift(char.id)) {
        return { created: false, skipped: 'cooldown' };
    }

    // 3. 先落库（pending）——刷新/断网后事件不丢；投影聊天卡让 UI 立即看到「生成中」。
    const { record, created } = await createGiftRecord({
        eventKey,
        charId: char.id,
        sender: { type: 'character', id: char.id, nameSnapshot: char.name },
        recipient: { type: 'user', id: 'user', nameSnapshot: userName || '你' },
        source: 'chat_action',
        gift: { name: intent.name, description: intent.description, note: intent.note },
        image: { origin: 'ai_generated', status: 'pending', prompt: intent.imagePrompt },
        status: 'pending',
    });
    sendIntentMeta.set(record.id, { includeCharacter: intent.includeCharacter, style: intent.style });
    try {
        await projectGiftToChat(record);
    } catch (e) {
        console.warn('[Gift] 角色礼物卡投影失败（礼物本体不受影响）:', e instanceof Error ? e.message : e);
    }
    await refresh?.();

    // 4. 唯一生图入口（claim 防并发双请求；重放进来时已在生成中 → 直接返回）。
    if (!claimGeneration(record.id)) {
        return { gift: record, created: true, skipped: 'generation_in_progress' };
    }
    try {
        const finished = await runGiftImageGeneration(record, char);
        if (finished) onToast?.(`${char.name}送了你一份礼物：${finished.gift.name}`, 'success');
        else onToast?.('礼物图片生成失败，可稍后手动重试', 'error');
        return { gift: finished || (await getGiftRecord(record.id)) || record, created: true };
    } finally {
        releaseGeneration(record.id);
        await refresh?.();
    }
}

export type RetryGiftImageResult =
    | { ok: true; gift: GiftRecord }
    | { ok: false; reason: 'gift_not_found' | 'not_retryable' | 'already_in_progress' | 'still_failed'; gift?: GiftRecord };

/**
 * 手动重试（仅用户显式点击，无任何自动重试）：同一 gift.id / 同 eventKey，
 * 只重跑图片生成。玩家上传的图片（origin != ai_generated）不可「重新生成」。
 */
export async function retryCharacterGiftImage(
    giftId: string,
    deps: { char: CharacterProfile; onToast?: ExecuteGiftSendOptions['onToast'] },
): Promise<RetryGiftImageResult> {
    const gift = await getGiftRecord(giftId);
    if (!gift) return { ok: false, reason: 'gift_not_found' };
    if (gift.sender.type !== 'character' || gift.image.origin !== 'ai_generated') {
        return { ok: false, reason: 'not_retryable', gift };
    }
    const stalePending = gift.image.status === 'pending'
        && Date.now() - gift.updatedAt > GIFT_SEND_PENDING_STALE_MS;
    if (gift.image.status === 'pending' && !stalePending) {
        return { ok: false, reason: 'already_in_progress', gift };
    }
    if (gift.image.status !== 'failed' && !stalePending) {
        return { ok: false, reason: 'not_retryable', gift };
    }
    if (!claimGeneration(gift.id)) return { ok: false, reason: 'already_in_progress', gift };
    try {
        // 重试状态：pending、failureReason 清空
        const reset = (await updateGiftRecord(gift.id, {
            status: 'pending',
            image: { ...gift.image, status: 'pending', failureReason: undefined },
        })) || gift;
        await syncGiftCardStatus(reset);
        const finished = await runGiftImageGeneration(reset, deps.char);
        if (finished) {
            deps.onToast?.('礼物图片已生成', 'success');
            return { ok: true, gift: finished };
        }
        deps.onToast?.('礼物图片生成失败', 'error');
        return { ok: false, reason: 'still_failed', gift: (await getGiftRecord(gift.id)) || reset };
    } finally {
        releaseGeneration(gift.id);
    }
}
