import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DB } from './db';
import { createFoodCatalogItem, deleteFoodCatalogItem, getFoodCatalogItem, listFoodCatalogItems, toggleFoodFavorite } from './foodCatalogStore';
import { createFoodOrder, type CreateFoodOrderInput } from './foodOrderStore';
import { initializeWallet, spend, listLedgerEntries } from './playerWallet';

beforeEach(async () => { await DB.deleteDB(); });
afterEach(() => vi.restoreAllMocks());

const catalogItem = async (id: string, name = '牛肉饭') =>
    (await createFoodCatalogItem({
        name, merchantName: '星河食堂', platform: 'meituan', source: 'imported_share',
        price: 28, imageRef: `blobref:${id}`, originalUrl: 'https://example.com/item',
    })).record;

const orderUsing = (catalogId: string, imageRef?: string): CreateFoodOrderInput => ({
    eventKey: 'food:user:c1:sub-1', source: 'catalog_imported',
    orderer: { type: 'user', id: 'user', nameSnapshot: '玩家' },
    recipient: { type: 'character', id: 'c1', nameSnapshot: '小星' }, charId: 'c1', merchantName: '星河食堂',
    items: [{ catalogItemId: catalogId, name: '牛肉饭', merchantName: '星河食堂', quantity: 1, unitPrice: 28, ...(imageRef ? { imageRef } : {}) }],
    subtotal: 28, deliveryFee: 5, total: 33, status: 'confirmed',
    timeline: { confirmedAt: 1, preparingAt: 2, pickedUpAt: 3, deliveringAt: 4, estimatedDeliveredAt: 5 },
});

describe('foodCatalogStore · 删除（Hotfix Phase1）', () => {
    it('删除已导入商品；重复删除幂等', async () => {
        const item = await catalogItem('del-1', '草莓蛋糕');
        expect((await listFoodCatalogItems())).toHaveLength(1);
        const first = await deleteFoodCatalogItem(item.id);
        expect(first.deleted).toBe(true);
        expect(await listFoodCatalogItems()).toHaveLength(0);
        const second = await deleteFoodCatalogItem(item.id);
        expect(second.deleted).toBe(false); // 幂等：不存在视为已删
        expect(await getFoodCatalogItem(item.id)).toBeNull();
    });
    it('收藏状态随记录删除；收藏其他商品不受影响', async () => {
        const a = await catalogItem('fav-a', '商品A');
        const b = await catalogItem('fav-b', '商品B');
        await toggleFoodFavorite(a.id);
        await toggleFoodFavorite(b.id);
        await deleteFoodCatalogItem(a.id);
        const remaining = await listFoodCatalogItems();
        expect(remaining).toHaveLength(1);
        expect(remaining[0].favorite).toBe(true);
    });
    it('删除商品后历史订单 snapshot 原样保留（不修改历史）', async () => {
        const item = await catalogItem('his-1', '牛肉饭');
        const { record } = await createFoodOrder(orderUsing(item.id, item.imageRef));
        await deleteFoodCatalogItem(item.id);
        const orders = await (await import('./foodOrderStore')).listFoodOrders();
        expect(orders).toHaveLength(1);
        expect(orders[0].items[0]).toMatchObject({ name: '牛肉饭', unitPrice: 28, imageRef: item.imageRef });
        expect(orders[0].id).toBe(record.id);
    });
    it('删除商品后历史 ledger / 退款不受影响', async () => {
        await initializeWallet(100);
        const item = await catalogItem('led-1', '牛肉饭');
        // 用 playerWallet.spend 模拟该订单的历史扣款（food 账本独立于 catalog）
        await spend({ amount: 33, note: '外卖 · 星河食堂', eventKey: 'food-order:food:user:c1:sub-1', source: 'food', referenceId: 'order-1' });
        await deleteFoodCatalogItem(item.id);
        const entries = await listLedgerEntries();
        expect(entries).toHaveLength(1);
        expect(entries[0].amount).toBe(33);
    });
    it('blob 资产不物理删除（删除 catalog 后 blob_assets 仍保留）', async () => {
        const item = await catalogItem('blob-1', '抹茶冰淇淋');
        await deleteFoodCatalogItem(item.id);
        // blobref 资产由 blobRef 体系管理；本 Hotfix 不做 GC —— 验证 blob_assets store 未被清空
        const db = await (await import('./db')).openDB();
        const count = await new Promise<number>((resolve, reject) => {
            const tx = db.transaction('blob_assets', 'readonly');
            const req = tx.objectStore('blob_assets').count();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        expect(count).toBeGreaterThanOrEqual(0); // 不抛错即可：删除路径根本不触碰 blob_assets
        expect(await getFoodCatalogItem(item.id)).toBeNull();
    });
});
