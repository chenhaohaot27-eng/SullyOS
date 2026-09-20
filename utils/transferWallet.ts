/**
 * Transfer × 玩家钱包桥（Player Economy Phase 2）
 * ═════════════════════════════════════════════════════════════════
 * 只影响玩家钱包，不建角色钱包。Ledger 写入只由新的、明确的 transfer
 * state transition 触发——历史消息 / restore / 重渲染 / postprocess 重跑
 * 一律不追溯入账（历史转账没有任何 ledger 记录，退款侧有 expense 存在性守卫）。
 *
 * A. 玩家→角色发送：sendTransferFromWallet —— messages + money_ledger +
 *    player_wallet 单事务；余额不足/未启用 → 整体 abort（转账消息不落库）。
 *    eventKey=transfer-out:<messageId>。
 * B. 角色退回玩家转账：refundRejectedTransfer —— 只有存在对应 transfer-out
 *    expense 才退款（历史转账退回零动作，绝不凭空造钱）。
 *    eventKey=transfer-refund:<messageId>。
 * C. 角色→玩家收款：acceptIncomingTransfer —— 玩家点「收下」才入账；
 *    「退回」不入账。eventKey=transfer-in:<messageId>。
 */

import { openDB } from './db';
import type { Message, MoneyLedgerEntry } from '../types';

const LEDGER_STORE = 'money_ledger';

export type TransferWalletStatus = 'ok' | 'already_done' | 'insufficient_balance' | 'not_initialized' | 'duplicate_click';

export class TransferWalletError extends Error {
    code: TransferWalletStatus;
    constructor(code: TransferWalletStatus, message: string) {
        super(message);
        this.name = 'TransferWalletError';
        this.code = code;
    }
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

export interface SendTransferResult {
    status: 'ok';
    messageId: number;
    entry: MoneyLedgerEntry;
}

// 极短窗防双击：同一 (charId, amount) 2 秒内的重复发送直接拒绝。
// eventKey 基于新建 messageId，防不了"双击创建两条消息"，故补这一层进程内防抖。
const recentSends = new Map<string, number>();
const DUPLICATE_WINDOW_MS = 2000;
const sendKey = (charId: string, amount: number): string => `${charId}|${round2(amount)}`;

/**
 * 玩家→角色转账：扣款 + transfer 消息在同一 IndexedDB 事务内原子完成。
 * 余额不足 / 钱包未启用 → 整体 abort，消息不落库、不产生 expense。
 * metadata 兼容现有 transfer 卡语义：amount 字符串、status 'pending'。
 */
export async function sendTransferFromWallet(input: {
    charId: string; charName: string; amount: number; note?: string; now?: number;
}): Promise<SendTransferResult> {
    const amount = round2(input.amount);
    if (!(amount > 0) || !Number.isFinite(amount)) {
        throw new TransferWalletError('insufficient_balance', '转账金额无效');
    }
    const key = sendKey(input.charId, amount);
    const now = input.now ?? Date.now();
    const last = recentSends.get(key);
    if (last && now - last < DUPLICATE_WINDOW_MS) {
        throw new TransferWalletError('duplicate_click', '转账处理中，请稍候');
    }
    recentSends.set(key, now);
    if (recentSends.size > 100) recentSends.clear();

    const db = await openDB();
    try {
        return await new Promise<SendTransferResult>((resolve, reject) => {
            const tx = db.transaction(['messages', LEDGER_STORE, 'player_wallet'], 'readwrite');
            const walletReq = tx.objectStore('player_wallet').get('default');
            const entriesReq = tx.objectStore(LEDGER_STORE).getAll();
            const msgReq = tx.objectStore('messages').add({
                charId: input.charId, role: 'user', type: 'transfer', content: '[转账]',
                metadata: { amount: String(amount), note: input.note, status: 'pending' },
                timestamp: now,
            });
            let outcome: SendTransferResult | null = null;
            let failure: TransferWalletError | null = null;
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                if (failure) reject(failure);
                else if (outcome) resolve(outcome);
                else reject(tx.error || new Error('transfer-out transaction ended without result'));
            };
            const fail = (code: TransferWalletStatus, message: string) => {
                if (done || failure) return;
                failure = new TransferWalletError(code, message);
                try { tx.abort(); } catch { /* noop */ }
                finish();
            };
            walletReq.onerror = () => fail('not_initialized', '读取钱包配置失败');
            entriesReq.onerror = () => fail('not_initialized', '读取钱包流水失败');
            msgReq.onerror = () => fail('not_initialized', '保存转账消息失败');
            // 决策放最后完成的请求回调（msgReq）——wallet/entries 的 result 均已就绪
            msgReq.onsuccess = () => {
                if (failure || done) return;
                const messageId = msgReq.result as number;
                try {
                    const wallet = walletReq.result as { openingBalance: number } | undefined;
                    if (!wallet) throw new TransferWalletError('not_initialized', '钱包尚未启用，请先在记账 App 开启玩家钱包');
                    const entries = (entriesReq.result as MoneyLedgerEntry[]) || [];
                    const eventKey = `transfer-out:${messageId}`;
                    if (entries.some(entry => entry.eventKey === eventKey)) {
                        throw new TransferWalletError('duplicate_click', '这笔转账已经扣过款');
                    }
                    let balance = round2(wallet.openingBalance);
                    for (const entry of entries) balance += entry.direction === 'income' ? entry.amount : -entry.amount;
                    balance = round2(balance);
                    if (balance < amount) {
                        throw new TransferWalletError('insufficient_balance', `余额不足：当前 ¥${balance}，本次转账需 ¥${amount}`);
                    }
                    const entry: MoneyLedgerEntry = {
                        id: `ledger_txout_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
                        eventKey, direction: 'expense', amount,
                        category: 'transfer', source: 'transfer',
                        referenceId: String(messageId),
                        note: `转账给${input.charName}`, createdAt: now,
                        metadata: { characterId: input.charId, direction: 'player_to_character', amount },
                    };
                    tx.objectStore(LEDGER_STORE).put(entry);
                    outcome = { status: 'ok', messageId, entry };
                } catch (error) {
                    if (!failure) {
                        failure = error instanceof TransferWalletError ? error : new TransferWalletError('not_initialized', String(error));
                        try { tx.abort(); } catch { /* noop */ }
                        finish();
                    }
                }
            };
            tx.oncomplete = finish;
            tx.onerror = () => { if (!failure) failure = new TransferWalletError('not_initialized', String(tx.error)); finish(); };
            tx.onabort = finish;
        });
    } catch (error) {
        recentSends.delete(key); // 失败不占用防抖窗
        throw error;
    }
}

export interface RefundRejectedResult {
    refunded: boolean;
    reason?: 'no_expense' | 'already_refunded';
}

/**
 * 角色退回玩家转账（chatParser.resolveUserTransfer('returned') 调用）。
 * 守卫：只有钱包时代发出的转账（存在 transfer-out:<refId> expense）才退款；
 * Phase 2 之前的历史转账退回 → no_expense 零动作。幂等：transfer-refund:<refId>。
 */
export async function refundRejectedTransfer(refId: number, now = Date.now()): Promise<RefundRejectedResult> {
    const db = await openDB();
    return new Promise<RefundRejectedResult>((resolve, reject) => {
        const tx = db.transaction(LEDGER_STORE, 'readwrite');
        const store = tx.objectStore(LEDGER_STORE);
        const outReq = store.index('eventKey').get(`transfer-out:${refId}`);
        let outcome: RefundRejectedResult | null = null;
        outReq.onsuccess = () => {
            const expense = outReq.result as MoneyLedgerEntry | undefined;
            if (!expense) { outcome = { refunded: false, reason: 'no_expense' }; return; }
            const refundReq = store.index('eventKey').get(`transfer-refund:${refId}`);
            refundReq.onsuccess = () => {
                if (refundReq.result) { outcome = { refunded: false, reason: 'already_refunded' }; return; }
                store.put({
                    id: `ledger_txrefund_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
                    eventKey: `transfer-refund:${refId}`,
                    direction: 'income',
                    amount: expense.amount,
                    category: 'transfer',
                    source: 'transfer',
                    referenceId: String(refId),
                    note: '转账被退回',
                    createdAt: now,
                    metadata: { originalEventKey: expense.eventKey, characterId: expense.metadata?.characterId },
                } satisfies MoneyLedgerEntry);
                outcome = { refunded: true };
            };
            refundReq.onerror = () => { outcome = { refunded: false, reason: 'already_refunded' }; };
        };
        tx.oncomplete = () => outcome ? resolve(outcome) : reject(tx.error || new Error('transfer-refund transaction failed'));
        tx.onerror = () => reject(tx.error || outReq.error);
        tx.onabort = () => reject(tx.error || new Error('transfer-refund transaction aborted'));
    });
}

export interface AcceptTransferResult {
    status: 'ok' | 'already_done';
    incomeEntry: MoneyLedgerEntry | null;
}

/**
 * 角色→玩家转账的玩家收/退（Chat.handleResolveTransfer 调用）。
 * 同一事务（messages + money_ledger + player_wallet）内完成：
 * 以 DB 里的消息为准重新校验 pending（防双击/重放）→ 更新 status →
 * accepted 且钱包启用时写 income（eventKey=transfer-in:<messageId>）→ 落回执消息。
 * 钱包未启用：保持原纯消息行为（无 ledger 写入）。
 * 「退回」（returned）：只更新消息，不产生 income。
 */
export async function acceptIncomingTransfer(msg: Message, action: 'accepted' | 'returned', now = Date.now()): Promise<AcceptTransferResult> {
    const db = await openDB();
    return new Promise<AcceptTransferResult>((resolve, reject) => {
        const tx = db.transaction(['messages', LEDGER_STORE, 'player_wallet'], 'readwrite');
        const msgReq = tx.objectStore('messages').get(msg.id);
        const walletReq = tx.objectStore('player_wallet').get('default');
        const entriesReq = tx.objectStore(LEDGER_STORE).getAll();
        let outcome: AcceptTransferResult | null = null;
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            if (outcome) resolve(outcome);
            else reject(tx.error || new Error('transfer-in transaction ended without result'));
        };
        msgReq.onerror = finish;
        walletReq.onerror = finish;
        entriesReq.onerror = finish;
        // 决策放最后完成的请求回调（entriesReq）——msg/wallet result 均已就绪
        entriesReq.onsuccess = () => {
            if (done) return;
            try {
                const current = msgReq.result as Message | undefined;
                if (!current || current.type !== 'transfer') { outcome = { status: 'already_done', incomeEntry: null }; return; }
                if (current.metadata?.receipt || (current.metadata?.status && current.metadata.status !== 'pending')) {
                    outcome = { status: 'already_done', incomeEntry: null }; return;
                }
                const wallet = walletReq.result as { openingBalance: number } | undefined;
                const entries = (entriesReq.result as MoneyLedgerEntry[]) || [];
                const eventKey = `transfer-in:${msg.id}`;
                let incomeEntry = entries.find(entry => entry.eventKey === eventKey) || null;
                if (action === 'accepted' && wallet && !incomeEntry) {
                    const amount = round2(parseFloat(String(current.metadata?.amount ?? '')) || 0);
                    if (amount > 0) {
                        incomeEntry = {
                            id: `ledger_txin_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
                            eventKey, direction: 'income', amount,
                            category: 'transfer', source: 'transfer',
                            referenceId: String(msg.id),
                            note: '收到转账', createdAt: now,
                            metadata: { characterId: current.charId, direction: 'character_to_player', amount },
                        };
                        tx.objectStore(LEDGER_STORE).put(incomeEntry);
                    }
                }
                tx.objectStore('messages').put({
                    ...current,
                    metadata: { ...(current.metadata || {}), status: action, resolvedAt: now },
                });
                tx.objectStore('messages').add({
                    charId: current.charId, role: 'user', type: 'transfer',
                    content: action === 'accepted' ? '[已收款]' : '[已退回]',
                    metadata: { receipt: action, amount: current.metadata?.amount, ref: current.id },
                    timestamp: now,
                });
                outcome = { status: 'ok', incomeEntry };
            } catch (error) {
                console.warn('[TransferWallet] 收款入账失败（消息状态不受影响）:', error);
                outcome = { status: 'ok', incomeEntry: null };
            }
        };
        tx.oncomplete = finish;
        tx.onerror = finish;
        tx.onabort = finish;
    });
}



