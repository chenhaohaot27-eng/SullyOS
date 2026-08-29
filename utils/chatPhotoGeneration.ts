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

import type { CharacterProfile } from '../types';
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
    status: 'ready' | 'failed';
    /** 失败原因（脱敏后） */
    reason?: string;
}

interface RunArgs {
    char: CharacterProfile;
    messageId: number;
    intent: ChatPhotoIntent;
    onToast?: (msg: string, type: 'info' | 'success' | 'error') => void;
}

/** 核心生图流程：不带 claim（execute 与 retry 共用），调用方负责去重。 */
async function runChatPhotoGeneration({ char, messageId, intent, onToast }: RunArgs): Promise<ChatPhotoRunOutcome> {
    const config = loadImageGenerationConfig();
    const fail = async (reason: string): Promise<ChatPhotoRunOutcome> => {
        const safe = redactReason(reason, config.apiKey);
        await DB.updateMessageMetadata(messageId, prev => ({
            ...(prev || {}),
            chatPhoto: { ...(prev?.chatPhoto || {}), status: 'failed', reason: safe },
        }));
        onToast?.(`照片生成失败：${safe}`, 'error');
        return { status: 'failed', reason: safe };
    };

    // 生图 API 未启用：明确提示去设置开启，而不是静默降级成假图。
    if (!config.enabled) {
        return fail('生图 API 未启用，请先在「设置 → 生图」中开启并测试通过');
    }

    let referenceImages: ReferenceImageInput[] = [];
    if (intent.includeCharacter) {
        try {
            referenceImages = await collectCharacterReferenceImages(char);
        } catch (e) {
            console.warn('[ChatPhoto] 角色参考图读取失败，改为不带参考图生成:', e);
            referenceImages = [];
        }
    }

    let result;
    try {
        result = await generateImage({
            prompt: intent.prompt,
            style: intent.style || undefined,
            referenceImages,
        });
    } catch (e) {
        // openai-images 等不支持参考图的接口：去掉参考图再试一次（同一次用户意图内的
        // 降级，不是自动重试——依然只允许成功一次出图）。
        if (e instanceof ImageGenerationError && e.code === 'REFERENCE_NOT_SUPPORTED' && referenceImages.length > 0) {
            try {
                result = await generateImage({
                    prompt: intent.prompt,
                    style: intent.style || undefined,
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
        const blobRef = await putImageBlob(blob);
        await DB.updateMessage(messageId, blobRef);
        await DB.updateMessageMetadata(messageId, prev => ({
            ...(prev || {}),
            chatPhoto: { ...(prev?.chatPhoto || {}), status: 'ready' },
        }));
        return { status: 'ready' };
    } catch (e) {
        return fail(errMessage(e));
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
    await runChatPhotoGeneration({ char, messageId, intent, onToast });
    await refresh?.();
}

/**
 * 手动重试：按消息 metadata.chatPhoto 里冻存的意图原样重跑一次（用户显式点击，
 * 不受 claim 限制；也不做任何自动重试）。
 */
export async function retryChatPhotoMessage(
    char: CharacterProfile,
    messageId: number,
    onToast?: (msg: string, type: 'info' | 'success' | 'error') => void,
): Promise<ChatPhotoRunOutcome | null> {
    const messages = await DB.getMessagesByCharId(char.id, true);
    const message = messages.find(m => m.id === messageId);
    const meta = message?.metadata?.chatPhoto as ChatPhotoMeta | undefined;
    if (!message || message.type !== 'image' || !meta || !String(meta.prompt || '').trim()) return null;
    const intent: ChatPhotoIntent = {
        prompt: meta.prompt,
        caption: meta.caption || '',
        includeCharacter: meta.includeCharacter === true,
        style: meta.style || '',
    };
    await DB.updateMessageMetadata(messageId, prev => {
        const { reason: _drop, ...rest } = (prev?.chatPhoto || {}) as ChatPhotoMeta;
        return { ...(prev || {}), chatPhoto: { ...rest, status: 'pending', createdAt: Date.now() } };
    });
    return runChatPhotoGeneration({ char, messageId, intent, onToast });
}
