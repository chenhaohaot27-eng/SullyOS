import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DB, openDB } from './db';
import {
    claimFoodOrderReaction, createFoodOrder, getFoodOrder, getFoodOrderByEventKey,
    listFoodOrders, listFoodOrdersByChar, updateFoodOrder, type CreateFoodOrderInput,
} from './foodOrderStore';

beforeEach(async () => { await DB.deleteDB(); });
afterEach(() => vi.restoreAllMocks());

const make = (over: Partial<CreateFoodOrderInput> = {}): CreateFoodOrderInput => ({
    eventKey: 'food:user:c1:submit-1', source: 'catalog_imported',
    orderer: { type: 'user', id: 'user', nameSnapshot: '玩家' },
    recipient: { type: 'character', id: 'c1', nameSnapshot: '小星' }, charId: 'c1', merchantName: '星河食堂',
    items: [{ catalogItemId: 'item-1', name: '牛肉饭', merchantName: '星河食堂', quantity: 1, unitPrice: 28, note: '少辣', imageRef: 'blobref:food-1' }],
    subtotal: 28, deliveryFee: 5, total: 33, status: 'confirmed',
    timeline: { confirmedAt: 100, preparingAt: 200, pickedUpAt: 300, deliveringAt: 400, estimatedDeliveredAt: 500 },
    ...over,
});

describe('foodOrderStore', () => {
    it('DB v75 创建 store 和三个索引且不建 status index', async () => {
        const db = await openDB();
        expect(db.version).toBe(77);
        const store = db.transaction('food_orders', 'readonly').objectStore('food_orders');
        expect(store.index('eventKey').unique).toBe(true);
        expect(store.indexNames.contains('charId')).toBe(true);
        expect(store.indexNames.contains('createdAt')).toBe(true);
        expect(store.indexNames.contains('status')).toBe(false);
        expect(db.objectStoreNames.contains('food_cart')).toBe(false);
    });
    it('create/read', async () => {
        const result = await createFoodOrder(make());
        expect(result.created).toBe(true);
        expect(await getFoodOrder(result.record.id)).toEqual(result.record);
    });
    it('eventKey 顺序去重', async () => {
        const first = await createFoodOrder(make());
        const second = await createFoodOrder(make({ merchantName: '别家' }));
        expect(second.created).toBe(false); expect(second.record.id).toBe(first.record.id);
    });
    it('eventKey 并发去重', async () => {
        const results = await Promise.all([createFoodOrder(make()), createFoodOrder(make())]);
        expect(results.filter(r => r.created)).toHaveLength(1);
        expect(new Set(results.map(r => r.record.id)).size).toBe(1);
    });
    it('update 保持身份字段并更新状态', async () => {
        let time = 1000; vi.spyOn(Date, 'now').mockImplementation(() => ++time);
        const { record } = await createFoodOrder(make());
        const updated = await updateFoodOrder(record.id, { status: 'delivering', id: 'bad', eventKey: 'bad', createdAt: 0 } as any);
        expect(updated).toMatchObject({ id: record.id, eventKey: record.eventKey, createdAt: record.createdAt, status: 'delivering' });
    });
    it('list DESC 且 char filter', async () => {
        let time = 2000; vi.spyOn(Date, 'now').mockImplementation(() => ++time);
        await createFoodOrder(make({ eventKey: 'old' }));
        await createFoodOrder(make({ eventKey: 'new', charId: 'c2', recipient: { type: 'character', id: 'c2', nameSnapshot: '阿月' } }));
        expect((await listFoodOrders()).map(o => o.eventKey)).toEqual(['new', 'old']);
        expect(await listFoodOrdersByChar('c1')).toHaveLength(1);
    });
    it('订单 snapshot 在 Catalog 修改概念下保持原值', async () => {
        const input = make();
        const { record } = await createFoodOrder(input);
        input.items[0].name = '外部对象后改名'; input.items[0].unitPrice = 99;
        expect((await getFoodOrder(record.id))?.items[0]).toMatchObject({ name: '牛肉饭', unitPrice: 28, note: '少辣', imageRef: 'blobref:food-1' });
    });
    it('placed/delivered 自动回应各只能认领一次', async () => {
        const { record } = await createFoodOrder(make());
        expect(await claimFoodOrderReaction(record.id, 'ordered', 10)).toBe(true);
        expect(await claimFoodOrderReaction(record.id, 'ordered', 11)).toBe(false);
        expect(await claimFoodOrderReaction(record.id, 'delivered', 12)).toBe(true);
        expect(await claimFoodOrderReaction(record.id, 'delivered', 13)).toBe(false);
        expect((await getFoodOrderByEventKey(record.eventKey))?.chat).toMatchObject({ orderReactionAttemptedAt: 10, deliveryReactionAttemptedAt: 12 });
    });
});
