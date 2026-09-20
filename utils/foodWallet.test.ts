import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DB } from './db';
import { createFoodOrder, getFoodOrderByEventKey, listFoodOrders, type CreateFoodOrderInput } from './foodOrderStore';
import { getAvailableBalance, initializeWallet, listLedgerEntries } from './playerWallet';
import {
    createPaidFoodOrder, isRefundableCancelStatus, orderPayer, refundFoodOrder,
} from './foodWallet';
import type { FoodOrderRecord } from './foodOrderTypes';

beforeEach(async () => { await DB.deleteDB(); });
afterEach(() => vi.restoreAllMocks());

const make = (over: Partial<CreateFoodOrderInput> = {}): CreateFoodOrderInput => ({
    eventKey: 'food:user:c1:submit-1', source: 'catalog_imported',
    orderer: { type: 'user', id: 'user', nameSnapshot: '玩家' },
    recipient: { type: 'character', id: 'c1', nameSnapshot: '小星' }, charId: 'c1', merchantName: '星河食堂',
    items: [{ catalogItemId: 'item-1', name: '牛肉饭', merchantName: '星河食堂', quantity: 1, unitPrice: 28 }],
    subtotal: 28, deliveryFee: 5, total: 33, status: 'confirmed',
    timeline: { confirmedAt: 100, preparingAt: 200, pickedUpAt: 300, deliveringAt: 400, estimatedDeliveredAt: 500 },
    ...over,
});

describe('foodWallet · 玩家付款原子下单', () => {
    it('钱包未启用 → 拒绝，订单与流水都不存在', async () => {
        await expect(createPaidFoodOrder(make())).rejects.toMatchObject({ code: 'not_initialized' });
        expect(await listFoodOrders()).toHaveLength(0);
        expect(await listLedgerEntries()).toHaveLength(0);
    });
    it('价格未知 → 拒绝（不猜价、不 0 元下单）', async () => {
        await initializeWallet(500);
        await expect(createPaidFoodOrder(make({ total: undefined }))).rejects.toMatchObject({ code: 'unknown_price' });
        expect(await listFoodOrders()).toHaveLength(0);
        expect(await listLedgerEntries()).toHaveLength(0);
    });
    it('余额不足 → 拒绝，订单与流水都不存在', async () => {
        await initializeWallet(32.99);
        await expect(createPaidFoodOrder(make())).rejects.toMatchObject({ code: 'insufficient_balance' });
        expect(await listFoodOrders()).toHaveLength(0);
        expect(await listLedgerEntries()).toHaveLength(0);
        expect(await getAvailableBalance()).toBe(32.99);
    });
    it('余额充足 → 订单 + 扣款流水同生，余额减少，payer=user', async () => {
        await initializeWallet(100);
        const result = await createPaidFoodOrder(make());
        expect(result.created).toBe(true);
        expect(result.ledgerCreated).toBe(true);
        expect(result.record.payer).toBe('user');
        expect(await listFoodOrders()).toHaveLength(1);
        const entries = await listLedgerEntries();
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ direction: 'expense', source: 'food', amount: 33, referenceId: result.record.id, eventKey: 'food-order:food:user:c1:submit-1' });
        expect(await getAvailableBalance()).toBe(67);
    });
    it('重复提交同一订单 → 返回已有订单，不重复扣款', async () => {
        await initializeWallet(100);
        const first = await createPaidFoodOrder(make());
        const second = await createPaidFoodOrder(make());
        expect(second.created).toBe(false);
        expect(second.record.id).toBe(first.record.id);
        expect(await listLedgerEntries()).toHaveLength(1);
        expect(await getAvailableBalance()).toBe(67);
    });
    it('并发双击 → 订单与扣款都只有一份', async () => {
        await initializeWallet(100);
        const results = await Promise.all([createPaidFoodOrder(make()), createPaidFoodOrder(make())]);
        expect(results.filter(r => r.created)).toHaveLength(1);
        expect(await listFoodOrders()).toHaveLength(1);
        expect(await listLedgerEntries()).toHaveLength(1);
        expect(await getAvailableBalance()).toBe(67);
    });
});

describe('foodWallet · 角色付款', () => {
    it('角色订单（createFoodOrder payer=character）不触碰钱包', async () => {
        await initializeWallet(100);
        const result = await createFoodOrder(make({
            eventKey: 'food:assistant:m1:order:0',
            payer: 'character',
            orderer: { type: 'character', id: 'c1', nameSnapshot: '小星' },
            recipient: { type: 'user', id: 'user', nameSnapshot: '玩家' },
        }));
        expect(result.record.payer).toBe('character');
        expect(await listLedgerEntries()).toHaveLength(0);
        expect(await getAvailableBalance()).toBe(100);
    });
    it('orderPayer 对旧记录按 orderer.type 推断', () => {
        expect(orderPayer({ orderer: { type: 'user', id: 'user', nameSnapshot: '' } } as FoodOrderRecord)).toBe('user');
        expect(orderPayer({ orderer: { type: 'character', id: 'c1', nameSnapshot: '' } } as FoodOrderRecord)).toBe('character');
    });
});

describe('foodWallet · 取消退款', () => {
    it('confirmed / preparing 可退；picked_up / delivering / delivered 不可退', () => {
        expect(isRefundableCancelStatus('confirmed')).toBe(true);
        expect(isRefundableCancelStatus('preparing')).toBe(true);
        expect(isRefundableCancelStatus('picked_up')).toBe(false);
        expect(isRefundableCancelStatus('delivering')).toBe(false);
        expect(isRefundableCancelStatus('delivered')).toBe(false);
    });
    it('confirmed 取消 → 全额退款一次，重复退款无效', async () => {
        await initializeWallet(100);
        const { record } = await createPaidFoodOrder(make());
        expect(await getAvailableBalance()).toBe(67);
        const first = await refundFoodOrder(record);
        expect(first.refunded).toBe(true);
        expect(await getAvailableBalance()).toBe(100);
        await refundFoodOrder(record); // 重复取消/重放
        await refundFoodOrder(record);
        const income = (await listLedgerEntries()).filter(e => e.direction === 'income');
        expect(income).toHaveLength(1);
        expect(income[0]).toMatchObject({ source: 'food', amount: 33, eventKey: `food-refund:${record.id}` });
        expect(await getAvailableBalance()).toBe(100);
    });
    it('角色付款订单取消 → 不退款', async () => {
        await initializeWallet(100);
        const { record } = await createFoodOrder(make({
            eventKey: 'food:assistant:m2:order:0', payer: 'character',
            orderer: { type: 'character', id: 'c1', nameSnapshot: '小星' },
            recipient: { type: 'user', id: 'user', nameSnapshot: '玩家' },
        }));
        const result = await refundFoodOrder(record);
        expect(result.refunded).toBe(false);
        expect((await listLedgerEntries()).filter(e => e.direction === 'income')).toHaveLength(0);
    });
    it('只读路径不产生扣款/退款副作用', async () => {
        await initializeWallet(100);
        const { record } = await createPaidFoodOrder(make());
        await listFoodOrders();
        await getFoodOrderByEventKey(record.eventKey);
        await getAvailableBalance();
        const entries = await listLedgerEntries();
        expect(entries).toHaveLength(1);
        expect(entries[0].direction).toBe('expense');
    });
});

