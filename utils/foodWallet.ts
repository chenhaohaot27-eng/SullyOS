/**
 * Food × 玩家钱包桥（Player Economy Phase 1）
 * ═════════════════════════════════════════════════════════════════
 * 玩家付款订单的"扣款 + 创建 FoodOrderRecord"在同一个 IndexedDB readwrite
 * 事务（money_ledger + player_wallet + food_orders）内完成：
 *
 *   1. 校验订单字段（复用 foodOrderStore.buildFoodOrderRecord，payer='user'）
 *   2. 校验最终总价已知且 > 0（价格不明 → unknown_price，禁止 0 元/猜价下单）
 *   3. 事务内 eventKey 查重（订单 eventKey + 流水 eventKey 双查）
 *   4. 事务内派生余额校验（不足 → insufficient_balance，整体 abort，两边都不留半成品）
 *   5. 写 expense ledger entry（eventKey=`food-order:<订单eventKey>`，referenceId=orderId）
 *   6. 写 FoodOrderRecord
 *
 * 角色付款订单不走本文件（foodCharacterOrder 直接 createFoodOrder，payer='character'，
 * 不检查也不扣玩家余额）。取消退款见 refundFoodOrder：不改旧流水，追加 income entry
 * （eventKey=`food-refund:<orderId>`），幂等由唯一索引保证。
 */

import { openDB } from './db';
import type { FoodOrderRecord, FoodOrderStatus } from './foodOrderTypes';
import { buildFoodOrderRecord, type CreateFoodOrderInput } from './foodOrderStore';
import type { MoneyLedgerEntry } from '../types';

export type FoodWalletErrorCode = 'not_initialized' | 'unknown_price' | 'insufficient_balance';

export class FoodWalletError extends Error {
    code: FoodWalletErrorCode;
    constructor(code: FoodWalletErrorCode, message: string) {
        super(message);
        this.name = 'FoodWalletError';
        this.code = code;
    }
}

/** 付款方真相源：新记录显式 payer；旧记录按 orderer.type 推断。 */
export function orderPayer(order: Pick<FoodOrderRecord, 'payer' | 'orderer'>): 'user' | 'character' {
    return order.payer ?? (order.orderer.type === 'user' ? 'user' : 'character');
}

/** 只有 confirmed / preparing 阶段取消才退款；picked_up 之后骑手都取餐了，不退。 */
export function isRefundableCancelStatus(status: FoodOrderStatus): boolean {
    return status === 'confirmed' || status === 'preparing';
}

export interface PaidFoodOrderResult {
    record: FoodOrderRecord;
    created: boolean;
    ledgerEntry: MoneyLedgerEntry | null;
    ledgerCreated: boolean;
}

function buildFoodExpense(order: FoodOrderRecord, total: number): MoneyLedgerEntry {
    const now = Date.now();
    return {
        id: `ledger_food_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        eventKey: `food-order:${order.eventKey}`,
        direction: 'expense',
        amount: total,
        category: 'food',
        source: 'food',
        referenceId: order.id,
        note: `外卖 · ${order.merchantName || '订单'} → ${order.recipient.nameSnapshot}`,
        createdAt: now,
        metadata: {
            orderEventKey: order.eventKey,
            merchant: order.merchantName,
            recipient: order.recipient.nameSnapshot,
            orderer: order.orderer.nameSnapshot,
            itemCount: order.items.reduce((sum, item) => sum + item.quantity, 0),
        },
    };
}

/**
 * 玩家付款的原子下单。任何失败（余额不足/钱包未启用/价格未知）两边都不留半成品。
 * eventKey 幂等：重复提交返回已有订单，不重复扣款。
 */
export async function createPaidFoodOrder(input: CreateFoodOrderInput): Promise<PaidFoodOrderResult> {
    if (input.total === undefined || !Number.isFinite(input.total) || input.total <= 0) {
        throw new FoodWalletError('unknown_price', '订单总价未知或无效，请补全商品价格后再下单');
    }
    const total = Math.round(input.total * 100) / 100;
    const record = buildFoodOrderRecord({ ...input, payer: 'user' });
    const ledgerEventKey = `food-order:${record.eventKey}`;
    const db = await openDB();
    return new Promise<PaidFoodOrderResult>((resolve, reject) => {
        const tx = db.transaction(['money_ledger', 'player_wallet', 'food_orders'], 'readwrite');
        const ledgerStore = tx.objectStore('money_ledger');
        const walletReq = tx.objectStore('player_wallet').get('default');
        const entriesReq = ledgerStore.getAll();
        const orderReq = tx.objectStore('food_orders').index('eventKey').get(record.eventKey);
        let outcome: PaidFoodOrderResult | null = null;
        let failure: FoodWalletError | null = null;
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            if (failure) reject(failure);
            else if (outcome) resolve(outcome);
            else reject(tx.error || new Error('paid food order transaction ended without result'));
        };
        const failWith = (code: FoodWalletErrorCode, message: string) => {
            if (done || failure) return; // 保留首个失败原因（abort 引发的次级 AbortError 不覆盖）
            failure = new FoodWalletError(code, message);
            try { tx.abort(); } catch { /* noop */ }
            finish();
        };
        walletReq.onerror = () => failWith('not_initialized', `读取钱包配置失败: ${walletReq.error?.name ?? ''} ${walletReq.error?.message ?? ''}`);
        entriesReq.onerror = () => failWith('not_initialized', `读取钱包流水失败: ${entriesReq.error?.name ?? ''} ${entriesReq.error?.message ?? ''}`);
        orderReq.onerror = () => failWith('not_initialized', `读取已有订单失败: ${orderReq.error?.name ?? ''} ${orderReq.error?.message ?? ''}`);
        // 决策放在最后完成的请求回调里：此时 walletReq / entriesReq 的 result 均已就绪
        // （在较早的回调里读未完成请求的 .result 会抛 InvalidStateError 并炸掉整个事务）。
        orderReq.onsuccess = () => {
            if (failure || done) return;
            const wallet = walletReq.result as { openingBalance: number } | undefined;
            const entries = (entriesReq.result as MoneyLedgerEntry[]) || [];
            const existingOrder = (orderReq.result as FoodOrderRecord | undefined) || null;
            try {
                if (!wallet) throw new FoodWalletError('not_initialized', '钱包尚未启用，请先在记账 App 开启玩家钱包');
                let balance = Math.round(wallet.openingBalance * 100) / 100;
                for (const entry of entries) balance += entry.direction === 'income' ? entry.amount : -entry.amount;
                balance = Math.round(balance * 100) / 100;
                const existingLedger = entries.find(entry => entry.eventKey === ledgerEventKey) || null;

                if (existingOrder) {
                    // 重复提交：返回已有订单，绝不重复扣款；流水缺失时尽力补账（余额允许才补）。
                    let ledger = existingLedger;
                    let ledgerCreated = false;
                    if (!ledger && balance >= total) {
                        ledger = buildFoodExpense(existingOrder, total);
                        ledgerStore.put(ledger);
                        ledgerCreated = true;
                    }
                    outcome = { record: existingOrder, created: false, ledgerEntry: ledger, ledgerCreated };
                    return;
                }
                if (existingLedger) {
                    // 极端场景：流水在但订单不在（理论不可达，同事务写入）。不二次扣款，仅补订单。
                    tx.objectStore('food_orders').add(record);
                    outcome = { record, created: true, ledgerEntry: existingLedger, ledgerCreated: false };
                    return;
                }
                if (balance < total) {
                    throw new FoodWalletError('insufficient_balance', `余额不足：当前 ¥${balance}，本单需 ¥${total}`);
                }
                const ledgerEntry = buildFoodExpense(record, total);
                ledgerStore.put(ledgerEntry);
                tx.objectStore('food_orders').add(record);
                outcome = { record, created: true, ledgerEntry, ledgerCreated: true };
            } catch (error) {
                failure = error instanceof FoodWalletError ? error : new FoodWalletError('unknown_price', String(error));
                try { tx.abort(); } catch { /* noop */ }
                finish();
            }
        };
        tx.oncomplete = finish;
        tx.onerror = () => { if (!failure) failure = new FoodWalletError('not_initialized', String(tx.error)); finish(); };
        tx.onabort = finish;
    });
}

export interface PaidFoodOrdersBatchResult {
    /** 与输入 orders 一一对应。 */
    results: Array<PaidFoodOrderResult>;
    batchId: string;
    /** 本批实际新建的订单数。 */
    createdCount: number;
    /** 本批实际扣款总额（新建订单之和；重复提交为 0）。 */
    chargedTotal: number;
}

/**
 * 多商家批量结算（Hotfix Phase1）：一个 IndexedDB readwrite 事务
 * （money_ledger + player_wallet + food_orders）内完成全部订单。
 * 任一订单价格未知 → 整批阻止；余额不足 → 整批不下单（无半结算）；
 * 每家商家独立订单（共享 checkoutBatchId）+ 独立 expense ledger（可单店退款）；
 * 重复提交返回已有订单，不重复扣款。
 */
export async function createPaidFoodOrdersBatch(orders: CreateFoodOrderInput[]): Promise<PaidFoodOrdersBatchResult> {
    if (orders.length === 0) throw new FoodWalletError('unknown_price', '批量结算至少需要一份订单');
    for (const order of orders) {
        if (order.total === undefined || !Number.isFinite(order.total) || order.total <= 0) {
            throw new FoodWalletError('unknown_price', '存在价格未知的商品，整批无法结算，请补全价格');
        }
    }
    const batchId = `foodbatch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const records = orders.map(order => buildFoodOrderRecord({ ...order, payer: 'user', checkoutBatchId: order.checkoutBatchId ?? batchId }));
    const db = await openDB();
    return new Promise<PaidFoodOrdersBatchResult>((resolve, reject) => {
        const tx = db.transaction(['money_ledger', 'player_wallet', 'food_orders'], 'readwrite');
        const ledgerStore = tx.objectStore('money_ledger');
        const walletReq = tx.objectStore('player_wallet').get('default');
        const entriesReq = ledgerStore.getAll();
        const orderReqs = records.map(record => tx.objectStore('food_orders').index('eventKey').get(record.eventKey));
        let outcome: PaidFoodOrdersBatchResult | null = null;
        let failure: FoodWalletError | null = null;
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            if (failure) reject(failure);
            else if (outcome) resolve(outcome);
            else reject(tx.error || new Error('paid food batch transaction ended without result'));
        };
        const failWith = (code: FoodWalletErrorCode, message: string) => {
            if (done || failure) return;
            failure = new FoodWalletError(code, message);
            try { tx.abort(); } catch { /* noop */ }
            finish();
        };
        walletReq.onerror = () => failWith('not_initialized', '读取钱包配置失败');
        entriesReq.onerror = () => failWith('not_initialized', '读取钱包流水失败');
        orderReqs.forEach((req, index) => { req.onerror = () => failWith('not_initialized', `读取已有订单失败（第 ${index + 1} 单）`); });
        // 决策放最后完成的请求回调（最后一个 order index get）——wallet/entries/其余 order 均已就绪
        const lastReq = orderReqs[orderReqs.length - 1];
        lastReq.onsuccess = () => {
            if (failure || done) return;
            try {
                const wallet = walletReq.result as { openingBalance: number } | undefined;
                const entries = (entriesReq.result as MoneyLedgerEntry[]) || [];
                if (!wallet) throw new FoodWalletError('not_initialized', '钱包尚未启用，请先在记账 App 开启玩家钱包');
                let balance = Math.round(wallet.openingBalance * 100) / 100;
                for (const entry of entries) balance += entry.direction === 'income' ? entry.amount : -entry.amount;
                balance = Math.round(balance * 100) / 100;

                const results: Array<PaidFoodOrderResult> = [];
                let createdCount = 0;
                let healTotal = 0; // 重复订单缺流水时的补账额（计入余额校验）
                const pendingCreate: Array<{ record: FoodOrderRecord; total: number }> = [];
                records.forEach((record, index) => {
                    const existingOrder = (orderReqs[index].result as FoodOrderRecord | undefined) || null;
                    const ledgerKey = `food-order:${record.eventKey}`;
                    const existingLedger = entries.find(entry => entry.eventKey === ledgerKey) || null;
                    if (existingOrder) {
                        // 重复提交：返回已有订单；流水缺失时尽力补账
                        let ledger = existingLedger;
                        let ledgerCreated = false;
                        if (!ledger && existingOrder.total !== undefined) {
                            ledger = buildFoodExpense(existingOrder, existingOrder.total);
                            ledgerStore.put(ledger);
                            ledgerCreated = true;
                            healTotal += existingOrder.total;
                        }
                        results.push({ record: existingOrder, created: false, ledgerEntry: ledger, ledgerCreated });
                        return;
                    }
                    if (existingLedger) {
                        // 极端：流水在订单不在（理论不可达）。不二次扣款，仅补订单。
                        pendingCreate.push({ record, total: 0 });
                        results.push({ record, created: true, ledgerEntry: existingLedger, ledgerCreated: false });
                        createdCount += 1;
                        return;
                    }
                    pendingCreate.push({ record, total: record.total ?? 0 });
                    results.push({ record, created: true, ledgerEntry: null, ledgerCreated: true });
                    createdCount += 1;
                });
                const newChargeTotal = Math.round(pendingCreate.reduce((sum, item) => sum + item.total, 0) * 100) / 100;
                const needTotal = Math.round((healTotal + newChargeTotal) * 100) / 100;
                if (balance < needTotal) {
                    throw new FoodWalletError('insufficient_balance', `余额不足：当前 ¥${balance}，本批共需 ¥${needTotal}`);
                }
                for (const item of pendingCreate) {
                    if (item.total > 0) ledgerStore.put(buildFoodExpense(item.record, item.total));
                    tx.objectStore('food_orders').add(item.record);
                }
                outcome = { results, batchId, createdCount, chargedTotal: needTotal };
            } catch (error) {
                if (!failure) {
                    failure = error instanceof FoodWalletError ? error : new FoodWalletError('unknown_price', String(error));
                    try { tx.abort(); } catch { /* noop */ }
                    finish();
                }
            }
        };
        tx.oncomplete = finish;
        tx.onerror = () => { if (!failure) failure = new FoodWalletError('not_initialized', String(tx.error)); finish(); };
        tx.onabort = finish;
    });
}

/**
 * 取消退款：仅 payer=user 且取消时状态 ∈ {confirmed, preparing}（调用方用
 * isRefundableCancelStatus 判定后传入）。原 expense 永不修改；追加 income entry，
 * eventKey=`food-refund:<orderId>` 幂等，重复取消/重放不会重复退款。
 * 返回 refunded=false 表示不适用（角色付款 / 金额未知）或已退过。
 */
export async function refundFoodOrder(order: FoodOrderRecord): Promise<{ refunded: boolean; eventKey: string }> {
    if (orderPayer(order) !== 'user') return { refunded: false, eventKey: '' };
    const amount = order.total;
    if (amount === undefined || !Number.isFinite(amount) || amount <= 0) return { refunded: false, eventKey: '' };
    const eventKey = `food-refund:${order.id}`;
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('money_ledger', 'readwrite');
        const store = tx.objectStore('money_ledger');
        const req = store.index('eventKey').get(eventKey);
        req.onsuccess = () => {
            if (req.result) return; // 已退款，幂等
            const now = Date.now();
            store.put({
                id: `ledger_foodrefund_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
                eventKey,
                direction: 'income',
                amount: Math.round(amount * 100) / 100,
                category: 'food',
                source: 'food',
                referenceId: order.id,
                note: `外卖退款 · ${order.merchantName || '订单'}`,
                createdAt: now,
                metadata: { orderId: order.id, orderEventKey: order.eventKey },
            } satisfies MoneyLedgerEntry);
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || req.error);
        tx.onabort = () => reject(tx.error || new Error('refund transaction aborted'));
    });
    return { refunded: true, eventKey };
}


