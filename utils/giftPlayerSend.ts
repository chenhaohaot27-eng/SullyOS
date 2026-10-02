/**
 * giftPlayerSend — 玩家 → 角色 送礼的薄服务（Phase 2）。
 *
 * 职责：准备 eventKey → 保存上传图片（blob_assets，只存 blobref）→ 创建 GiftRecord
 * （delivered）→ 可选地对本次原始图片执行一次 Vision 识图（非阻塞）→ 成功后回写
 * GiftRecord.image.visualSummary。
 *
 * 边界（Phase 2 约定）：
 *  - 不含任何 React UI；Phase 3 聊天链路可直接复用。
 *  - 只使用 APIConfig.visionApi（utils/visionApi.ts），无 Gift 专用视觉 Provider，
 *    vision 关闭/失败都不影响送礼结果（status 恒为 delivered）。
 *  - 上传图片本地已存在，image.status 直接 'ready'，绝不写 pending。
 *  - Vision 是当前页面生命周期内的非阻塞 Promise：不引入 SW 队列 / 持久重试队列；
 *    页面中途关闭则礼物仍 delivered、只是没有 visualSummary（MVP 可接受）。
 *  - 失败的是识图不是送礼：错误只留 console.warn（不含任何凭据），visualSummary 保持 undefined。
 */

import type { VisionApiConfig } from '../types';
import { blobToDataUrl, putImageBlob } from './blobRef';
import { processImageToBlob } from './file';
import { createGiftRecord, getGiftRecordByEventKey, updateGiftRecord } from './giftStore';
import type { GiftImageOrigin, GiftRecord } from './giftTypes';
import { describeImageWithVisionApi, isVisionApiReady } from './visionApi';

export const GIFT_FALLBACK_NAME = '一份礼物';
/** 仓库没有稳定玩家 ID（UserProfile 无 id 字段），按约定使用固定保留 ID。 */
export const GIFT_USER_ID = 'user';

export class EmptyGiftError extends Error {
    constructor() {
        super('礼物名称、描述和图片不能同时为空');
        this.name = 'EmptyGiftError';
    }
}

export interface SendPlayerGiftInput {
    charId: string;
    /** 收礼角色当前名字快照（写入 recipient.nameSnapshot）。 */
    characterName: string;
    /** 玩家身份；缺省用固定保留 ID 'user'。 */
    userId?: string;
    /** 玩家昵称快照；缺省用通用称呼。 */
    userName?: string;
    /** 礼物名称（可选，空时回退「一份礼物」）。 */
    name?: string;
    description?: string;
    note?: string;
    /** 用户选中的原始图片文件；发送前只在内存持有 preview，不落库。 */
    imageFile?: File | null;
    /** 图片来源：按用户点击的入口记 camera / gallery，不从 File 猜。 */
    imageOrigin?: Extract<GiftImageOrigin, 'camera' | 'gallery'>;
    /** APIConfig.visionApi 原样传入；未启用则完全跳过识图。 */
    visionConfig?: VisionApiConfig | null;
    /** 测试/重放用：显式指定 eventKey；缺省每次 submission 生成新的随机 id。 */
    eventKey?: string;
}

export interface SendPlayerGiftResult {
    record: GiftRecord;
    /** false = eventKey 已存在，本次是幂等命中（重放/双击），返回的是既有记录。 */
    created: boolean;
    /** true = vision 正在后台识别（不阻塞送礼结果）。 */
    visionPending: boolean;
    /**
     * vision 后台任务结束（成功已回写 / 失败静默）后 resolve；永不 reject。
     * 仅供调用方（如测试或 UI 想等摘要落库）可选 await。
     */
    visionSettled: Promise<void>;
}

/** submissionId：优先 crypto.randomUUID，老环境退回时间戳+随机数（不用 Date.now 做唯一防重）。 */
function genSubmissionId(): string {
    const c = typeof crypto !== 'undefined' ? (crypto as Crypto) : undefined;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 玩家送出礼物。纯文字 / 图片+文字 / 只有图片 都允许；
 * name 与 description 与图片三者同时为空才抛 EmptyGiftError。
 */
export async function sendPlayerGift(input: SendPlayerGiftInput): Promise<SendPlayerGiftResult> {
    const name = (input.name || '').trim();
    const description = (input.description || '').trim() || undefined;
    const note = (input.note || '').trim() || undefined;
    const hasImage = !!input.imageFile;
    if (!name && !description && !hasImage) throw new EmptyGiftError();

    const charId = input.charId;
    if (!charId || !charId.trim()) throw new Error('收礼角色不能为空');
    if (!input.characterName || !input.characterName.trim()) throw new Error('角色名不能为空');

    const eventKey = input.eventKey || `gift:user:${charId}:${genSubmissionId()}`;

    // 幂等快路径（双击/重放）：eventKey 已有记录时直接返回，不再进图片存储，避免孤儿 Blob。
    const existing = await getGiftRecordByEventKey(eventKey);
    if (existing) {
        return { record: existing, created: false, visionPending: false, visionSettled: Promise.resolve() };
    }

    // 1. 图片写入 blob_assets（仅一次；换图只在内存换 File，到发送才真正落盘）。
    let imageRef: string | undefined;
    let imageBlobForVision: Blob | null = null;
    if (hasImage && input.imageFile) {
        const blob = await processImageToBlob(input.imageFile, { maxWidth: 1440, quality: 0.9 });
        imageRef = await putImageBlob(blob);
        imageBlobForVision = blob;
    }

    // 2. 创建 GiftRecord（delivered）——玩家主动操作，上传图片本地已存在，绝不 pending。
    const now = Date.now();
    const { record, created } = await createGiftRecord({
        eventKey,
        charId,
        sender: { type: 'user', id: input.userId || GIFT_USER_ID, nameSnapshot: input.userName || '你' },
        recipient: { type: 'character', id: charId, nameSnapshot: input.characterName.trim() },
        source: 'gift_app',
        gift: { name: name || GIFT_FALLBACK_NAME, description, note },
        image: hasImage
            ? { imageRef, origin: input.imageOrigin || 'gallery', status: 'ready' }
            : { origin: 'none', status: 'none' },
        status: 'delivered',
        deliveredAt: now,
    });

    // 3. 可选 Vision：非阻塞执行一次，成功回写 visualSummary，失败静默（不影响 delivered）。
    const visionEligible = !!imageBlobForVision && created && isVisionApiReady(input.visionConfig || undefined);
    if (!visionEligible) {
        return { record, created, visionPending: false, visionSettled: Promise.resolve() };
    }

    const visionSettled = (async () => {
        try {
            const dataUrl = await blobToDataUrl(imageBlobForVision!);
            const summary = await describeImageWithVisionApi(dataUrl, input.visionConfig!);
            if (summary && summary.trim()) {
                await updateGiftRecord(record.id, {
                    image: { ...record.image, visualSummary: summary.trim().slice(0, 4000) },
                });
            }
        } catch (e) {
            // 识图失败 ≠ 送礼失败：只留一行不含凭据的 warn，visualSummary 保持 undefined。
            console.warn('[Gift] 图片识图未完成，礼物不受影响:', e instanceof Error ? e.message : e);
        }
    })();
    // 双保险：即使调用方不持有 visionSettled，也不会产生 unhandled rejection。
    visionSettled.catch(() => { /* unreachable: 内部已全捕获 */ });

    return { record, created, visionPending: true, visionSettled };
}
