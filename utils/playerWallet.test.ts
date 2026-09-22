import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DB, openDB } from './db';
import {
    addIncome, addManualExpense, addManualIncome, deleteManualEntry, deleteManualEntryWithMirror,
    getAvailableBalance, getWalletConfig, initializeWallet, listLedgerEntries, spend, WalletError,
} from './playerWallet';

beforeEach(async () => { await DB.deleteDB(); });
afterEach(() => vi.restoreAllMocks());

describe('playerWallet · 初始化', () => {
    it('DB v76 创建 money_ledger（eventKey 唯一索引）与 player_wallet', async () => {
        const db = await openDB();
        expect(db.version).toBe(78); // v78: music_listen_sessions（Batch B 一起听正式会话）
        const ledger = db.transaction('money_ledger', 'readonly').objectStore('money_ledger');
        expect(ledger.index('eventKey').unique).toBe(true);
        expect(ledger.indexNames.contains('direction')).toBe(true);
        expect(ledger.indexNames.contains('source')).toBe(true);
        expect(ledger.indexNames.contains('createdAt')).toBe(true);
        expect(db.objectStoreNames.contains('player_wallet')).toBe(true);
    });
    it('以 0 开启钱包合法，余额为 0', async () => {
        const { config, created } = await initializeWallet(0);
        expect(created).toBe(true);
        expect(config.openingBalance).toBe(0);
        expect(await getAvailableBalance()).toBe(0);
    });
    it('以正数开启钱包', async () => {
        const { config } = await initializeWallet(123.45);
        expect(config.openingBalance).toBe(123.45);
        expect(await getAvailableBalance()).toBe(123.45);
    });
    it('拒绝负数开启余额', async () => {
        await expect(initializeWallet(-1)).rejects.toMatchObject({ code: 'invalid_amount' });
        expect(await getWalletConfig()).toBeNull();
    });
    it('重复初始化幂等：返回现有配置不覆盖', async () => {
        await initializeWallet(50);
        const second = await initializeWallet(999);
        expect(second.created).toBe(false);
        expect(second.config.openingBalance).toBe(50);
    });
});

describe('playerWallet · 收支', () => {
    beforeEach(async () => { await initializeWallet(100); });

    it('收入增加余额', async () => {
        await addIncome({ amount: 50, note: '工资', eventKey: 't1' });
        expect(await getAvailableBalance()).toBe(150);
    });
    it('支出减少余额', async () => {
        await spend({ amount: 30, note: '午饭', eventKey: 't2' });
        expect(await getAvailableBalance()).toBe(70);
    });
    it('恰好花光 → 余额 0', async () => {
        await spend({ amount: 100, note: '清空', eventKey: 't3' });
        expect(await getAvailableBalance()).toBe(0);
    });
    it('余额不足拒绝且余额不变', async () => {
        await expect(spend({ amount: 100.01, note: '超支', eventKey: 't4' })).rejects.toMatchObject({ code: 'insufficient_balance' });
        expect(await getAvailableBalance()).toBe(100);
        expect((await listLedgerEntries()).filter(e => e.eventKey === 't4')).toHaveLength(0);
    });
    it('重复 eventKey 不重复扣款（顺序）', async () => {
        const first = await spend({ amount: 40, note: 'a', eventKey: 'dup' });
        const second = await spend({ amount: 40, note: 'b', eventKey: 'dup' });
        expect(first.created).toBe(true);
        expect(second.created).toBe(false);
        expect(second.entry.id).toBe(first.entry.id);
        expect(await getAvailableBalance()).toBe(60);
    });
    it('并发双击同一 eventKey 只扣一次', async () => {
        const results = await Promise.all([
            spend({ amount: 80, note: 'click', eventKey: 'race' }),
            spend({ amount: 80, note: 'click', eventKey: 'race' }),
        ]);
        expect(results.filter(r => r.created)).toHaveLength(1);
        expect(await getAvailableBalance()).toBe(20);
    });
    it('并发不同 eventKey 不可能透支：余额 100 并发花 60+60 只成功一笔', async () => {
        const results = await Promise.allSettled([
            spend({ amount: 60, note: 'x', eventKey: 'c1' }),
            spend({ amount: 60, note: 'y', eventKey: 'c2' }),
        ]);
        const ok = results.filter(r => r.status === 'fulfilled');
        const rejected = results.filter(r => r.status === 'rejected' && (r.reason as WalletError).code === 'insufficient_balance');
        expect(ok).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(await getAvailableBalance()).toBe(40);
    });
    it('非法金额拒绝：0 / 负数 / NaN / Infinity', async () => {
        for (const bad of [0, -5, NaN, Infinity]) {
            await expect(spend({ amount: bad, note: 'bad', eventKey: `bad-${bad}` })).rejects.toMatchObject({ code: 'invalid_amount' });
            await expect(addIncome({ amount: bad, note: 'bad', eventKey: `bad-i-${bad}` })).rejects.toMatchObject({ code: 'invalid_amount' });
        }
        expect(await getAvailableBalance()).toBe(100);
    });
});

describe('playerWallet · 金额与未初始化', () => {
    beforeEach(async () => { await initializeWallet(100); });

    it('金额两位小数归一化', async () => {
        await spend({ amount: 10.005, note: '浮点', eventKey: 'round' });
        expect(await getAvailableBalance()).toBe(89.99);
        const entries = await listLedgerEntries();
        expect(entries.find(e => e.eventKey === 'round')?.amount).toBe(10.01);
    });
    it('未初始化时 spend/addIncome 报 not_initialized', async () => {
        await DB.deleteDB();
        await expect(spend({ amount: 1, note: 'x', eventKey: 'n1' })).rejects.toMatchObject({ code: 'not_initialized' });
        await expect(addIncome({ amount: 1, note: 'x', eventKey: 'n2' })).rejects.toMatchObject({ code: 'not_initialized' });
    });
});

describe('playerWallet · 删除', () => {
    beforeEach(async () => { await initializeWallet(10); });

    it('删除手动支出 → 余额恢复', async () => {
        const { entry } = await spend({ amount: 7, note: 'a', eventKey: 'd1' });
        expect(await getAvailableBalance()).toBe(3);
        await deleteManualEntry(entry.id);
        expect(await getAvailableBalance()).toBe(10);
    });
    it('删除会让余额变负的收入 → 拒绝', async () => {
        const { entry } = await addIncome({ amount: 90, note: '红包', eventKey: 'd2' });
        await spend({ amount: 95, note: '花掉', eventKey: 'd3' }); // 100 - 95 = 5
        await expect(deleteManualEntry(entry.id)).rejects.toMatchObject({ code: 'unsafe_delete' });
        expect((await listLedgerEntries()).find(e => e.id === entry.id)).toBeTruthy();
        expect(await getAvailableBalance()).toBe(5);
    });
    it('业务流水（food）不可手工删除', async () => {
        await addIncome({ amount: 50, note: 'x', eventKey: 'k', source: 'food' });
        const entry = (await listLedgerEntries()).find(e => e.eventKey === 'k')!;
        await expect(deleteManualEntry(entry.id)).rejects.toMatchObject({ code: 'immutable_source' });
    });
});

describe('playerWallet · Bank 兼容 adapter', () => {
    beforeEach(async () => { await initializeWallet(200); });

    it('手动收入不进入 bank_transactions（income 不算 spent）', async () => {
        await addManualIncome(80, '兼职');
        expect(await DB.getAllTransactions()).toHaveLength(0);
        expect(await getAvailableBalance()).toBe(280);
    });
    it('手动支出镜像一条 tx-wallet- BankTransaction（旧统计可用）', async () => {
        const { entry } = await addManualExpense(66, '晚餐');
        const txs = await DB.getAllTransactions();
        expect(txs).toHaveLength(1);
        expect(txs[0].id).toBe(`tx-wallet-${entry.id}`);
        expect(txs[0].amount).toBe(66);
        expect(await getAvailableBalance()).toBe(134);
    });
    it('删除手动支出连带删除镜像，余额恢复', async () => {
        const { entry } = await addManualExpense(66, '晚餐');
        await deleteManualEntryWithMirror(entry.id);
        expect(await DB.getAllTransactions()).toHaveLength(0);
        expect(await getAvailableBalance()).toBe(200);
    });
    it('钱包初始化不追溯扣减历史 BankTransaction', async () => {
        await DB.deleteDB(); // 摆脱本 describe 的 initializeWallet(200)
        await DB.saveTransaction({ id: 'tx-old-1', amount: 500, category: 'general', note: '旧账', timestamp: 1, dateStr: '2026-01-01' });
        await initializeWallet(88);
        expect(await getAvailableBalance()).toBe(88); // 旧支出不折算
        expect((await DB.getAllTransactions()).map(t => t.id)).toEqual(['tx-old-1']);
    });
});

