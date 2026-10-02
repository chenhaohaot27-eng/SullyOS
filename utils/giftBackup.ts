/**
 * giftBackup — Gift 备份恢复端的极小规范化层（Phase 6）。
 *
 * 只做三件事，绝不调任何 API / Memory / Chat / Vision / 生图：
 *  1. 逐条基础校验（id/eventKey/charId/sender/recipient/gift/schemaVersion）——
 *     单条损坏按现有备份容错风格跳过该条（warn），不让整包失败；
 *  2. 角色 AI 生图礼物 pending → interrupted（恢复绝不自动续跑生成；prompt/名称等全保留，
 *     用户可手动「重新生成」）；delivered/failed/玩家上传图一律原样；
 *  3. image.imageRef 若是 data URL（ZIP 资产已由 beforeWrite 还原成 base64），重新写入
 *     blob_assets 换回 blobref 令牌——恢复后 Gift App / Chat 卡 / Memory 引用同一份资产。
 *
 * ID 纪律：id / eventKey / createdAt / chat.* / memory.memoryId 全部原样保留，
 * 不得重生成——post-processing 重放 / 卡片去重 / GIFT_SEND 持久幂等全部依赖原值。
 */

import type { GiftRecord } from './giftTypes';

export type RestoreBeforeWrite = (root: any, label: string) => Promise<void>;

/** 单条 GiftRecord 基础校验（§32）。 */
export function isValidGiftBackupRecord(record: unknown): record is GiftRecord {
    if (!record || typeof record !== 'object') return false;
    const r = record as Partial<GiftRecord> & { schemaVersion?: number };
    return typeof r.id === 'string' && !!r.id
        && typeof r.eventKey === 'string' && !!r.eventKey
        && typeof r.charId === 'string' && !!r.charId
        && !!r.sender && typeof r.sender === 'object' && typeof r.sender.id === 'string' && !!r.sender.id
        && !!r.recipient && typeof r.recipient === 'object' && typeof r.recipient.id === 'string' && !!r.recipient.id
        && !!r.gift && typeof r.gift === 'object' && typeof r.gift.name === 'string' && !!r.gift.name
        && r.schemaVersion === 1; // 未来版本按现有备份 validation 风格处理，现在只有 v1
}

/** pending AI 礼物 → interrupted（仅此一类状态迁移；delivered/failed/玩家图原样）。 */
export function normalizeGiftStatusAfterRestore<T extends GiftRecord>(record: T): T {
    const isPendingAiGift = record.sender.type === 'character'
        && record.image?.origin === 'ai_generated'
        && record.status === 'pending'
        && record.image?.status === 'pending';
    if (!isPendingAiGift) return record;
    return {
        ...record,
        status: 'interrupted',
        image: { ...record.image, status: 'interrupted' },
    };
}

/**
 * 恢复规范化入口（db.ts importFullData 的 Gifts 段调用）。
 * beforeWrite：传入 OSContext 的 restoreAssetsInPlace（把 ZIP assets/* 路径还原回 data:image）；
 * 之后 data: imageRef → putImageBlob → 新 blobref（失败保留 data:，宁留不破）。
 */
export async function normalizeGiftRecordsAfterRestore(
    records: unknown,
    beforeWrite?: RestoreBeforeWrite,
): Promise<GiftRecord[]> {
    if (!Array.isArray(records)) return [];
    const out: GiftRecord[] = [];
    // 同一次导入内：完全相同的 data URL → 同一个 blobref（一张图片一份资产，§36）。
    const blobRefCache = new Map<string, string>();
    for (const raw of records) {
        if (!isValidGiftBackupRecord(raw)) {
            console.warn('[Gift][Restore] 跳过一条损坏的礼物记录（不影响其余导入）');
            continue;
        }
        // ZIP 资产路径 → data URL（无 zip 的调用方传 undefined，data: 字段本来就已就位）
        if (beforeWrite) {
            try { await beforeWrite(raw, '礼物'); } catch { /* 资产还原失败继续，令牌兜底 */ }
        }
        let record = normalizeGiftStatusAfterRestore(raw);
        const ref = record.image?.imageRef;
        if (typeof ref === 'string' && ref.startsWith('data:image')) {
            try {
                // 动态 import 避免 db.ts ← giftBackup ← blobRef ← db.ts 的静态环
                const { dataUrlToBlob, putImageBlob } = await import('./blobRef');
                let token = blobRefCache.get(ref);
                if (!token) {
                    token = await putImageBlob(dataUrlToBlob(ref));
                    blobRefCache.set(ref, token);
                }
                record = { ...record, image: { ...record.image, imageRef: token } };
            } catch (e) {
                console.warn('[Gift][Restore] 礼物图片重新入库失败，保留内联数据:', e instanceof Error ? e.message : e);
            }
        }
        out.push(record);
    }
    return out;
}
