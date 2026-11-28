/**
 * cloudImageGen —— 云端后台生图的客户端编排（S2）。
 *
 * 职责：
 *   1. 开关与能力探测（设置 → 生图「云端后台生成」，需 amsg 已连接且 Worker 报告
 *      imageGen 能力；未连接/版本旧/鉴权未过 → 不允许开启并明确提示）。
 *   2. 提交：与本地同一套适配器逻辑构建上游模板（含视觉身份参考图），信封加密后
 *      POST /image-gen（幂等 taskId）；消息立即落 pending + metadata.cloudImageTaskId。
 *   3. 前台轮询：提交后 10s 一拍（上限 15 分钟）——页面开着也能自动收图。
 *   4. 恢复：回页面/刷新/锁屏后按消息里的 taskId 查询 → completed 下载 → 写入既有
 *      blobref 存储并更新原消息（幂等：已 ready 的消息不动，相册记录按 messageId 去重）；
 *      failed → 失败原因；unknown → 「结果待确认」+ 手动重试，绝不自动重发。
 * 关闭开关时一切回落到浏览器直接生图（既有行为不变）。
 */

import type { CharacterProfile, Message } from '../types';
import { ActiveMsgClient } from './activeMsgClient';
import { ActiveMsgStore } from './activeMsgStore';
import { buildCloudImageGenTemplate } from './imageGenerationService';
import { loadImageGenerationConfig } from './imageGenerationConfig';
import { putImageBlob } from './blobRef';
import { DB } from './db';
import { syncAssistantPhotoToGallery } from './gallerySync';
import type { ChatPhotoIntent } from './chatPhotoIntent';
import { bindMessagePhoto, fitCloudPhotoReferences, photoReferencePreviews } from './photoIdentityBinding';
import type { CameraReference } from './sceneCameraReferences';
import type { ChatPhotoMeta } from './chatPhotoGeneration';

export const CLOUD_IMAGE_GEN_CONFIG_KEY = 'cloud_image_gen_config_v1';
export const CLOUD_IMAGE_GEN_CONFIG_EVENT = 'cloud-image-gen-config-changed';
export const CLOUD_PHOTO_SETTLED_EVENT = 'cloud-photo-settled';

export interface CloudImageGenConfig {
    enabled: boolean;
}

export function loadCloudImageGenConfig(): CloudImageGenConfig {
    try {
        const parsed = JSON.parse(localStorage.getItem(CLOUD_IMAGE_GEN_CONFIG_KEY) || '{}');
        return { enabled: parsed?.enabled === true };
    } catch {
        return { enabled: false };
    }
}

export function saveCloudImageGenConfig(config: CloudImageGenConfig): void {
    try {
        localStorage.setItem(CLOUD_IMAGE_GEN_CONFIG_KEY, JSON.stringify(config));
        window.dispatchEvent(new CustomEvent(CLOUD_IMAGE_GEN_CONFIG_EVENT));
    } catch { /* 存不进就当没开 */ }
}

/** 快速判定：开关开着 + amsg 全局配置齐（能力探测在设置页做，避免聊天路径多一次往返）。 */
export async function isCloudImageGenActive(): Promise<boolean> {
    if (!loadCloudImageGenConfig().enabled) return false;
    try {
        const config = await ActiveMsgStore.getGlobalConfig();
        return Boolean(config?.workerUrl && config?.userId && config?.serverToken && config?.masterKey);
    } catch {
        return false;
    }
}

export type CloudImageGenCapability =
    { ok: true; storage: 'r2' | 'd1'; version?: string }
    | { ok: false; reason: 'not-connected' | 'unsupported' | 'unauthenticated' | 'misconfigured' | 'unreachable'; version?: string };

export async function probeCloudImageGenCapability(): Promise<CloudImageGenCapability> {
    let config;
    try {
        config = await ActiveMsgStore.getGlobalConfig();
    } catch {
        return { ok: false, reason: 'not-connected' };
    }
    if (!config?.workerUrl || !config?.userId) return { ok: false, reason: 'not-connected' };
    try {
        const report = await ActiveMsgClient.fetchWorkerConfigCheck();
        if (!report) return { ok: false, reason: 'unreachable' };
        const version = typeof report.workerVersion === 'string' ? report.workerVersion : undefined;
        if (report.imageGen !== true) return { ok: false, reason: 'unsupported', version };
        if ((report.imageAuth !== 'owner-token' && report.serverTokenEnforced !== true) || !config.masterKey) {
            return { ok: false, reason: 'misconfigured', version };
        }
        if (!config.serverToken?.trim()) return { ok: false, reason: 'unauthenticated', version };
        const route = await ActiveMsgClient.probeImageGenRoute(config);
        if (route !== 'ready') return { ok: false, reason: route, version };
        return { ok: true, storage: report.imageStorage === 'r2' ? 'r2' : 'd1', version };
    } catch {
        return { ok: false, reason: 'unreachable' };
    }
}

// ─── 提交 ─────────────────────────────────────────────────

export interface CloudPhotoSubmitArgs {
    char: CharacterProfile;
    intent: ChatPhotoIntent;
    groupId?: string;
    /** 已落库的 pending 消息 id（先落消息再提交，taskId 写进 metadata）。 */
    messageId: number;
    onToast?: (msg: string, type: 'info' | 'success' | 'error') => void;
}

export interface CloudPhotoSubmitResult {
    taskId: string;
}

/**
 * 提交云端生图任务并挂到指定消息上。失败（含配置/网络/超限）时把消息翻成 failed+原因——
 * 绝不留下既不是云任务也不是本地生成的悬空 pending。提交成功即返回：之后切 App/锁屏/
 * 关页面都无所谓，恢复靠消息里的 taskId。
 */
export async function submitCloudPhotoTask(args: CloudPhotoSubmitArgs): Promise<CloudPhotoSubmitResult | null> {
    const { char, intent, groupId, messageId, onToast } = args;
    const taskId = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `imgtask-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    let template;
    let references: CameraReference[];
    try {
        const config = loadImageGenerationConfig();
        if (!config.enabled) throw new Error('生图 API 未启用，请先在设置中开启');
        const binding = await bindMessagePhoto(char, intent, config);
        const fitted = await fitCloudPhotoReferences(binding.references);
        template = await buildCloudImageGenTemplate({ ...binding.options, referenceImages: fitted.map(ref => ref.data) }, config);
        references = await photoReferencePreviews(fitted);
    } catch (error) {
        await markCloudPhotoFailed(messageId, error instanceof Error ? error.message : String(error));
        onToast?.(error instanceof Error ? error.message : '云端生图任务没能建立', 'error');
        return null;
    }
    try {
        // Save the id before POST so a lost acknowledgement can be reconciled without issuing another job.
        await DB.updateMessageMetadata(messageId, prev => ({ ...prev, cloudImageTaskId: taskId, chatPhoto: { ...prev?.chatPhoto, references } }));
        await ActiveMsgClient.submitImageGenTask(taskId, template);
    } catch (error) {
        await markCloudPhotoFailed(messageId, error instanceof Error ? error.message : String(error));
        onToast?.('云端生图任务提交失败，已回退为可手动重试', 'error');
        return null;
    }
    rememberCloudTaskMessage(taskId, { messageId, charId: char.id, groupId });
    startCloudPhotoPoller(taskId);
    return { taskId };
}

async function markCloudPhotoFailed(messageId: number, reason: string): Promise<void> {
    try {
        await DB.updateMessageMetadata(messageId, prev => ({
            ...(prev || {}),
            chatPhoto: { ...((prev?.chatPhoto || {}) as ChatPhotoMeta), status: 'failed', reason: reason.slice(0, 300) },
        }));
    } catch { /* 写不进就交给 UI 的 stale 兜底 */ }
}

// ─── 收图与恢复 ───────────────────────────────────────────

/** 「结果待确认」的说明：云端状态 unknown 时不在客户端猜，交回手动重试。 */
export const CLOUD_IMAGE_UNCONFIRMED_REASON = '云端生成结果待确认（上游结果不明，未自动重发以避免重复扣费）。可点重试重新生成。';

/** unknown 状态超过这个时长还没收敛 → 按「结果待确认」落 failed（在此之前保持 pending）。 */
export const CLOUD_IMAGE_UNKNOWN_SETTLE_MS = 15 * 60 * 1000;

const inFlightSettles = new Set<number>();

/** Old cards may say failed while their Worker job is running or already completed. */
export async function resumeCloudPhotoBeforeRetry(message: Message): Promise<boolean> {
    const taskId = message.metadata?.cloudImageTaskId;
    if (!taskId) return false;
    const task = await ActiveMsgClient.queryImageGenTask(taskId);
    if (!task || task.status === 'failed' || task.status === 'unknown') return false;
    await DB.updateMessageMetadata(message.id, prev =>
        prev.cloudImageTaskId === taskId && prev.chatPhoto.status !== 'ready'
            ? { ...prev, chatPhoto: { ...prev.chatPhoto, status: 'pending' } } : prev);
    rememberCloudTaskMessage(taskId, { messageId: message.id, charId: message.charId, groupId: message.groupId });
    startCloudPhotoPoller(taskId);
    return true;
}

/**
 * 结算一条云端拍照消息：completed → 下载 → blobref → ready（+相册，按 messageId 幂等）；
 * failed → 原因；unknown 超时 → 结果待确认。消息已非 pending 时直接跳过（幂等）。
 */
export async function settleCloudPhotoMessage(message: Message): Promise<'settled' | 'skip' | 'pending'> {
    const taskId = message.metadata?.cloudImageTaskId;
    const meta = message.metadata?.chatPhoto as ChatPhotoMeta | undefined;
    if (!taskId || !meta || meta.status !== 'pending') return 'skip';
    if (inFlightSettles.has(message.id)) return 'pending';
    inFlightSettles.add(message.id);
    try {
        const task = await ActiveMsgClient.queryImageGenTask(taskId);
        if (task === null) {
            // A resumed page may see the saved id before the POST is acknowledged.
            if (Date.now() - meta.createdAt < 60_000) return 'pending';
            // 云端已查无此任务（过期清理/换过 Worker）：按待确认处理，不自动重发。
            await markCloudPhotoFailed(message.id, '云端已没有这条任务（可能已被过期清理）。可点重试重新生成。');
            return 'settled';
        }
        if (task.status === 'completed') {
            const blob = await ActiveMsgClient.downloadImageGenResult(taskId);
            const blobRef = await putImageBlob(blob);
            await DB.updateMessage(message.id, blobRef);
            await DB.updateMessageMetadata(message.id, prev => ({
                ...(prev || {}),
                chatPhoto: { ...((prev?.chatPhoto || {}) as ChatPhotoMeta), status: 'ready' },
            }));
            try {
                await syncAssistantPhotoToGallery({ charId: message.charId, messageId: message.id, url: blobRef, caption: meta.caption });
            } catch { /* 相册失败不影响消息本体 */ }
            return 'settled';
        }
        if (task.status === 'failed') {
            await markCloudPhotoFailed(message.id, task.error || '云端生成失败');
            return 'settled';
        }
        if (task.status === 'unknown' && Date.now() - (meta.createdAt || 0) > CLOUD_IMAGE_UNKNOWN_SETTLE_MS) {
            await markCloudPhotoFailed(message.id, CLOUD_IMAGE_UNCONFIRMED_REASON);
            return 'settled';
        }
        return 'pending';
    } catch (error) {
        console.warn('[CloudImageGen] 结算查询失败（保持 pending，下次再试）', { taskId, error });
        return 'pending';
    } finally {
        inFlightSettles.delete(message.id);
    }
}

/** 批量恢复：Chat/GroupChat 挂载或回前台时对 pending 且带 cloudImageTaskId 的消息跑一遍。 */
export async function recoverCloudPhotoMessages(messages: Message[]): Promise<number> {
    let settled = 0;
    for (const message of messages) {
        if (message.type !== 'image') continue;
        const meta = message.metadata?.chatPhoto as ChatPhotoMeta | undefined;
        if (!message.metadata?.cloudImageTaskId || !meta || meta.status !== 'pending') continue;
        const outcome = await settleCloudPhotoMessage(message);
        if (outcome === 'settled') settled += 1;
        else if (outcome === 'pending') {
            rememberCloudTaskMessage(message.metadata.cloudImageTaskId, { messageId: message.id, charId: message.charId, groupId: message.groupId });
            startCloudPhotoPoller(message.metadata.cloudImageTaskId);
        }
    }
    return settled;
}

// ─── 前台轮询（提交后页面开着也能自动收图）────────────────

const pollers = new Map<string, ReturnType<typeof setInterval>>();
const CLOUD_POLL_INTERVAL_MS = 10_000;
const CLOUD_POLL_MAX_MS = 15 * 60 * 1000;
const pollStartedAt = new Map<string, number>();

/** 轮询所需的句柄：结算要读真消息（相册归属、群/私聊线程都对得上）。 */
const taskMessageIndex = new Map<string, { messageId: number; charId: string; groupId?: string }>();

export function rememberCloudTaskMessage(taskId: string, handle: { messageId: number; charId: string; groupId?: string }): void {
    taskMessageIndex.set(taskId, handle);
}

async function findIndexedMessage(handle: { messageId: number; charId: string; groupId?: string }): Promise<Message | null> {
    const message = await DB.getMessageById(handle.messageId);
    return message && message.charId === handle.charId && message.groupId === handle.groupId ? message : null;
}

export function startCloudPhotoPoller(taskId: string): void {
    pollStartedAt.set(taskId, Date.now());
    if (pollers.has(taskId)) return;
    const timer = setInterval(() => {
        void (async () => {
            const started = pollStartedAt.get(taskId) || Date.now();
            if (Date.now() - started > CLOUD_POLL_MAX_MS) {
                stopCloudPhotoPoller(taskId);
                return;
            }
            if (typeof document !== 'undefined' && document.hidden) return;
            const handle = taskMessageIndex.get(taskId);
            if (!handle) {
                stopCloudPhotoPoller(taskId);
                return;
            }
            try {
                const message = await findIndexedMessage(handle);
                if (!message || message.metadata?.cloudImageTaskId !== taskId) {
                    stopCloudPhotoPoller(taskId);
                    return;
                }
                const outcome = await settleCloudPhotoMessage(message);
                if (outcome === 'settled' && typeof window !== 'undefined') {
                    const updated = await findIndexedMessage(handle);
                    if (updated?.metadata?.cloudImageTaskId === taskId) {
                        window.dispatchEvent(new CustomEvent(CLOUD_PHOTO_SETTLED_EVENT, { detail: updated }));
                    }
                }
                if (outcome !== 'pending') stopCloudPhotoPoller(taskId);
            } catch { /* 下一拍再试 */ }
        })();
    }, CLOUD_POLL_INTERVAL_MS);
    pollers.set(taskId, timer);
}

export function stopCloudPhotoPoller(taskId: string): void {
    const timer = pollers.get(taskId);
    if (timer) clearInterval(timer);
    pollers.delete(taskId);
    pollStartedAt.delete(taskId);
    taskMessageIndex.delete(taskId);
}

