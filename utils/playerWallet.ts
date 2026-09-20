/**
 * 玩家统一钱包（Player Economy Phase 1）
 * ═════════════════════════════════════════════════════════════════
 * 所有资金写入的唯一入口。核心不变量：
 *
 *  1. availableBalance = openingBalance + Σincome − Σexpense（派生值，永不落库第二份）
 *  2. 余额永远 >= 0：spend() 在同一个 IndexedDB readwrite 事务内完成
 *     "读配置 → 读流水算余额 → eventKey 查重 → 余额校验 → 写 expense"，
 *     任何一步不过关就 abort 整个事务，不存在非原子的 check-then-write。
 *  3. eventKey 幂等：money_ledger.eventKey 唯一索引 + 事务内先查后写，
 *     双击 / React 重渲染 / restore / chat replay 都不会重复入账。
 *  4. amount 恒为正数（符号由 direction 表达），两位小数归一化，拒绝 NaN/Infinity/<=0。
 *  5. 历史 BankTransaction 不追溯：openingBalance 是"启用切点"，由用户填写，
 *     绝不把旧支出流水自动折算成扣减。
 *
 * 本文件不 import 任何业务模块（Food/Transfer/Cafe...），业务侧只准调用这里的 API。
 */

import { openDB, DB } from './db';
import type {
    BankTransaction, MoneyLedgerDirection, MoneyLedgerEntry, MoneyLedgerSource, PlayerWalletConfig,
} from '../types';
import { getLocalDateKey, getLocalDayRange } from './localDate';

const LEDGER_STORE = 'money_ledger';
const WALLET_STORE = 'player_wallet';
const WALLET_ID = 'default';

export type WalletErrorCode =
    | 'already_initialized'
    | 'not_initialized'
    | 'invalid_amount'
    | 'insufficient_balance'
    | 'unsafe_delete'
    | 'immutable_source';

export class WalletError extends Error {
    code: WalletErrorCode;
    constructor(code: WalletErrorCode, message: string) {
        super(message);
        this.name = 'WalletError';
        this.code = code;
    }
}

let seq = 0;
const genId = (): string => `ledger_${Date.now().toString(36)}_${(seq++).toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
export const genWalletEventKey = (prefix: string): string => `${prefix}:${typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`}`;

/** 两位小数归一化；拒绝 NaN / Infinity / 负数 / 0（allowZero 用于 openingBalance）。 */
export function normalizeAmount(value: number, opts: { allowZero?: boolean } = {}): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new WalletError('invalid_amount', `金额无效：${String(value)}`);
    }
    const rounded = Math.round(value * 100) / 100;
    if (rounded <= 0 && !opts.allowZero) {
        throw new WalletError('invalid_amount', '金额必须大于 0');
    }
    return rounded;
}

const deriveBalance = (wallet: PlayerWalletConfig, entries: MoneyLedgerEntry[]): number => {
    let balance = wallet.openingBalance;
    for (const entry of entries) {
        balance += entry.direction === 'income' ? entry.amount : -entry.amount;
    }
    return Math.round(balance * 100) / 100;
};

export interface LedgerWriteInput {
    amount: number;
    note: string;
    category?: string;
    source?: MoneyLedgerSource;
    eventKey: string;
    referenceId?: string;
    metadata?: Record<string, unknown>;
}

export interface LedgerWriteResult {
    entry: MoneyLedgerEntry;
    created: boolean;
}

export async function getWalletConfig(): Promise<PlayerWalletConfig | null> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(WALLET_STORE, 'readonly');
        const req = tx.objectStore(WALLET_STORE).get(WALLET_ID);
        req.onsuccess = () => resolve((req.result as PlayerWalletConfig | undefined) || null);
        req.onerror = () => reject(req.error || tx.error);
    });
}

/** 未启用钱包时返回 null。 */
export async function getAvailableBalance(): Promise<number | null> {
    const { wallet, entries } = await readWalletSnapshot();
    if (!wallet) return null;
    return deriveBalance(wallet, entries);
}

async function readWalletSnapshot(): Promise<{ wallet: PlayerWalletConfig | null; entries: MoneyLedgerEntry[] }> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction([LEDGER_STORE, WALLET_STORE], 'readonly');
        const walletReq = tx.objectStore(WALLET_STORE).get(WALLET_ID);
        const entriesReq = tx.objectStore(LEDGER_STORE).getAll();
        entriesReq.onsuccess = () => resolve({
            wallet: (walletReq.result as PlayerWalletConfig | undefined) || null,
            entries: (entriesReq.result as MoneyLedgerEntry[]) || [],
        });
        entriesReq.onerror = () => reject(entriesReq.error || tx.error);
        walletReq.onerror = () => reject(walletReq.error || tx.error);
    });
}

/**
 * 首次启用钱包：openingBalance = 用户填写的"当前余额"切点（>= 0，允许 0）。
 * 幂等：已初始化时直接返回现有配置（created=false），不覆盖。
 */
export async function initializeWallet(openingBalance: number, currencySymbol = '¥'): Promise<{ config: PlayerWalletConfig; created: boolean }> {
    const amount = normalizeAmount(openingBalance, { allowZero: true });
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(WALLET_STORE, 'readwrite');
        const store = tx.objectStore(WALLET_STORE);
        const req = store.get(WALLET_ID);
        let outcome: { config: PlayerWalletConfig; created: boolean } | null = null;
        req.onsuccess = () => {
            const existing = req.result as PlayerWalletConfig | undefined;
            if (existing) { outcome = { config: existing, created: false }; return; }
            const config: PlayerWalletConfig = {
                id: WALLET_ID,
                openingBalance: amount,
                initializedAt: Date.now(),
                currencySymbol,
            };
            store.put(config);
            outcome = { config, created: true };
        };
        tx.oncomplete = () => outcome ? resolve(outcome) : reject(tx.error || new Error('wallet init failed'));
        tx.onerror = () => reject(tx.error || req.error);
        tx.onabort = () => reject(tx.error || new Error('wallet init aborted'));
    });
}

export interface WalletSummary {
    config: PlayerWalletConfig;
    balance: number;
    todayIncome: number;
    todayExpense: number;
}

/** Bank 钱包卡片一次读取：余额 + 今日收支（本地日界）。未启用返回 null。 */
export async function getWalletSummary(): Promise<WalletSummary | null> {
    const { wallet, entries } = await readWalletSnapshot();
    if (!wallet) return null;
    const range = getLocalDayRange(getLocalDateKey());
    let todayIncome = 0;
    let todayExpense = 0;
    for (const entry of entries) {
        if (range && (entry.createdAt < range.start || entry.createdAt >= range.end)) continue;
        if (entry.direction === 'income') todayIncome += entry.amount;
        else todayExpense += entry.amount;
    }
    return {
        config: wallet,
        balance: deriveBalance(wallet, entries),
        todayIncome: Math.round(todayIncome * 100) / 100,
        todayExpense: Math.round(todayExpense * 100) / 100,
    };
}

export async function listLedgerEntries(filter: { direction?: MoneyLedgerDirection; source?: MoneyLedgerSource } = {}): Promise<MoneyLedgerEntry[]> {
    const { entries } = await readWalletSnapshot();
    return entries
        .filter(entry => (!filter.direction || entry.direction === filter.direction) && (!filter.source || entry.source === filter.source))
        .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}

export async function getLedgerEntryByEventKey(eventKey: string): Promise<MoneyLedgerEntry | null> {
    const { entries } = await readWalletSnapshot();
    return entries.find(entry => entry.eventKey === eventKey) || null;
}

function buildEntry(direction: MoneyLedgerDirection, input: LedgerWriteInput, source: MoneyLedgerSource): MoneyLedgerEntry {
    const amount = normalizeAmount(input.amount);
    return {
        id: genId(),
        eventKey: input.eventKey.trim(),
        direction,
        amount,
        category: input.category?.trim() || 'general',
        source,
        referenceId: input.referenceId,
        note: (input.note || '').trim(),
        createdAt: Date.now(),
        metadata: input.metadata,
    };
}

/** 收入：不需要余额校验；eventKey 重复 → 返回已有流水（created=false），绝不双写。 */
export async function addIncome(input: LedgerWriteInput & { source?: MoneyLedgerSource }): Promise<LedgerWriteResult> {
    const db = await openDB();
    return new Promise<LedgerWriteResult>((resolve, reject) => {
        const tx = db.transaction([LEDGER_STORE, WALLET_STORE], 'readwrite');
        const ledgerStore = tx.objectStore(LEDGER_STORE);
        const walletReq = tx.objectStore(WALLET_STORE).get(WALLET_ID);
        const entriesReq = ledgerStore.getAll();
        let outcome: LedgerWriteResult | null = null;
        let failure: WalletError | null = null;
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            if (failure) reject(failure);
            else if (outcome) resolve(outcome);
            else reject(tx.error || new Error('addIncome transaction ended without result'));
        };
        walletReq.onerror = () => { failure = new WalletError('not_initialized', '读取钱包配置失败'); try { tx.abort(); } catch { /* noop */ } finish(); };
        entriesReq.onerror = () => { failure = new WalletError('not_initialized', '读取钱包流水失败'); try { tx.abort(); } catch { /* noop */ } finish(); };
        entriesReq.onsuccess = () => {
            if (failure || done) return;
            const wallet = (walletReq.result as PlayerWalletConfig | undefined) || null;
            const entries = (entriesReq.result as MoneyLedgerEntry[]) || [];
            try {
                const eventKey = input.eventKey?.trim();
                if (!wallet) throw new WalletError('not_initialized', '钱包尚未启用');
                if (!eventKey) throw new WalletError('invalid_amount', 'eventKey is required');
                const existing = entries.find(entry => entry.eventKey === eventKey);
                if (existing) { outcome = { entry: existing, created: false }; return; }
                const entry = buildEntry('income', { ...input, eventKey }, input.source || 'manual');
                ledgerStore.put(entry);
                outcome = { entry, created: true };
            } catch (error) {
                failure = error instanceof WalletError ? error : new WalletError('invalid_amount', String(error));
                try { tx.abort(); } catch { /* noop */ }
                finish();
            }
        };
        tx.oncomplete = finish;
        tx.onerror = () => { if (!failure) failure = new WalletError('not_initialized', String(tx.error)); finish(); };
        tx.onabort = finish;
    });
}

/**
 * 支出：同一 readwrite 事务内完成查重 + 余额校验 + 写入。
 * 余额不足 → WalletError('insufficient_balance')，事务整体 abort，余额不可能变负。
 * eventKey 重复 → 返回已有流水（created=false），绝不重复扣款。
 */
export async function spend(input: LedgerWriteInput & { source?: MoneyLedgerSource }): Promise<LedgerWriteResult> {
    const db = await openDB();
    return new Promise<LedgerWriteResult>((resolve, reject) => {
        const tx = db.transaction([LEDGER_STORE, WALLET_STORE], 'readwrite');
        const ledgerStore = tx.objectStore(LEDGER_STORE);
        const walletReq = tx.objectStore(WALLET_STORE).get(WALLET_ID);
        const entriesReq = ledgerStore.getAll();
        let outcome: LedgerWriteResult | null = null;
        let failure: WalletError | null = null;
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            if (failure) reject(failure);
            else if (outcome) resolve(outcome);
            else reject(tx.error || new Error('spend transaction ended without result'));
        };
        walletReq.onerror = () => { failure = new WalletError('not_initialized', '读取钱包配置失败'); try { tx.abort(); } catch { /* noop */ } finish(); };
        entriesReq.onerror = () => { failure = new WalletError('not_initialized', '读取钱包流水失败'); try { tx.abort(); } catch { /* noop */ } finish(); };
        entriesReq.onsuccess = () => {
            if (failure || done) return;
            const wallet = (walletReq.result as PlayerWalletConfig | undefined) || null;
            const entries = (entriesReq.result as MoneyLedgerEntry[]) || [];
            const eventKey = input.eventKey?.trim();
            try {
                if (!wallet) throw new WalletError('not_initialized', '钱包尚未启用');
                if (!eventKey) throw new WalletError('invalid_amount', 'eventKey is required');
                const existing = entries.find(entry => entry.eventKey === eventKey);
                if (existing) { outcome = { entry: existing, created: false }; return; }
                const amount = normalizeAmount(input.amount);
                const balance = deriveBalance(wallet, entries);
                if (balance < amount) {
                    throw new WalletError('insufficient_balance', `余额不足：当前 ${balance}，需要 ${amount}`);
                }
                const entry = buildEntry('expense', { ...input, eventKey }, input.source || 'manual');
                ledgerStore.put(entry);
                outcome = { entry, created: true };
            } catch (error) {
                failure = error instanceof WalletError ? error : new WalletError('invalid_amount', String(error));
                try { tx.abort(); } catch { /* noop */ }
                finish();
            }
        };
        tx.oncomplete = finish;
        tx.onerror = () => { if (!failure) failure = new WalletError('not_initialized', String(tx.error)); finish(); };
        tx.onabort = finish;
    });
}

/**
 * 退款/补偿性收入（如 Food 取消退款）：income entry，幂等由 eventKey 保证。
 * 业务规则（何时可退、退多少）由调用方负责；这里只保证账本写入安全。
 */
export async function refund(input: Omit<LedgerWriteInput, 'source'> & { source?: MoneyLedgerSource }): Promise<LedgerWriteResult> {
    return addIncome({ ...input, source: input.source });
}

/**
 * 删除手动流水：
 * - 仅允许 manual / adjustment 来源（food/transfer/cafe 等业务流水不可手工删）
 * - 删除 income 前模拟余额，若会变负 → WalletError('unsafe_delete')
 * - 删除 expense 自动恢复余额（派生余额无需额外动作）
 */
export async function deleteManualEntry(id: string): Promise<void> {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction([LEDGER_STORE, WALLET_STORE], 'readwrite');
        const ledgerStore = tx.objectStore(LEDGER_STORE);
        const walletReq = tx.objectStore(WALLET_STORE).get(WALLET_ID);
        const entriesReq = ledgerStore.getAll();
        let failure: WalletError | null = null;
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            if (failure) reject(failure);
            else resolve();
        };
        walletReq.onerror = () => { failure = new WalletError('not_initialized', '读取钱包配置失败'); try { tx.abort(); } catch { /* noop */ } finish(); };
        entriesReq.onerror = () => { failure = new WalletError('not_initialized', '读取钱包流水失败'); try { tx.abort(); } catch { /* noop */ } finish(); };
        entriesReq.onsuccess = () => {
            if (failure || done) return;
            const wallet = (walletReq.result as PlayerWalletConfig | undefined) || null;
            const entries = (entriesReq.result as MoneyLedgerEntry[]) || [];
            try {
                const entry = entries.find(item => item.id === id);
                if (!entry) return; // 已不存在视为成功（幂等删除）
                if (!wallet) throw new WalletError('not_initialized', '钱包尚未启用');
                if (entry.source !== 'manual' && entry.source !== 'adjustment') {
                    throw new WalletError('immutable_source', `业务流水（${entry.source}）不可手工删除`);
                }
                if (entry.direction === 'income') {
                    const after = deriveBalance(wallet, entries.filter(item => item.id !== id));
                    if (after < 0) throw new WalletError('unsafe_delete', '删除这笔收入会让余额变成负数，已拒绝');
                }
                ledgerStore.delete(id);
            } catch (error) {
                failure = error instanceof WalletError ? error : new WalletError('unsafe_delete', String(error));
                try { tx.abort(); } catch { /* noop */ }
                finish();
            }
        };
        tx.oncomplete = finish;
        tx.onerror = () => { if (!failure) failure = new WalletError('not_initialized', String(tx.error)); finish(); };
        tx.onabort = finish;
    });
}

// ═══════════════ Bank App 手动记账 adapter ═══════════════
// 钱包启用后的手动支出 = spend()（钱包真相源）+ 镜像一条 BankTransaction
// （id 固定为 tx-wallet-<ledgerId>，put 幂等），让旧 dailyBudget / todaySpent /
// AP 每日结算 / BankAnalytics 继续按"正数支出"语义工作。收入绝不镜像，
// 因此旧统计永远不会把 income 误算成支出。

const mirrorTxId = (ledgerEntryId: string): string => `tx-wallet-${ledgerEntryId}`;
export const isWalletMirrorTx = (txId: string): boolean => txId.startsWith('tx-wallet-');
/** 从镜像流水 id 还原 ledger entry id（BankApp 删除旧流水时改道钱包删除用）。 */
export const ledgerIdFromMirrorTx = (txId: string): string | null => (isWalletMirrorTx(txId) ? txId.slice('tx-wallet-'.length) : null);

const mirrorDateKey = (timestamp: number): string => getLocalDateKey(new Date(timestamp));

export async function addManualIncome(amount: number, note: string): Promise<LedgerWriteResult> {
    return addIncome({
        amount, note,
        source: 'manual',
        category: 'general',
        eventKey: genWalletEventKey('wallet-manual-income'),
    });
}

export async function addManualExpense(amount: number, note: string): Promise<LedgerWriteResult> {
    const result = await spend({
        amount, note,
        source: 'manual',
        category: 'general',
        eventKey: genWalletEventKey('wallet-manual-expense'),
    });
    if (result.created) {
        const mirror: BankTransaction = {
            id: mirrorTxId(result.entry.id),
            amount: result.entry.amount,
            category: 'general',
            note: result.entry.note || '钱包支出',
            timestamp: result.entry.createdAt,
            dateStr: mirrorDateKey(result.entry.createdAt),
        };
        try {
            await DB.saveTransaction(mirror); // put 按 id 幂等；失败只影响旧统计展示，不影响余额
        } catch (error) {
            console.warn('[Wallet] 手动支出镜像 BankTransaction 失败（余额不受影响）:', error);
        }
    }
    return result;
}

/** 删除手动流水；若是支出，连镜像 BankTransaction 一起删（旧统计同步回退）。 */
export async function deleteManualEntryWithMirror(id: string): Promise<void> {
    const entry = (await listLedgerEntries()).find(item => item.id === id) || null;
    await deleteManualEntry(id);
    if (entry && entry.direction === 'expense') {
        try {
            await DB.deleteTransaction(mirrorTxId(entry.id));
        } catch (error) {
            console.warn('[Wallet] 删除镜像 BankTransaction 失败:', error);
        }
    }
}



