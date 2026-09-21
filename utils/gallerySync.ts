/**
 * gallerySync —— 相册同步与删除的唯一 canonical 数据访问辅助。
 *
 * 1) assistant 生图入相册：utils/chatPhotoGeneration.ts 的成功路径（消息 content 已替换为
 *    blobref 且 status='ready'）调用 syncAssistantPhotoToGallery。gallery id 由 messageId
 *    决定（`chatphoto-<messageId>`），重试 / 重放 / 恢复都不会产生第二条相册记录。
 *    失败的生成图（fail 路径提前 return）永远不会走到这里。
 *
 * 2) 删除相册记录 + 本地 Blob GC：deleteGalleryImageWithGC 先删 gallery record，再检查
 *    该 blobref 是否仍被 messages / message_favorites / gifts / 其他 gallery 记录引用；
 *    无任何引用才删 blob asset，仍有引用只删记录（避免删出「碎图」）。远程 http(s) 图片
 *    不做任何处理（删不掉也不该删）。
 */

import type { GalleryImage } from '../types';
import { DB } from './db';
import { isBlobRef, deleteBlobRef } from './blobRef';

/** Chat.tsx 用户发图同款本地日期键（YYYY-MM-DD）。 */
export const galleryLocalDateKey = (ts: number): string => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * assistant 拍照成功 → 入相册。幂等：id = `chatphoto-<messageId>`，put 覆盖同一记录。
 * 只存 blobref 令牌（与消息共用同一份 Blob，不复制二进制）。
 */
export async function syncAssistantPhotoToGallery(args: {
    charId: string;
    messageId: number;
    /** 消息 content（blobref: 令牌；也兼容 data URL / http） */
    url: string;
    /** 生成意图的 caption（作为最小 chatContext 供相册点评使用） */
    caption?: string;
    now?: number;
}): Promise<void> {
    const { charId, messageId, url, caption, now = Date.now() } = args;
    if (!url) return; // 失败占位（空 content）不入相册
    const image: GalleryImage = {
        id: `chatphoto-${messageId}`,
        charId,
        url,
        timestamp: now,
        savedDate: galleryLocalDateKey(now),
        chatContext: caption?.trim() ? [`TA 拍下了一张照片：${caption.trim()}`] : ['TA 拍下了一张照片'],
    };
    await DB.saveGalleryImage(image);
}

/**
 * 检查一个 blobref 令牌是否仍被已知 canonical 数据引用。
 * 任何一步读取失败都按「仍有引用」处理（宁可少删，不冒碎图风险）。
 */
export async function isBlobRefReferencedAnywhere(ref: string, options?: { skipGalleryId?: string }): Promise<boolean> {
    // 1) 其他相册记录还在引用（同图被多处保存）
    try {
        const gallery = await DB.getGalleryImages();
        if (gallery.some(img => img.id !== options?.skipGalleryId && img.url === ref)) return true;
    } catch { return true; }

    // 2) 聊天消息 content（assistant 拍照消息本体）
    try {
        const messages = await DB.getAllMessages();
        if (messages.some(m => typeof m.content === 'string' && m.content === ref)) return true;
    } catch { return true; }

    // 3) 留音海螺收藏（图片收藏的 mediaRef）
    try {
        const favorites = await DB.getMessageFavorites();
        if (favorites.some(fav => fav.mediaRef === ref)) return true;
    } catch { return true; }

    // 4) 礼物记录（礼物图的 imageRef 可能是 blobref 令牌）
    try {
        const { listGiftRecords } = await import('./giftStore');
        const gifts = await listGiftRecords();
        if (gifts.some(gift => (gift as any)?.image?.imageRef === ref)) return true;
    } catch { /* giftStore 读取失败不拦删除：gallery 图与礼物图管线独立 */ }

    return false;
}

/**
 * 删除相册记录；若是本地 blobref 且再无任何 canonical 引用 → 一并删除 blob asset 真正释放空间。
 * 返回是否实际 GC 了 blob。
 */
export async function deleteGalleryImageWithGC(img: GalleryImage): Promise<{ blobDeleted: boolean }> {
    await DB.deleteGalleryImage(img.id);
    if (!isBlobRef(img.url)) return { blobDeleted: false }; // data URL 随记录消亡；http 远程图不可删
    const stillReferenced = await isBlobRefReferencedAnywhere(img.url, { skipGalleryId: img.id });
    if (stillReferenced) return { blobDeleted: false };
    await deleteBlobRef(img.url);
    return { blobDeleted: true };
}
