import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CharacterProfile } from '../types';
import { dataUrlToBlob, getBlobForRef, putImageBlob } from './blobRef';
import { DB, openDB } from './db';
import { createFoodCatalogItem, listFoodCatalogItems } from './foodCatalogStore';
import { handleFoodOrderDelivery } from './foodChatBridge';
import { createFoodOrder, listFoodOrders } from './foodOrderStore';
import type { FoodOrderRecord } from './foodOrderTypes';
import { normalizeFoodBackupAfterRestore } from './foodBackup';

const completeChatMock = vi.hoisted(() => vi.fn());
const visionMock = vi.hoisted(() => vi.fn());
const imageMock = vi.hoisted(() => vi.fn());
const memoryMock = vi.hoisted(() => vi.fn());
vi.mock('./chatCompletionClient', () => ({ completeChat: completeChatMock }));
vi.mock('./visionApi', () => ({ describeImageWithVisionApi: visionMock }));
vi.mock('./imageGenerationService', () => ({ generateImage: imageMock }));
vi.mock('./memoryPalace/curatedIngestion', () => ({ submitCuratedMemoryCandidate: memoryMock }));

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const timeline = (overdue = false) => {
    const base = overdue ? 100 : Date.now() + 100_000;
    return { confirmedAt: base, preparingAt: base + 10, pickedUpAt: base + 20, deliveringAt: base + 30, estimatedDeliveredAt: base + 40 };
};

async function seedCatalog(over: Record<string, unknown> = {}) {
    return (await createFoodCatalogItem({
        source: 'imported_screenshot', platform: 'meituan', merchantName: '星河食堂',
        name: '鲜虾粥', price: 29, description: '热粥', originalUrl: 'https://example.com/food',
        rawShareText: '原始分享', visualSummary: '一碗粥', favorite: true, ...over,
    } as any)).record;
}

async function seedOrder(over: Record<string, unknown> = {}): Promise<FoodOrderRecord> {
    return (await createFoodOrder({
        eventKey: `food:test:${Math.random()}`, source: 'catalog_imported', charId: 'c1', merchantName: '星河食堂',
        orderer: { type: 'character', id: 'c1', nameSnapshot: '祁煜' },
        recipient: { type: 'user', id: 'user', nameSnapshot: '玩家' },
        items: [{ name: '鲜虾粥', quantity: 1, unitPrice: 29 }], subtotal: 29, deliveryFee: 5, total: 34,
        status: 'confirmed', timeline: timeline(), chat: { orderCardMessageId: '10', deliveryEventMessageId: '11' },
        ...over,
    } as any)).record;
}

beforeEach(async () => {
    await DB.deleteDB();
    completeChatMock.mockClear(); visionMock.mockClear(); imageMock.mockClear(); memoryMock.mockClear();
});

describe('Food full backup / restore', () => {
    it('纯文字 Catalog 完整 roundtrip', async () => {
        const item = await seedCatalog();
        const backup = await DB.exportFullData();
        await DB.deleteDB(); await openDB(); await DB.importFullData(backup as any);
        const restored = (await listFoodCatalogItems())[0];
        expect(restored).toEqual(item);
    });
    it('Catalog 截图与订单快照共享图片 roundtrip 且只恢复一个 Blob', async () => {
        const imageRef = await putImageBlob(dataUrlToBlob(TINY_PNG));
        const item = await seedCatalog({ imageRef });
        await seedOrder({ items: [{ catalogItemId: item.id, name: item.name, quantity: 1, unitPrice: 29, imageRef }] });
        const backup = await DB.exportFullData();
        expect(backup.foodCatalog?.[0].imageRef).toBe(TINY_PNG);
        expect(backup.foodOrders?.[0].items[0].imageRef).toBe(TINY_PNG);
        await DB.deleteDB(); await openDB(); await DB.importFullData(backup as any);
        const catalogRef = (await listFoodCatalogItems())[0].imageRef!;
        const orderRef = (await listFoodOrders())[0].items[0].imageRef!;
        expect(catalogRef).toMatch(/^blobref:/); expect(orderRef).toBe(catalogRef);
        expect(await getBlobForRef(catalogRef)).not.toBeNull();
        const db = await openDB();
        const count = await new Promise<number>((resolve, reject) => {
            const req = db.transaction('blob_assets', 'readonly').objectStore('blob_assets').count();
            req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
        });
        expect(count).toBe(1);
    });
    it('imported order 完整 roundtrip', async () => {
        const order = await seedOrder();
        const backup = await DB.exportFullData();
        await DB.deleteDB(); await openDB(); await DB.importFullData(backup as any);
        expect((await listFoodOrders())[0]).toMatchObject({ id: order.id, source: 'catalog_imported', total: 34 });
    });
    it('simulated order roundtrip 并保留来源', async () => {
        await seedOrder({ source: 'simulated', merchantName: '夜雨粥铺', items: [{ name: '模拟鲜虾粥', quantity: 1, unitPrice: 25 }] });
        const backup = await DB.exportFullData();
        await DB.deleteDB(); await openDB(); await DB.importFullData(backup as any);
        expect((await listFoodOrders())[0]).toMatchObject({ source: 'simulated', merchantName: '夜雨粥铺' });
    });
    it('eventKey、timeline 与 chat links 原样保留', async () => {
        const order = await seedOrder({ eventKey: 'food:assistant:77:order:0' });
        const backup = await DB.exportFullData();
        await DB.deleteDB(); await openDB(); await DB.importFullData(backup as any);
        const restored = (await listFoodOrders())[0];
        expect(restored.eventKey).toBe(order.eventKey); expect(restored.timeline).toEqual(order.timeline);
        expect(restored.chat?.orderCardMessageId).toBe('10'); expect(restored.chat?.deliveryEventMessageId).toBe('11');
    });
    it('legacy 无 Food 字段正常恢复为空', async () => {
        await openDB();
        await DB.importFullData({ timestamp: Date.now(), version: 3 } as any);
        expect(await listFoodCatalogItems()).toEqual([]); expect(await listFoodOrders()).toEqual([]);
    });
    it('恢复不触发 Chat、Vision、生图或 Memory', async () => {
        await seedCatalog(); await seedOrder();
        const backup = await DB.exportFullData();
        await DB.deleteDB(); await openDB(); await DB.importFullData(backup as any);
        expect(completeChatMock).not.toHaveBeenCalled(); expect(visionMock).not.toHaveBeenCalled();
        expect(imageMock).not.toHaveBeenCalled(); expect(memoryMock).not.toHaveBeenCalled();
    });
    it('过期恢复订单直接 delivered，并抑制历史 delivery event/API', async () => {
        await seedOrder({ timeline: timeline(true), chat: { orderCardMessageId: '10' } });
        const backup = await DB.exportFullData();
        await DB.deleteDB(); await openDB(); await DB.importFullData(backup as any);
        const restored = (await listFoodOrders())[0];
        expect(restored.status).toBe('delivered'); expect(restored.timeline.deliveredAt).toBe(restored.timeline.estimatedDeliveredAt);
        expect(restored.chat?.deliveryEventSuppressed).toBe(true);
        const deps = { char: { id: 'c1', name: '祁煜' } as CharacterProfile, userProfile: { name: '玩家' } as any, groups: [], apiConfig: {} as any };
        const result = await handleFoodOrderDelivery(restored.id, deps, Date.now());
        expect(result.eventCreated).toBe(false); expect(result.reactionTriggered).toBe(false);
        expect(completeChatMock).not.toHaveBeenCalled();
    });
    it('尚未过期恢复订单保留 timeline，但同样抑制未来历史通知', async () => {
        const order = await seedOrder({ chat: { orderCardMessageId: '10' } });
        const backup = await DB.exportFullData();
        await DB.deleteDB(); await openDB(); await DB.importFullData(backup as any);
        const restored = (await listFoodOrders())[0];
        expect(restored.status).toBe('confirmed'); expect(restored.timeline).toEqual(order.timeline);
        expect(restored.chat?.deliveryEventSuppressed).toBe(true);
    });
    it('恢复时再次过滤非 http(s) originalUrl', async () => {
        const payload = await normalizeFoodBackupAfterRestore([
            { schemaVersion: 1, id: 'f', fingerprint: 'fp', source: 'manual', platform: 'unknown', name: '粥', currency: 'CNY', originalUrl: 'javascript:alert(1)', createdAt: 1, updatedAt: 1 },
        ], [{ schemaVersion: 1, id: 'o', eventKey: 'e', source: 'simulated', charId: 'c1', orderer: { type: 'character', id: 'c1', nameSnapshot: '祁煜' }, recipient: { type: 'user', id: 'user', nameSnapshot: '玩家' }, items: [{ name: '粥', quantity: 1, originalUrl: 'file:///secret' }], currency: 'CNY', status: 'confirmed', timeline: timeline(), createdAt: 1, updatedAt: 1 }]);
        expect(payload.foodCatalog[0].originalUrl).toBeUndefined();
        expect(payload.foodOrders[0].items[0].originalUrl).toBeUndefined();
    });
    it('损坏单条跳过，DB_VERSION 保持 75', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const payload = await normalizeFoodBackupAfterRestore([{ id: 'bad' }], [{ id: 'bad' }]);
        expect(payload.foodCatalog).toEqual([]); expect(payload.foodOrders).toEqual([]);
        expect((await openDB()).version).toBe(78); expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });
});
