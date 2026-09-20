/**
 * Player Economy Phase 2 · Backup/Restore 正式 QA
 * 覆盖：walletConfig / moneyLedger（含 transfer、cafe、food ledger）roundtrip、
 * restore 后余额完全一致、restore 零资金副作用、legacy 备份（无钱包字段）兼容。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DB } from './db';
import { getAvailableBalance, getWalletConfig, initializeWallet, listLedgerEntries, spend } from './playerWallet';
import { sendTransferFromWallet } from './transferWallet';
import { runDailyCafeOperation } from './cafeEarnings';
import type { BankFullState, FullBackupData } from '../types';

beforeEach(async () => { await DB.deleteDB(); });
afterEach(() => vi.restoreAllMocks());

const bank = (): BankFullState => ({
    config: { dailyBudget: 100, currencySymbol: '¥' },
    shop: {
        actionPoints: 100, shopName: '咖啡馆', shopLevel: 1, appeal: 160, background: '',
        staff: [{ id: 'staff-001', name: '系统', avatar: '', role: 'manager', fatigue: 0, maxFatigue: 100, hireDate: 1 }],
        unlockedRecipes: ['recipe-coffee-001'],
    },
    goals: [], todaySpent: 0, lastLoginDate: '2026-01-01',
});

describe('playerEconomy · backup/restore roundtrip', () => {
    it('备份包含 walletConfig 与全部 moneyLedger（transfer/cafe/manual）', async () => {
        await initializeWallet(100);
        await DB.saveBankState(bank());
        await sendTransferFromWallet({ charId: 'c1', charName: '小星', amount: 20, now: 1000 });
        await runDailyCafeOperation();
        await spend({ amount: 5, note: '午饭', eventKey: 'm1' });
        const backup = await DB.exportFullData() as FullBackupData;
        expect(backup.walletConfig).toMatchObject({ id: 'default', openingBalance: 100 });
        expect(backup.moneyLedger).toHaveLength(3);
        expect(new Set((backup.moneyLedger || []).map(e => e.source))).toEqual(new Set(['transfer', 'cafe', 'manual']));
    });

    it('restore 后余额完全一致、流水 eventKey 一致、无新增条目', async () => {
        await initializeWallet(88.5);
        await DB.saveBankState(bank());
        await sendTransferFromWallet({ charId: 'c9', charName: '小星', amount: 20, now: 20000 });
        await runDailyCafeOperation();
        const balanceBefore = await getAvailableBalance();
        const entriesBefore = (await listLedgerEntries()).map(e => e.eventKey).sort();
        const backup = await DB.exportFullData();

        await DB.deleteDB();
        expect(await getWalletConfig()).toBeNull();
        await DB.importFullData(backup as any);

        expect(await getAvailableBalance()).toBe(balanceBefore);
        const entriesAfter = (await listLedgerEntries()).map(e => e.eventKey).sort();
        expect(entriesAfter).toEqual(entriesBefore);
        expect((await listLedgerEntries()).length).toBe(entriesBefore.length);
    });

    it('restore 是纯数据回放：不产生任何新的资金副作用', async () => {
        await initializeWallet(50);
        await DB.saveBankState(bank());
        const cafeEntry = await runDailyCafeOperation();
        expect(cafeEntry.status).toBe('ok');
        const backup = await DB.exportFullData();
        const snapshot = JSON.stringify((backup as any).moneyLedger.map((e: any) => e.eventKey).sort());

        await DB.deleteDB();
        await DB.importFullData(backup as any);
        // 再次 export：与第一次备份完全一致 → restore 没有制造任何新 ledger entry
        const backup2 = await DB.exportFullData();
        expect(JSON.stringify((backup2 as any).moneyLedger.map((e: any) => e.eventKey).sort())).toBe(snapshot);
        expect((await listLedgerEntries()).filter(e => e.source === 'cafe')).toHaveLength(1);
    });

    it('legacy 备份（无 walletConfig / moneyLedger 字段）可正常恢复，钱包保持未初始化', async () => {
        await initializeWallet(100);
        await DB.saveBankState(bank());
        const backup = await DB.exportFullData() as FullBackupData;
        const legacy = { ...backup } as Partial<FullBackupData>;
        delete legacy.walletConfig;
        delete legacy.moneyLedger;
        // legacy 备份仍应带 bankState / bankTransactions
        expect(legacy.bankState).toBeTruthy();

        await DB.deleteDB();
        await DB.importFullData(legacy as any);
        expect(await getWalletConfig()).toBeNull(); // 不自动猜 openingBalance
        expect(await getAvailableBalance()).toBeNull();
        expect((await DB.getBankState())?.shop.shopName).toBe('咖啡馆'); // 老 Bank 数据正常恢复
    });
});
