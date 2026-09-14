import { deriveFoodOrderStatus } from './foodOrderTimeline';
import type { FoodOrderRecord } from './foodOrderTypes';
import { normalizeFoodUrl, type FoodCatalogItem } from './foodTypes';

export type FoodRestoreBeforeWrite = (root: any, label: string) => Promise<void>;

export interface FoodBackupPayload {
    foodCatalog: FoodCatalogItem[];
    foodOrders: FoodOrderRecord[];
}

export function isValidFoodCatalogBackupRecord(value: unknown): value is FoodCatalogItem {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Partial<FoodCatalogItem>;
    return record.schemaVersion === 1
        && typeof record.id === 'string' && !!record.id
        && typeof record.fingerprint === 'string' && !!record.fingerprint
        && typeof record.name === 'string' && !!record.name
        && ['imported_share', 'imported_screenshot', 'manual', 'simulated'].includes(String(record.source))
        && ['meituan', 'eleme', 'other', 'unknown'].includes(String(record.platform));
}

export function isValidFoodOrderBackupRecord(value: unknown): value is FoodOrderRecord {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Partial<FoodOrderRecord>;
    const timeline = record.timeline;
    const party = (candidate: FoodOrderRecord['orderer'] | undefined) => !!candidate
        && (candidate.type === 'user' || candidate.type === 'character')
        && typeof candidate.id === 'string' && !!candidate.id
        && typeof candidate.nameSnapshot === 'string';
    return record.schemaVersion === 1
        && typeof record.id === 'string' && !!record.id
        && typeof record.eventKey === 'string' && !!record.eventKey
        && typeof record.charId === 'string' && !!record.charId
        && (record.source === 'catalog_imported' || record.source === 'simulated')
        && party(record.orderer) && party(record.recipient)
        && Array.isArray(record.items) && record.items.length > 0
        && record.items.every(item => !!item && typeof item.name === 'string' && !!item.name && Number.isInteger(item.quantity) && item.quantity > 0)
        && !!timeline
        && [timeline.confirmedAt, timeline.preparingAt, timeline.pickedUpAt, timeline.deliveringAt, timeline.estimatedDeliveredAt]
            .every(value => typeof value === 'number' && Number.isFinite(value));
}

/** 导出时复制记录，再一次性解析 Catalog 与订单快照里的共享 blobref。 */
export async function prepareFoodBackupForExport(
    foodCatalog: FoodCatalogItem[],
    foodOrders: FoodOrderRecord[],
): Promise<FoodBackupPayload> {
    const payload: FoodBackupPayload = {
        foodCatalog: foodCatalog.map(item => ({ ...item })),
        foodOrders: foodOrders.map(order => ({
            ...order,
            orderer: { ...order.orderer },
            recipient: { ...order.recipient },
            timeline: { ...order.timeline },
            chat: order.chat ? { ...order.chat } : undefined,
            items: order.items.map(item => ({ ...item })),
        })),
    };
    const { resolveBlobRefsDeep } = await import('./blobRef');
    await resolveBlobRefsDeep(payload);
    return payload;
}

/**
 * Restore 只做数据规范化，不调 Chat/Vision/生图/Memory。
 * 所有恢复订单都抑制未来历史送达通知；过期订单直接持久化 delivered。
 */
export async function normalizeFoodBackupAfterRestore(
    catalogInput: unknown,
    orderInput: unknown,
    beforeWrite?: FoodRestoreBeforeWrite,
    now = Date.now(),
): Promise<FoodBackupPayload> {
    const root = {
        foodCatalog: Array.isArray(catalogInput) ? catalogInput : [],
        foodOrders: Array.isArray(orderInput) ? orderInput : [],
    };
    if (beforeWrite) {
        try { await beforeWrite(root, '外卖'); } catch { /* 缺失图片不阻断文字数据恢复 */ }
    }
    const blobCache = new Map<string, string>();
    const restoreImage = async (value: string | undefined): Promise<string | undefined> => {
        if (!value?.startsWith('data:image')) return value;
        const cached = blobCache.get(value);
        if (cached) return cached;
        try {
            const { dataUrlToBlob, putImageBlob } = await import('./blobRef');
            const token = await putImageBlob(dataUrlToBlob(value));
            blobCache.set(value, token);
            return token;
        } catch {
            return value;
        }
    };

    const foodCatalog: FoodCatalogItem[] = [];
    for (const raw of root.foodCatalog) {
        if (!isValidFoodCatalogBackupRecord(raw)) {
            console.warn('[Food][Restore] 跳过一条损坏的商品目录记录');
            continue;
        }
        foodCatalog.push({
            ...raw,
            originalUrl: normalizeFoodUrl(raw.originalUrl),
            imageRef: await restoreImage(raw.imageRef),
        });
    }

    const foodOrders: FoodOrderRecord[] = [];
    for (const raw of root.foodOrders) {
        if (!isValidFoodOrderBackupRecord(raw)) {
            console.warn('[Food][Restore] 跳过一条损坏的订单记录');
            continue;
        }
        const restored: FoodOrderRecord = {
            ...raw,
            orderer: { ...raw.orderer },
            recipient: { ...raw.recipient },
            timeline: { ...raw.timeline },
            items: await Promise.all(raw.items.map(async item => ({
                ...item,
                originalUrl: normalizeFoodUrl(item.originalUrl),
                imageRef: await restoreImage(item.imageRef),
            }))),
            chat: {
                ...(raw.chat || {}),
                deliveryEventSuppressed: raw.chat?.deliveryEventMessageId
                    ? raw.chat.deliveryEventSuppressed
                    : true,
            },
        };
        const status = deriveFoodOrderStatus(restored, now);
        if (status === 'delivered' && restored.status !== 'cancelled' && restored.status !== 'failed') {
            restored.status = 'delivered';
            restored.timeline.deliveredAt ??= restored.timeline.estimatedDeliveredAt;
        }
        foodOrders.push(restored);
    }
    return { foodCatalog, foodOrders };
}
