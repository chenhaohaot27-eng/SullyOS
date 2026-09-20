/**
 * 咖啡店营业收入（Player Economy Phase 2）
 * ═════════════════════════════════════════════════════════════════
 * 玩家主动执行的每日经营任务（不是自动挂机收益）：
 *  - 每个本地日最多一次（eventKey=cafe:daily:<localDateKey> 唯一索引兜底）
 *  - 消耗 AP（与钱包人民币严格分离，AP 仍是咖啡馆游戏资源）
 *  - 收入 deterministic 纯本地计算：0 AI / 0 Chat / 0 Vision / 0 Image / 0 随机数
 *  - 同一天相同店铺状态 → 相同收入；未点击营业当天无收入；不补发历史
 *
 * 事务（bank_data + money_ledger + player_wallet）内完成：
 * 当日已营业检查 → AP 检查 → 计算收入 → 扣 AP → 写 income → 提交。
 */

import { openDB } from './db';
import type { BankFullState, MoneyLedgerEntry, ShopStaff } from '../types';
import { getLocalDateKey } from './localDate';

/** 今日营业的 AP 消耗（集中常量，不散落 magic number）。 */
export const CAFE_DAILY_OPEN_AP_COST = 20;

/** 基础收入：初始咖啡馆（1 名员工 + 1 个初始配方）也能拿到的保底。 */
const BASE_REVENUE = 20;
/** appeal 每超过初始线多少点换 1 元加成。 */
const APPEAL_DIVISOR = 10;
/** 每个已解锁配方的固定加成。 */
const RECIPE_BONUS_PER = 5;
/** 单名低疲劳员工贡献；疲劳 ≥80（现有">80 停止工作"语义）只贡献零头。 */
const STAFF_BONUS_ACTIVE = 10;
const STAFF_BONUS_EXHAUSTED = 2;
/** 初始 appeal 线 = 100 基础 + 初始员工 50 + 初始配方 10，恰好等于初始店铺状态。 */
const INITIAL_APPEAL = 160;

export interface CafeRevenueInput {
    appeal: number;
    unlockedRecipes: string[];
    staff: Pick<ShopStaff, 'fatigue'>[];
}

/**
 * deterministic 营业收入：base + appeal 加成 + 配方加成 + 员工效率加成。
 * 无随机数、无外部调用；同状态同结果。初始店铺 = 20 + 0 + 5 + 10 = 35 元。
 */
export function computeCafeDailyRevenue(shop: CafeRevenueInput): number {
    const appealBonus = Math.max(0, Math.floor(((shop.appeal || 0) - INITIAL_APPEAL) / APPEAL_DIVISOR));
    const recipeBonus = Math.max(0, shop.unlockedRecipes.length) * RECIPE_BONUS_PER;
    const staffBonus = shop.staff.reduce(
        (sum, member) => sum + ((member.fatigue || 0) >= 80 ? STAFF_BONUS_EXHAUSTED : STAFF_BONUS_ACTIVE),
        0,
    );
    return BASE_REVENUE + appealBonus + recipeBonus + staffBonus;
}

export type CafeOpenStatus = 'ok' | 'already_done' | 'insufficient_ap' | 'not_initialized' | 'no_shop_state';

export interface CafeOpenResult {
    status: CafeOpenStatus;
    /** status='ok' 时的营业收入与剩余 AP；其余为 undefined。 */
    revenue?: number;
    actionPointsLeft?: number;
    dateKey: string;
}

/**
 * 今日营业（玩家点击触发，每本地日一次）。
 * bank_data + money_ledger + player_wallet 单事务：
 * 当日 eventKey 已存在 → already_done（不再扣 AP / 不再入账）；
 * AP 不足 → insufficient_ap；钱包未启用 → not_initialized。
 */
export async function runDailyCafeOperation(now = Date.now()): Promise<CafeOpenResult> {
    const dateKey = getLocalDateKey(new Date(now));
    const eventKey = `cafe:daily:${dateKey}`;
    const db = await openDB();
    return new Promise<CafeOpenResult>((resolve, reject) => {
        const tx = db.transaction(['bank_data', 'money_ledger', 'player_wallet'], 'readwrite');
        const bankReq = tx.objectStore('bank_data').get('main_state');
        const walletReq = tx.objectStore('player_wallet').get('default');
        const entriesReq = tx.objectStore('money_ledger').getAll();
        let outcome: CafeOpenResult | null = null;
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            if (outcome) resolve(outcome);
            else reject(tx.error || new Error('cafe daily operation ended without result'));
        };
        bankReq.onerror = finish;
        walletReq.onerror = finish;
        entriesReq.onerror = finish;
        // 决策放最后完成的请求回调（entriesReq）——bank/wallet result 均已就绪
        entriesReq.onsuccess = () => {
            if (done) return;
            try {
                const wallet = walletReq.result as { openingBalance: number } | undefined;
                const entries = (entriesReq.result as MoneyLedgerEntry[]) || [];
                if (entries.some(entry => entry.eventKey === eventKey)) {
                    outcome = { status: 'already_done', dateKey };
                    return;
                }
                if (!wallet) { outcome = { status: 'not_initialized', dateKey }; return; }
                const bankState = (bankReq.result as (BankFullState & { id?: string }) | undefined) || null;
                if (!bankState || !bankState.shop) { outcome = { status: 'no_shop_state', dateKey }; return; }
                const ap = bankState.shop.actionPoints ?? 0;
                if (ap < CAFE_DAILY_OPEN_AP_COST) { outcome = { status: 'insufficient_ap', dateKey }; return; }
                const revenue = computeCafeDailyRevenue(bankState.shop);
                const nextBank: BankFullState & { id: string } = {
                    ...bankState,
                    id: 'main_state',
                    shop: { ...bankState.shop, actionPoints: ap - CAFE_DAILY_OPEN_AP_COST },
                };
                tx.objectStore('bank_data').put(nextBank);
                tx.objectStore('money_ledger').put({
                    id: `ledger_cafe_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
                    eventKey,
                    direction: 'income',
                    amount: revenue,
                    category: 'cafe',
                    source: 'cafe',
                    referenceId: dateKey,
                    note: '咖啡馆营业收入',
                    createdAt: now,
                    metadata: { dateKey, appeal: bankState.shop.appeal, recipes: bankState.shop.unlockedRecipes.length, staff: bankState.shop.staff.length },
                } satisfies MoneyLedgerEntry);
                outcome = { status: 'ok', revenue, actionPointsLeft: ap - CAFE_DAILY_OPEN_AP_COST, dateKey };
            } catch (error) {
                console.warn('[CafeEarnings] 营业失败:', error);
                outcome = { status: 'no_shop_state', dateKey };
            }
        };
        tx.oncomplete = finish;
        tx.onerror = finish;
        tx.onabort = finish;
    });
}

/** UI 预检：今日是否已营业（只读，无副作用）。 */
export async function hasOperatedCafeToday(now = Date.now()): Promise<boolean> {
    const eventKey = `cafe:daily:${getLocalDateKey(new Date(now))}`;
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('money_ledger', 'readonly');
        const req = tx.objectStore('money_ledger').index('eventKey').get(eventKey);
        req.onsuccess = () => resolve(!!req.result);
        req.onerror = () => reject(req.error || tx.error);
    });
}

