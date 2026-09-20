import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DB } from './db';
import { getAvailableBalance, initializeWallet, listLedgerEntries } from './playerWallet';
import {
    CAFE_DAILY_OPEN_AP_COST, computeCafeDailyRevenue, hasOperatedCafeToday, runDailyCafeOperation,
} from './cafeEarnings';
import type { BankFullState } from '../types';

beforeEach(async () => { await DB.deleteDB(); });
afterEach(() => vi.restoreAllMocks());

const shop = (over: Partial<BankFullState['shop']> = {}): BankFullState['shop'] => ({
    actionPoints: 100, shopName: '咖啡馆', shopLevel: 1, appeal: 160,
    background: '', staff: [{ id: 'staff-001', name: '系统', avatar: '', role: 'manager', fatigue: 0, maxFatigue: 100, hireDate: 1 }],
    unlockedRecipes: ['recipe-coffee-001'],
    ...over,
});

const bank = (over: Partial<BankFullState> = {}): BankFullState => ({
    config: { dailyBudget: 100, currencySymbol: '¥' },
    shop: shop(),
    goals: [], todaySpent: 0, lastLoginDate: '2026-01-01',
    ...over,
});

function nextDayNoon(key: string): number {
    const d = new Date(`${key}T12:00:00`);
    d.setDate(d.getDate() + 1);
    return d.getTime();
}

describe('cafeEarnings · 收入公式（deterministic 纯函数）', () => {
    it('相同状态 → 相同收入（无随机数）', () => {
        const input = { appeal: 200, unlockedRecipes: ['a', 'b', 'c'], staff: [{ fatigue: 0 }, { fatigue: 30 }] };
        expect(computeCafeDailyRevenue(input)).toBe(computeCafeDailyRevenue(input));
    });
    it('初始店铺也有正收益', () => {
        expect(computeCafeDailyRevenue({ appeal: 160, unlockedRecipes: ['recipe-coffee-001'], staff: [{ fatigue: 0 }] })).toBeGreaterThan(0);
    });
    it('appeal 越高收入越高', () => {
        const low = computeCafeDailyRevenue({ appeal: 160, unlockedRecipes: [], staff: [] });
        const high = computeCafeDailyRevenue({ appeal: 260, unlockedRecipes: [], staff: [] });
        expect(high).toBeGreaterThan(low);
    });
    it('配方越多收入越高', () => {
        const one = computeCafeDailyRevenue({ appeal: 160, unlockedRecipes: ['a'], staff: [] });
        const three = computeCafeDailyRevenue({ appeal: 160, unlockedRecipes: ['a', 'b', 'c'], staff: [] });
        expect(three).toBe(one + 10); // RECIPE_BONUS_PER = 5 × 2 个增量
    });
    it('高疲劳员工贡献降低', () => {
        const fresh = computeCafeDailyRevenue({ appeal: 160, unlockedRecipes: [], staff: [{ fatigue: 0 }] });
        const tired = computeCafeDailyRevenue({ appeal: 160, unlockedRecipes: [], staff: [{ fatigue: 90 }] });
        expect(tired).toBeLessThan(fresh);
    });
});

describe('cafeEarnings · 今日营业（事务）', () => {
    it('钱包未启用 → not_initialized，不扣 AP 不入账', async () => {
        await DB.saveBankState(bank());
        const result = await runDailyCafeOperation();
        expect(result.status).toBe('not_initialized');
        expect((await DB.getBankState())!.shop.actionPoints).toBe(100);
        expect(await listLedgerEntries()).toHaveLength(0);
    });
    it('AP 不足 → insufficient_ap，不入账', async () => {
        await initializeWallet(0);
        await DB.saveBankState(bank({ shop: shop({ actionPoints: CAFE_DAILY_OPEN_AP_COST - 1 }) }));
        const result = await runDailyCafeOperation();
        expect(result.status).toBe('insufficient_ap');
        expect(await listLedgerEntries()).toHaveLength(0);
    });
    it('营业成功 → AP 扣一次 + income 入账一次，余额增加', async () => {
        await initializeWallet(0);
        await DB.saveBankState(bank());
        const result = await runDailyCafeOperation();
        expect(result.status).toBe('ok');
        expect(result.actionPointsLeft).toBe(100 - CAFE_DAILY_OPEN_AP_COST);
        expect((await DB.getBankState())!.shop.actionPoints).toBe(100 - CAFE_DAILY_OPEN_AP_COST);
        const entries = await listLedgerEntries();
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
            direction: 'income', source: 'cafe',
            amount: computeCafeDailyRevenue(bank().shop),
            note: '咖啡馆营业收入',
            referenceId: result.dateKey,
        });
        expect(await getAvailableBalance()).toBe(computeCafeDailyRevenue(bank().shop));
    });
    it('同一天不能营业两次（顺序 + 并发 + PWA 重开都不重复）', async () => {
        await initializeWallet(0);
        await DB.saveBankState(bank());
        const first = await runDailyCafeOperation();
        expect(first.status).toBe('ok');
        const second = await runDailyCafeOperation();
        expect(second.status).toBe('already_done');
        const concurrent = await Promise.all([runDailyCafeOperation(), runDailyCafeOperation()]);
        expect(concurrent.every(r => r.status === 'already_done')).toBe(true);
        expect(await hasOperatedCafeToday()).toBe(true);
        expect((await listLedgerEntries()).filter(e => e.source === 'cafe')).toHaveLength(1);
        expect((await DB.getBankState())!.shop.actionPoints).toBe(100 - CAFE_DAILY_OPEN_AP_COST);
    });
    it('下一个本地日可以再次营业', async () => {
        await initializeWallet(0);
        await DB.saveBankState(bank());
        const day1 = await runDailyCafeOperation();
        expect(day1.status).toBe('ok');
        const day2 = await runDailyCafeOperation(nextDayNoon(day1.dateKey));
        expect(day2.status).toBe('ok');
        expect(day2.dateKey).not.toBe(day1.dateKey);
        expect((await listLedgerEntries()).filter(e => e.source === 'cafe')).toHaveLength(2);
        expect((await DB.getBankState())!.shop.actionPoints).toBe(100 - CAFE_DAILY_OPEN_AP_COST * 2);
    });
});

describe('cafeEarnings · restore 与无自动收入', () => {
    it('restore 备份后（含当日营业记录）不再重复入账或扣 AP', async () => {
        await initializeWallet(10);
        await DB.saveBankState(bank());
        const opened = await runDailyCafeOperation();
        expect(opened.status).toBe('ok');
        const backup = await DB.exportFullData();
        const apAfterOpen = (await DB.getBankState())!.shop.actionPoints;
        await DB.deleteDB();
        await DB.importFullData(backup as any);
        expect(await hasOperatedCafeToday()).toBe(true);
        expect((await DB.getBankState())!.shop.actionPoints).toBe(apAfterOpen);
        const again = await runDailyCafeOperation();
        expect(again.status).toBe('already_done');
        expect((await listLedgerEntries()).filter(e => e.source === 'cafe')).toHaveLength(1);
    });
    it('未营业当天无收入（不自动送钱）', async () => {
        await initializeWallet(0);
        await DB.saveBankState(bank());
        expect(await hasOperatedCafeToday()).toBe(false);
        expect((await listLedgerEntries()).filter(e => e.source === 'cafe')).toHaveLength(0);
    });
});

