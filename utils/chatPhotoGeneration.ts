/**
 * chatPhotoGeneration — 把 ChatPhotoIntent 变成一条真正的 image 消息。
 *
 * 唯一调用方式（复用 Phase 1 全局生图设施，不碰 provider）：
 *   executeChatPhotoIntent  → 先落一条 pending「正在拍照…」消息 → generateImage →
 *   Blob 进 blob_assets（putImageBlob）→ 消息 content 更新为 `blobref:<id>`、
 *   metadata.chatPhoto.status = 'ready'。失败则 status='failed' + 简短原因，由 UI 提供手动重试
 *   （retryChatPhotoMessage）；不做任何自动重试，也不伪造图片。
 *
 * 持久化沿用聊天消息既有管线：type='image'、content=blobref 令牌。刷新、导出、备份/恢复
 * 复用 useBlobRefUrl 渲染与 resolveBlobRefsDeep 备份抽取，不需要新 store。
 *
 * 凭据纪律：metadata 只存 prompt/caption/style/includeCharacter/reason，绝不存 API Key、
 * Authorization 或完整请求；reason 在写库前对 config.apiKey 做一次额外脱敏兜底。
 */

import type { CharacterProfile, Message } from '../types';
import { DB } from './db';
import { putImageBlob, resolveRefToDataUrl } from './blobRef';
import {
    generateImage,
    generatedImageToBlob,
    ImageGenerationError,
    type ReferenceImageInput,
} from './imageGenerationService';
import { loadImageGenerationConfig } from './imageGenerationConfig';
import { chatPhotoIntentKey, claimChatPhotoTurn, type ChatPhotoIntent } from './chatPhotoIntent';
import { syncAssistantPhotoToGallery } from './gallerySync';
import { registerBrowserTask, settleBrowserTask } from './browserTaskRecovery';
import { isCloudImageGenActive, loadCloudImageGenConfig, submitCloudPhotoTask, resumeCloudPhotoBeforeRetry } from './cloudImageGen';

export type ChatPhotoStatus = 'pending' | 'ready' | 'failed';

/** 挂在 Message.metadata.chatPhoto 上；retry 靠 prompt/includeCharacter/style/caption 原样重跑。 */
export interface ChatPhotoMeta {
    status: ChatPhotoStatus;
    caption: string;
    includeCharacter: boolean;
    style: string;
    prompt: string;
    /** 失败/中断原因（已脱敏，可展示给玩家） */
    reason?: string;
    createdAt: number;
}

/** pending 超过这个时长视为「生成中断」（刷新/崩溃后遗留的占位消息），UI 按 failed 处理并给重试。 */
export const CHAT_PHOTO_PENDING_STALE_MS = 150_000;
const activePhotoRuns = new Set<number>();

export function isStaleLocalPhoto(messageId: number, meta: ChatPhotoMeta, cloudTaskId: unknown, now = Date.now()): boolean {
    return meta.status === 'pending' && !cloudTaskId && !activePhotoRuns.has(messageId)
        && now - (meta.createdAt || 0) > CHAT_PHOTO_PENDING_STALE_MS;
}

const errMessage = (e: unknown): string => (
    e instanceof Error ? e.message : (typeof e === 'string' && e.trim() ? e : '未知错误')
);

/** 服务层已做一遍 Key 脱敏，这里按当前配置再兜一次（写库前的最后一道）。 */
const redactReason = (reason: string, secret?: string): string => {
    let text = secret ? reason.split(secret).join('[REDACTED]') : reason;
    text = text.slice(0, 300);
    return text || '生图失败';
};

/**
 * 角色参考图兼容接口：当前档案没有专门的「角色参考图」字段，先用头像兜底（data URL /
 * http(s) / blobref 都能喂给统一服务）。后续新增参考图字段时只改这里，不新增管理 UI。
 * includeCharacter=false 时调用方根本不会调它。
 */
export async function collectCharacterReferenceImages(char: CharacterProfile): Promise<ReferenceImageInput[]> {
    const avatar = (char as { avatar?: unknown }).avatar;
    if (!avatar || typeof avatar !== 'string') return [];
    if (avatar.startsWith('data:') || /^https?:\/\//i.test(avatar)) return [avatar];
    if (avatar.startsWith('blobref:')) {
        const dataUrl = await resolveRefToDataUrl(avatar);
        return dataUrl ? [dataUrl] : [];
    }
    return [];
}

export interface ChatPhotoRunOutcome {
    status: 'ready' | 'failed' | 'pending';
    /** 失败原因（脱敏后） */
    reason?: string;
}

interface RunArgs {
    char: CharacterProfile;
    messageId: number;
    intent: ChatPhotoIntent;
    onToast?: (msg: string, type: 'info' | 'success' | 'error') => void;
    /** 群聊拍照消息：消息本体带 groupId（charId 仍是发送者），台账/日志归属用。 */
    groupId?: string;
}

/**
 * 核心生图流程：不带 claim（execute 与 retry 共用），调用方负责去重。
 * 全程挂浏览器任务台账（register/settle）：页面在生成期间被切后台/刷新导致没有销账时，
 * 回到页面由 settleStalePendingChatPhotos 把消息翻成「结果待确认」+ 手动重试，
 * 绝不自动重发（生图接口无异步任务 ID 可查，重复请求可能重复扣费）。
 */
async function runChatPhotoGeneration({ char, messageId, intent, onToast, groupId }: RunArgs): Promise<ChatPhotoRunOutcome> {
    const browserTaskId = registerBrowserTask({ kind: 'photo', charId: char.id, groupId });
    try {
        return await runChatPhotoGenerationInner({ char, messageId, intent, onToast, groupId });
    } finally {
        settleBrowserTask(browserTaskId);
    }
}

async function runChatPhotoGenerationInner({ char, messageId, intent, onToast }: RunArgs): Promise<ChatPhotoRunOutcome> {
    const config = loadImageGenerationConfig();
    // 可观测性：分阶段记录（安全脱敏——只有阶段/角色ID/长度，不含 prompt 内容、Key、图片数据）。
    const stageLog = (stage: string, extra: Record<string, unknown> = {}) => {
        console.info(`[ChatPhoto] ${stage}`, { charId: char.id, messageId, includeCharacter: intent.includeCharacter, promptChars: intent.prompt.length, ...extra });
    };
    const fail = async (reason: string, stage = 'generate'): Promise<ChatPhotoRunOutcome> => {
        const safe = redactReason(reason, config.apiKey);
        console.warn(`[ChatPhoto] 失败于 ${stage} 阶段`, { charId: char.id, messageId, reason: safe });
        await DB.updateMessageMetadata(messageId, prev => ({
            ...(prev || {}),
            chatPhoto: { ...(prev?.chatPhoto || {}), status: 'failed', reason: safe },
        }));
        onToast?.(`照片生成失败：${safe}`, 'error');
        return { status: 'failed', reason: safe };
    };

    // 生图 API 未启用：明确提示去设置开启，而不是静默降级成假图。
    if (!config.enabled) {
        return fail('生图 API 未启用，请先在「设置 → 生图」中开启并测试通过', 'config-disabled');
    }

    // ─── Phase 2C：优先使用 characterId（自动处理 visualIdentity），兜底旧头像 ─────
    let characterId: string | undefined;
    let legacyReferenceImages: ReferenceImageInput[] = [];

    if (intent.includeCharacter) {
        characterId = char.id;
        // 兜底：若角色没有 visualIdentity，仍尝试读取头像作为参考图
        try {
            legacyReferenceImages = await collectCharacterReferenceImages(char);
        } catch (e) {
            console.warn('[ChatPhoto] 角色头像读取失败，继续生成:', e);
        }
    }

    let result;
    try {
        stageLog('调用生图服务');
        result = await generateImage({
            prompt: intent.prompt,
            style: intent.style || undefined,
            characterId,
            // 若 visualIdentity 启用，服务层会优先使用 visualIdentity 参考图；
            // 否则兜底使用头像（向后兼容旧角色）
            referenceImages: legacyReferenceImages,
        });
    } catch (e) {
        // 不支持参考图的接口（openai-images 等）：去掉参考图与角色身份后重试一次，
        // 保证仍然只成功出一张图（既有测试锁定：拒绝一次 → 无参考图重试成功一次）。
        // 其他错误：服务层已处理跳过逻辑，这里直接落失败原因。
        const referenceBlocked = e instanceof ImageGenerationError && e.code === 'REFERENCE_NOT_SUPPORTED';
        const usedReferences = !!characterId || legacyReferenceImages.length > 0;
        if (referenceBlocked && usedReferences) {
            stageLog('接口不支持参考图，去掉参考图重试');
            try {
                result = await generateImage({
                    prompt: intent.prompt,
                    style: intent.style || undefined,
                    referenceImages: [],
                });
            } catch (e2) {
                return fail(errMessage(e2), 'generate');
            }
        } else {
            return fail(errMessage(e), 'generate');
        }
    }

    try {
        stageLog('生图返回，落 Blob');
        const first = result.images[0];
        const blob = await generatedImageToBlob(first);
        const blobRef = await putImageBlob(blob);
        await DB.updateMessage(messageId, blobRef);
        await DB.updateMessageMetadata(messageId, prev => ({
            ...(prev || {}),
            chatPhoto: { ...(prev?.chatPhoto || {}), status: 'ready' },
        }));
        // canonical 成功落图点：所有真正成为 assistant image message 的拍照图片统一经
        // gallerySync 入相册（id=chatphoto-<messageId> 幂等；失败路径在上方 fail 提前返回，
        // 永远到不了这里）。retry 复用同一 messageId → 同一相册记录，不重复。
        try {
            await syncAssistantPhotoToGallery({ charId: char.id, messageId, url: blobRef, caption: intent.caption });
        } catch { /* 入相册失败不影响聊天消息本体 */ }
        stageLog('生成成功', { status: 'ready' });
        return { status: 'ready' };
    } catch (e) {
        return fail(errMessage(e), 'persist');
    }
}

export interface ExecuteChatPhotoArgs {
    char: CharacterProfile;
    intent: ChatPhotoIntent;
    /** 统一落库入口（applyAssistantPostProcessing 的 persistMessage，保证时间戳一致） */
    persistMessage: (msg: Parameters<typeof DB.saveMessage>[0]) => Promise<number>;
    /** 每个状态变化后刷新消息列表（setMessages(await DB.getRecentMessagesByCharId(...))） */
    refresh?: () => Promise<void> | void;
    onToast?: (msg: string, type: 'info' | 'success' | 'error') => void;
    /** 本轮统一继承的 metadata（主动消息 source 等），与正文气泡保持同一标记 */
    inheritMeta?: Record<string, any>;
}

/**
 * 拦截到拍照意图后的完整闭环：claim（一轮一次）→ pending 消息 → 生图 → 替换为真实图片。
 * 重复调用同一意图（流式重放 / StrictMode / 重渲染 / 重复点击）在 claim 处直接短路，
 * 不会第二次落 pending 也不会第二次扣费。
 */
export async function executeChatPhotoIntent(args: ExecuteChatPhotoArgs): Promise<void> {
    const { char, intent, persistMessage, refresh, onToast, inheritMeta } = args;
    const key = chatPhotoIntentKey(char.id, intent);
    if (!claimChatPhotoTurn(key)) {
        console.warn('[ChatPhoto] 本轮已处理过同一拍照意图，跳过重复生图', { charId: char.id });
        return;
    }
    const meta: ChatPhotoMeta = {
        status: 'pending',
        caption: intent.caption,
        includeCharacter: intent.includeCharacter,
        style: intent.style,
        prompt: intent.prompt,
        createdAt: Date.now(),
    };
    const messageId = await persistMessage({
        charId: char.id,
        role: 'assistant',
        type: 'image',
        content: '',
        metadata: { ...(inheritMeta || {}), chatPhoto: meta },
    } as Parameters<typeof DB.saveMessage>[0]);
    await refresh?.();
    // S2：云端后台生成开启时优先上云——提交即返回，之后切 App/锁屏/关页面都由云端继续，
    // 消息凭 metadata.cloudImageTaskId 在回页面时补收（cloudImageGen.recoverCloudPhotoMessages）。
    await dispatchChatPhoto({ char, messageId, intent, onToast });
    await refresh?.();
}

/**
 * 手动重试：按消息 metadata.chatPhoto 里冻存的意图原样重跑一次（用户显式点击，
 * 不受 claim 限制；也不做任何自动重试）。
 * groupId 传入时按群线程查消息（群聊拍照消息带 groupId，不在私聊线程里）。
 */
export async function retryChatPhotoMessage(
    char: CharacterProfile,
    messageId: number,
    onToast?: (msg: string, type: 'info' | 'success' | 'error') => void,
    groupId?: string,
): Promise<ChatPhotoRunOutcome | null> {
    const messages: Message[] = groupId
        ? await DB.getGroupMessages(groupId)
        : await DB.getMessagesByCharId(char.id, true);
    const message = messages.find(m => m.id === messageId);
    const meta = message?.metadata?.chatPhoto as ChatPhotoMeta | undefined;
    if (!message || message.type !== 'image' || !meta || meta.status === 'ready' || !String(meta.prompt || '').trim()) return null;
    if (message.metadata?.cloudImageTaskId) {
        try {
            if (await resumeCloudPhotoBeforeRetry(message)) return { status: 'pending' };
        } catch {
            const reason = '暂时查不到原云端任务的状态，请稍后再查询。此次未发起新的生图请求。';
            onToast?.(reason, 'error');
            return { status: 'failed', reason };
        }
    }
    const intent: ChatPhotoIntent = {
        prompt: meta.prompt,
        caption: meta.caption || '',
        includeCharacter: meta.includeCharacter === true,
        style: meta.style || '',
    };
    let claimed = false;
    await DB.updateMessageMetadata(messageId, prev => {
        if (prev?.cloudImageTaskId !== message.metadata?.cloudImageTaskId || !prev?.chatPhoto
            || (prev.chatPhoto.status !== 'failed' && !isStaleLocalPhoto(messageId, prev.chatPhoto, prev.cloudImageTaskId))) return prev;
        claimed = true;
        const { reason: _drop, ...rest } = (prev?.chatPhoto || {}) as ChatPhotoMeta;
        const { cloudImageTaskId: _oldTask, cloudSettled: _settled, ...other } = prev;
        return { ...other, chatPhoto: { ...rest, status: 'pending', createdAt: Date.now() } };
    });
    if (!claimed) return null;
    return dispatchChatPhoto({ char, messageId, intent, onToast, groupId });
}

// ─── 群聊自主发图（C 类）与后台恢复（A 类）──────────────────

export interface ExecuteGroupChatPhotoArgs {
    /** 发送者（照片按其性格/身份生成，相册同步到其名下）。 */
    char: CharacterProfile;
    /** 群 ID：消息带 groupId + charId 双关联。 */
    groupId: string;
    intent: ChatPhotoIntent;
    /** 群聊侧统一落库后的消息 id（由调用方先落 pending 消息再调这里）。 */
    messageId: number;
    onToast?: (msg: string, type: 'info' | 'success' | 'error') => void;
    refresh?: () => Promise<void> | void;
}

/**
 * 群聊拍照消息的生成执行：消息已由调用方落库（pending），这里复用同一套
 * runChatPhotoGeneration（视觉身份/参考图/预设/blobref/相册同步全部一致），
 * 成功后 content 变 blobref、metadata.chatPhoto.status='ready'。
 */
export async function runGroupChatPhotoMessage(args: ExecuteGroupChatPhotoArgs): Promise<ChatPhotoRunOutcome | 'cloud-submitted'> {
    const result = await dispatchChatPhoto(args);
    return result.status === 'pending' ? 'cloud-submitted' : result;
}

async function dispatchChatPhoto(args: RunArgs): Promise<ChatPhotoRunOutcome> {
    activePhotoRuns.add(args.messageId);
    try {
        if (!loadCloudImageGenConfig().enabled) return await runChatPhotoGeneration(args);
        if (!await isCloudImageGenActive()) {
            const reason = '云端后台生成已开启，但 Worker 配对信息不可用。请在生图设置中重新检测。';
            await DB.updateMessageMetadata(args.messageId, prev => ({
                ...prev, chatPhoto: { ...prev.chatPhoto, status: 'failed', reason },
            }));
            args.onToast?.(reason, 'error');
            return { status: 'failed', reason };
        }
        const submitted = await submitCloudPhotoTask(args);
        return submitted ? { status: 'pending' } : { status: 'failed', reason: '云端生图任务提交失败' };
    } finally {
        activePhotoRuns.delete(args.messageId);
    }
}

/** 「结果待确认」的标准说明：页面中断时无法判断上游是否已出图/计费，交给用户决定是否重试。 */
export const CHAT_PHOTO_UNCONFIRMED_REASON = '页面在生成期间中断，结果待确认（未自动重试以避免重复扣费）。可点击重试重新生成。';

/**
 * 后台恢复结算（A5）：把超过 CHAT_PHOTO_PENDING_STALE_MS 仍是 pending 的拍照消息
 * 翻成 failed +「结果待确认」原因。幂等：已 failed/ready 的不动。
 * 返回结算条数。调用方传「刚加载出来的消息列表」（单聊线程或群线程均可）。
 */
export async function settleStalePendingChatPhotos(
    messages: Message[],
    nowMs: number = Date.now(),
): Promise<number> {
    let settled = 0;
    for (const message of messages) {
        if (message.type !== 'image') continue;
        const meta = message.metadata?.chatPhoto as ChatPhotoMeta | undefined;
        if (!meta || meta.status !== 'pending') continue;
        // 云端任务以 Worker 状态为准，本地只结算已经失去执行者的占位。
        if (!isStaleLocalPhoto(message.id, meta, message.metadata?.cloudImageTaskId, nowMs)) continue;
        try {
            await DB.updateMessageMetadata(message.id, prev => {
                if (!prev?.chatPhoto || !isStaleLocalPhoto(message.id, prev.chatPhoto, prev.cloudImageTaskId, nowMs)) return prev;
                settled += 1;
                return { ...prev, chatPhoto: { ...prev.chatPhoto, status: 'failed', reason: CHAT_PHOTO_UNCONFIRMED_REASON } };
            });
        } catch (error) {
            console.warn('[ChatPhoto] 恢复结算写入失败（下次再试）', { messageId: message.id, error });
        }
    }
    if (settled > 0) {
        console.info(`[ChatPhoto] 后台恢复结算：${settled} 条 pending 超时，翻为「结果待确认」`);
    }
    return settled;
}
