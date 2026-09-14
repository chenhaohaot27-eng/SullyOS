import { describe, expect, it } from 'vitest';
import {
    addFoodCartItem, calculateFoodCartTotals, clearFoodCartAfterOrder,
    removeFoodCartItem, setFoodCartNote, setFoodCartQuantity, snapshotFoodCart,
} from './foodCart';
import type { FoodCatalogItem } from './foodTypes';

const item = (id: string, merchantName?: string, price?: number): FoodCatalogItem => ({
    schemaVersion: 1, id, fingerprint: `fp-${id}`, source: 'imported_share', platform: 'meituan',
    merchantName, name: `商品${id}`, price, currency: 'CNY', imageRef: `blobref:${id}`,
    createdAt: 1, updatedAt: 1,
});

describe('foodCart — 纯 UI 状态 helper', () => {
    it('add 新增并对同商品累加', () => {
        const first = addFoodCartItem([], item('a', '店A', 10)).cart;
        expect(addFoodCartItem(first, item('a', '店A', 10)).cart[0].quantity).toBe(2);
    });
    it('quantity +/- 与归零删除', () => {
        const cart = addFoodCartItem([], item('a')).cart;
        expect(setFoodCartQuantity(cart, 'a', 3)[0].quantity).toBe(3);
        expect(setFoodCartQuantity(cart, 'a', 0)).toEqual([]);
    });
    it('remove', () => expect(removeFoodCartItem(addFoodCartItem([], item('a')).cart, 'a')).toEqual([]));
    it('商品级备注', () => expect(setFoodCartNote(addFoodCartItem([], item('a')).cart, 'a', ' 不要香菜 ')[0].note).toBe('不要香菜'));
    it('全部已知价格计算 subtotal、固定配送费与 total', () => {
        const cart = [{ item: item('a', '店A', 10.5), quantity: 2 }, { item: item('b', '店A', 4), quantity: 1 }];
        expect(calculateFoodCartTotals(cart)).toEqual({ itemCount: 3, knownSubtotal: 25, deliveryFee: 5, total: 30, hasUnknownPrices: false });
    });
    it('未知价格仍保留已知小计但不伪造 total', () => {
        const cart = [{ item: item('a', '店A', 10), quantity: 1 }, { item: item('b', '店A'), quantity: 2 }];
        expect(calculateFoodCartTotals(cart)).toEqual({ itemCount: 3, knownSubtotal: 10, deliveryFee: 5, hasUnknownPrices: true });
    });
    it('跨商家拒绝加入；两个未知商家允许同车', () => {
        const a = addFoodCartItem([], item('a', '店A')).cart;
        expect(addFoodCartItem(a, item('b', '店B')).merchantConflict).toBe(true);
        const unknown = addFoodCartItem([], item('x')).cart;
        expect(addInput(unknown, item('y')).merchantConflict).toBe(false);
    });
    it('订单 snapshot 与 Catalog 脱钩且复用 blobref', () => {
        const source = item('a', '店A', 12);
        const snap = snapshotFoodCart([{ item: source, quantity: 2, note: '少辣' }]);
        source.name = '后来修改'; source.price = 99;
        expect(snap[0]).toMatchObject({ name: '商品a', unitPrice: 12, quantity: 2, note: '少辣', imageRef: 'blobref:a' });
    });
    it('订单创建成功清空购物车，失败保留', () => {
        const cart = addFoodCartItem([], item('a')).cart;
        expect(clearFoodCartAfterOrder(cart, true)).toEqual([]);
        expect(clearFoodCartAfterOrder(cart, false)).toBe(cart);
    });
});

function addInput(cart: ReturnType<typeof addFoodCartItem>['cart'], next: FoodCatalogItem) {
    return addFoodCartItem(cart, next);
}
