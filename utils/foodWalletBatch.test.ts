import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DB } from './db';
import { getAvailableBalance, initializeWallet, listLedgerEntries } from './playerWallet';
import { createPaidFoodOrdersBatch, refundFoodOrder } from './foodWallet';
import { listFoodOrders, type CreateFoodOrderInput } from './foodOrderStore';
import { batchReactionSummary } from './foodChatBridge';
import type { FoodOrderRecord } from './foodOrderTypes';

beforeEach(async () => { await DB.deleteDB(); });
afterEach(() => vi.restoreAllMocks());

const order = (merchantName: string, total: number, over: Partial<CreateFoodOrderInput> = {}): CreateFoodOrderInput => ({
    eventKey: `food:user:c1:sub-${merchantName}`, source: 'catalog_imported',
    orderer: { type: 'user', id: 'user', nameSnapshot: '玩家' },
    recipient: { type: 'character', id: 'c1', nameSnapshot: '小星' }, charId: 'c1', merchantName,
    items: [{ catalogItemId: 'i', name: '餐品', merchantName, quantity: 1, unitPrice: total - 5 }],
    subtotal: total - 5, deliveryFee: 5, total, status: 'confirmed',
    timeline: { confirmedAt: 100, preparingAt: 200, pickedUpAt: 300, deliveringAt: 400, estimatedDeliveredAt: 500 },
    ...over,
});

describe('foodWallet · 多商家批量结算（Hotfix Phase1）', () => {
    it('2 家店 → 2 份独立订单，同一 checkoutBatchId，各自独立 expense', async () => {
        await initializeWallet(100);
        const batch = await createPaidFoodOrdersBatch([order('店A', 30), order('店B', 45)]);
        expect(batch.createdCount).toBe(2);
        expect(batch.chargedTotal).toBe(75);
        expect(batch.results.map(r => r.record.merchantName).sort()).toEqual(['店A', '店B']);
        const batchIds = new Set(batch.results.map(r => r.record.checkoutBatchId));
        expect(batchIds.size).toBe(1);
        expect(await listFoodOrders()).toHaveLength(2);
        const expenses = (await listLedgerEntries()).filter(e => e.source === 'food' && e.direction === 'expense');
        expect(expenses).toHaveLength(2);
        expect(expenses.map(e => e.amount).sort((a, b) => a - b)).toEqual([30, 45]);
        expect(await getAvailableBalance()).toBe(25);
    });
    it('余额不足 → 整批拒绝，无订单无扣款（无半结算）', async () => {
        await initializeWallet(74.99);
        await expect(createPaidFoodOrdersBatch([order('店A', 30), order('店B', 45)]))
            .rejects.toMatchObject({ code: 'insufficient_balance' });
        expect(await listFoodOrders()).toHaveLength(0);
        expect(await listLedgerEntries()).toHaveLength(0);
        expect(await getAvailableBalance()).toBe(74.99);
    });
    it('任一订单价格未知 → 整批阻止', async () => {
        await initializeWallet(500);
        await expect(createPaidFoodOrdersBatch([order('店A', 30), order('店B', 45, { total: undefined })]))
            .rejects.toMatchObject({ code: 'unknown_price' });
        expect(await listFoodOrders()).toHaveLength(0);
        expect(await listLedgerEntries()).toHaveLength(0);
    });
    it('重复提交同一批 → 返回已有订单，不重复扣款/建单', async () => {
        await initializeWallet(100);
        const first = await createPaidFoodOrdersBatch([order('店A', 30), order('店B', 45)]);
        const second = await createPaidFoodOrdersBatch([order('店A', 30), order('店B', 45)]);
        expect(second.createdCount).toBe(0);
        expect(second.chargedTotal).toBe(0);
        expect(await listFoodOrders()).toHaveLength(2);
        expect(await getAvailableBalance()).toBe(25);
        expect(second.results[0].record.id).toBe(first.results[0].record.id);
    });
    it('并发双击 → 全部订单与扣款只有一份', async () => {
        await initializeWallet(100);
        const results = await Promise.all([
            createPaidFoodOrdersBatch([order('店A', 30), order('店B', 45)]),
            createPaidFoodOrdersBatch([order('店A', 30), order('店B', 45)]),
        ]);
        expect(results.filter(r => r.createdCount > 0)).toHaveLength(1);
        expect(await listFoodOrders()).toHaveLength(2);
        expect(await getAvailableBalance()).toBe(25);
    });
    it('单店取消 → 只退该店对应订单，另一店不受影响', async () => {
        await initializeWallet(100);
        const batch = await createPaidFoodOrdersBatch([order('店A', 30), order('店B', 45)]);
        const storeA = batch.results.find(r => r.record.merchantName === '店A')!.record;
        const refunded = await refundFoodOrder(storeA);
        expect(refunded.refunded).toBe(true);
        expect(await getAvailableBalance()).toBe(55); // 100 - 75 + 30
        const incomes = (await listLedgerEntries()).filter(e => e.direction === 'income');
        expect(incomes).toHaveLength(1);
        expect(incomes[0]).toMatchObject({ amount: 30, referenceId: storeA.id });
        const storeB = batch.results.find(r => r.record.merchantName === '店B')!.record;
        const expenseB = (await listLedgerEntries()).find(e => e.referenceId === storeB.id && e.direction === 'expense');
        expect(expenseB).toBeTruthy();
    });
});

describe('foodWallet · 批量 placed 回应摘要', () => {
    const mk = (merchant: string, total: number): FoodOrderRecord => ({
        schemaVersion: 1, id: `o-${merchant}`, eventKey: `ek-${merchant}`, source: 'catalog_imported',
        payer: 'user', checkoutBatchId: 'batch-1', currency: 'CNY' as const,
        orderer: { type: 'user', id: 'user', nameSnapshot: '玩家' },
        recipient: { type: 'character', id: 'c1', nameSnapshot: '小星' }, charId: 'c1',
        merchantName: merchant, items: [{ name: '粥', quantity: 1 }], subtotal: total - 5, deliveryFee: 5, total,
        status: 'confirmed',
        timeline: { confirmedAt: 1, preparingAt: 2, pickedUpAt: 3, deliveringAt: 4, estimatedDeliveredAt: 5 },
        createdAt: 1, updatedAt: 1,
    });
    it('多店摘要包含订单数与家数', () => {
        const summary = batchReactionSummary([mk('店A', 30), mk('店B', 45)], '玩家');
        expect(summary).toContain('2 份外卖订单');
        expect(summary).toContain('2 家店');
        expect(summary).toContain('店A');
        expect(summary).toContain('店B');
    });
});
