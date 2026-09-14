import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DB, openDB } from './db';
import {
    createFoodCatalogItem,
    getFoodCatalogItem,
    getFoodCatalogItemByFingerprint,
    listFoodCatalogItems,
    toggleFoodFavorite,
    updateFoodCatalogItem,
    type CreateFoodCatalogItemInput,
} from './foodCatalogStore';

beforeEach(async () => { await DB.deleteDB(); });
afterEach(() => { vi.restoreAllMocks(); });

const makeInput = (overrides: Partial<CreateFoodCatalogItemInput> = {}): CreateFoodCatalogItemInput => ({
    fingerprint: 'food:test:one',
    source: 'imported_share',
    platform: 'meituan',
    merchantName: '星河食堂',
    name: '番茄牛腩饭',
    price: 28.9,
    originalUrl: 'https://i.meituan.com/deal/1',
    ...overrides,
});

describe('foodCatalogStore — food_catalog 数据底座', () => {
    it('fresh DB 在 Phase 2 仍保留目录 store 及必要索引', async () => {
        const db = await openDB();
        expect(db.version).toBe(75);
        expect(db.objectStoreNames.contains('food_catalog')).toBe(true);
        expect(db.objectStoreNames.contains('food_orders')).toBe(true);
        const store = db.transaction('food_catalog', 'readonly').objectStore('food_catalog');
        expect(store.indexNames.contains('fingerprint')).toBe(true);
        expect(store.index('fingerprint').unique).toBe(true);
        expect(store.indexNames.contains('createdAt')).toBe(true);
        expect(store.indexNames.contains('favorite')).toBe(false);
    });

    it('create/read 保持字段', async () => {
        const created = await createFoodCatalogItem(makeInput());
        expect(created.created).toBe(true);
        expect(created.record.schemaVersion).toBe(1);
        expect(created.record.currency).toBe('CNY');
        expect(await getFoodCatalogItem(created.record.id)).toEqual(created.record);
    });

    it('fingerprint 顺序去重', async () => {
        const first = await createFoodCatalogItem(makeInput());
        const second = await createFoodCatalogItem(makeInput({ name: '第二个名字' }));
        expect(second.created).toBe(false);
        expect(second.record.id).toBe(first.record.id);
        expect(await listFoodCatalogItems()).toHaveLength(1);
    });

    it('fingerprint 并发去重', async () => {
        const results = await Promise.all([createFoodCatalogItem(makeInput()), createFoodCatalogItem(makeInput())]);
        expect(results.filter(result => result.created)).toHaveLength(1);
        expect(new Set(results.map(result => result.record.id)).size).toBe(1);
        expect(await listFoodCatalogItems()).toHaveLength(1);
    });

    it('不同 fingerprint 可分别创建', async () => {
        await createFoodCatalogItem(makeInput());
        await createFoodCatalogItem(makeInput({ fingerprint: 'food:test:two', name: '咖喱鸡饭' }));
        expect(await listFoodCatalogItems()).toHaveLength(2);
        expect(await getFoodCatalogItemByFingerprint('food:test:two')).not.toBeNull();
    });

    it('update 可编辑业务字段但身份字段不可变', async () => {
        let now = 1000;
        vi.spyOn(Date, 'now').mockImplementation(() => (now += 10));
        const { record } = await createFoodCatalogItem(makeInput());
        const updated = await updateFoodCatalogItem(record.id, {
            name: '新商品名', description: '新描述', price: 30,
            id: 'hacked', fingerprint: 'hacked', createdAt: 0,
        } as Parameters<typeof updateFoodCatalogItem>[1]);
        expect(updated).toMatchObject({ id: record.id, fingerprint: record.fingerprint, createdAt: record.createdAt, name: '新商品名', price: 30 });
        expect(updated!.updatedAt).toBeGreaterThan(record.updatedAt);
        expect(await updateFoodCatalogItem('missing', { name: 'x' })).toBeNull();
    });

    it('favorite 本地切换', async () => {
        const { record } = await createFoodCatalogItem(makeInput());
        expect((await toggleFoodFavorite(record.id))?.favorite).toBe(true);
        expect((await toggleFoodFavorite(record.id))?.favorite).toBe(false);
    });

    it('列表按 createdAt DESC', async () => {
        let now = 2000;
        vi.spyOn(Date, 'now').mockImplementation(() => (now += 10));
        await createFoodCatalogItem(makeInput({ fingerprint: 'old' }));
        await createFoodCatalogItem(makeInput({ fingerprint: 'new', name: '新商品' }));
        expect((await listFoodCatalogItems()).map(item => item.fingerprint)).toEqual(['new', 'old']);
    });

    it('blobref 作为不透明字符串原样持久化', async () => {
        const { record } = await createFoodCatalogItem(makeInput({ imageRef: 'blobref:food-image' }));
        expect((await getFoodCatalogItem(record.id))?.imageRef).toBe('blobref:food-image');
    });
});
