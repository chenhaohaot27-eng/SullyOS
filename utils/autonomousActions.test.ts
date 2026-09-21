import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DB } from './db';
import {
    buildAutonomousOpportunityGuide, detectExplicitHighCostRequest, evaluateAutonomousOpportunity,
    gateAssistantHighCostAction, getTurnOpportunity, hasRecentAutonomousTransfer, isMealWindow,
    markTurnOpportunity, resetAutonomousStateForTests,
} from './autonomousActions';
import { acceptIncomingTransfer } from './transferWallet';
import { getAvailableBalance, initializeWallet } from './playerWallet';
import type { Message } from '../types';

beforeEach(async () => { await DB.deleteDB(); resetAutonomousStateForTests(); });
afterEach(() => vi.restoreAllMocks());

describe('autonomousActions · 显式请求检测', () => {
    it('检测三类显式请求；普通聊天不误报', () => {
        expect(detectExplicitHighCostRequest('给我点份外卖吧').food).toBe(true);
        expect(detectExplicitHighCostRequest('送我个礼物嘛').gift).toBe(true);
        expect(detectExplicitHighCostRequest('给我转点钱').transfer).toBe(true);
        const neutral = detectExplicitHighCostRequest('今天天气不错，你干嘛呢');
        expect(neutral.food || neutral.gift || neutral.transfer).toBe(false);
    });
});

describe('autonomousActions · 机会评估（注入 RNG）', () => {
    it('无约束下 rng 命中率 → 开启；rng 未命中 → 关闭（机会≠触发）', async () => {
        const closed = await evaluateAutonomousOpportunity({ charId: 'c1', rng: () => 1, cooldownHit: {} });
        expect(closed.open).toBe(false);
        expect(closed.reason).toBe('roll');
        const opened = await evaluateAutonomousOpportunity({ charId: 'c1', rng: () => 0, cooldownHit: {} });
        expect(opened.open).toBe(true);
        expect(opened.candidates).toEqual({ gift: true, food: true, transfer: true });
    });
    it('显式请求 → 不再开放自主机会（显式优先）', async () => {
        const snapshot = await evaluateAutonomousOpportunity({ charId: 'c1', lastUserText: '给我点份外卖', rng: () => 1, cooldownHit: {} });
        expect(snapshot.open).toBe(false);
        expect(snapshot.reason).toBe('explicit');
    });
    it('cooldown 全命中 → no_candidates', async () => {
        const snapshot = await evaluateAutonomousOpportunity({ charId: 'c1', rng: () => 1, cooldownHit: { gift: true, food: true, transfer: true } });
        expect(snapshot.open).toBe(false);
        expect(snapshot.reason).toBe('no_candidates');
        expect(snapshot.candidates).toEqual({ gift: false, food: false, transfer: false });
    });
    it('饭点窗口：本地 11-14 / 17-24', () => {
        expect(isMealWindow(new Date('2026-01-01T12:00:00'))).toBe(true);
        expect(isMealWindow(new Date('2026-01-01T18:30:00'))).toBe(true);
        expect(isMealWindow(new Date('2026-01-01T22:00:00'))).toBe(true);
        expect(isMealWindow(new Date('2026-01-01T15:30:00'))).toBe(false);
        expect(isMealWindow(new Date('2026-01-01T03:00:00'))).toBe(false);
    });
    it('transfer 24h cooldown 从聊天消息推导（含旧记录保守计数）', async () => {
        expect(await hasRecentAutonomousTransfer('c1')).toBe(false);
        await DB.saveMessage({
            charId: 'c1', role: 'assistant', type: 'transfer', content: '[转账]',
            metadata: { amount: '10', status: 'pending' }, timestamp: Date.now() - 1000,
        } as any);
        expect(await hasRecentAutonomousTransfer('c1')).toBe(true);
        const snapshot = await evaluateAutonomousOpportunity({ charId: 'c1', rng: () => 1, cooldownHit: {} });
        expect(snapshot.candidates.transfer).toBe(false);
        expect(snapshot.candidates.food).toBe(true);
    });
});

describe('autonomousActions · 机会提示文案', () => {
    it('open=false → 空串；open → 非强制语义 + 候选列表 + 最多一项', () => {
        const closed = { open: false, reason: 'roll' as const, candidates: { gift: true, food: true, transfer: true }, mealWindow: false, ts: 0 };
        expect(buildAutonomousOpportunityGuide(closed)).toBe('');
        const open = { open: true, reason: 'ok' as const, candidates: { gift: false, food: true, transfer: true }, mealWindow: true, ts: 0 };
        const text = buildAutonomousOpportunityGuide(open);
        expect(text).toContain('非强制');
        expect(text).toContain('最多选择其中一项');
        expect(text).toContain('FOOD_ORDER');
        expect(text).toContain('TRANSFER');
        expect(text).not.toContain('GIFT_SEND');
        expect(text).toContain('用餐时段');
    });
});

describe('autonomousActions · 单轮高成本门控', () => {
    const openSnapshot = { open: true, reason: 'ok' as const, candidates: { gift: true, food: true, transfer: true }, mealWindow: false, ts: Date.now() };
    const closedSnapshot = { open: false, reason: 'roll' as const, candidates: { gift: true, food: true, transfer: true }, mealWindow: false, ts: Date.now() };

    it('快照不存在 → legacy 放行（worker/旧路径行为不变）', () => {
        const result = gateAssistantHighCostAction({ charId: 'legacy', action: 'gift', explicit: false });
        expect(result).toEqual({ allowed: true, mode: 'legacy' });
    });
    it('机会关闭 + 非显式 → denied；显式 → 放行（显式绕过机会门）', () => {
        markTurnOpportunity('c1', closedSnapshot);
        expect(gateAssistantHighCostAction({ charId: 'c1', action: 'gift', explicit: false }).allowed).toBe(false);
        expect(gateAssistantHighCostAction({ charId: 'c1', action: 'gift', explicit: true })).toEqual({ allowed: true, mode: 'explicit' });
    });
    it('机会开放 → 第一个自主动作 claim；同轮第二个不同动作 denied（最多 1 个）', () => {
        markTurnOpportunity('c2', openSnapshot);
        expect(gateAssistantHighCostAction({ charId: 'c2', action: 'transfer', explicit: false })).toEqual({ allowed: true, mode: 'autonomous' });
        expect(gateAssistantHighCostAction({ charId: 'c2', action: 'food', explicit: false }).allowed).toBe(false);
    });
    it('显式请求可覆盖已发生的自主 claim（显式优先）；同 action 幂等重放', () => {
        markTurnOpportunity('c3', openSnapshot);
        expect(gateAssistantHighCostAction({ charId: 'c3', action: 'transfer', explicit: false }).allowed).toBe(true);
        expect(gateAssistantHighCostAction({ charId: 'c3', action: 'food', explicit: true })).toEqual({ allowed: true, mode: 'explicit' });
        expect(gateAssistantHighCostAction({ charId: 'c3', action: 'food', explicit: true }).allowed).toBe(true);
        expect(gateAssistantHighCostAction({ charId: 'c3', action: 'gift', explicit: true }).allowed).toBe(false);
    });
    it('候选冷却中的动作即使机会开放也 denied', () => {
        const snap = { ...openSnapshot, candidates: { gift: true, food: true, transfer: false } };
        markTurnOpportunity('c4', snap);
        expect(gateAssistantHighCostAction({ charId: 'c4', action: 'transfer', explicit: false }).allowed).toBe(false);
    });
    it('快照过期（>15min）→ legacy', () => {
        markTurnOpportunity('c5', { ...openSnapshot, ts: Date.now() - 16 * 60 * 1000 });
        expect(getTurnOpportunity('c5')).toBeNull();
        expect(gateAssistantHighCostAction({ charId: 'c5', action: 'gift', explicit: false }).mode).toBe('legacy');
    });
});

describe('autonomousActions · 自主 transfer 入钱包语义', () => {
    it('自主转账消息落库后：玩家拒收零钱包变动（收下才入账由 transferWallet 语义保证）', async () => {
        await initializeWallet(100);
        const id = await DB.saveMessage({
            charId: 'c1', role: 'assistant', type: 'transfer', content: '[转账]',
            metadata: { amount: '88', status: 'pending', triggerSource: 'autonomous' }, timestamp: Date.now(),
        } as any);
        const messages: Message[] = await DB.getMessagesByCharId('c1');
        const msg = messages.find(m => m.id === id)!;
        await acceptIncomingTransfer(msg, 'returned');
        expect(await getAvailableBalance()).toBe(100);
    });
});

describe('autonomousActions · restore 零副作用', () => {
    it('restore 备份不产生任何新动作', async () => {
        await DB.saveMessage({ charId: 'c1', role: 'assistant', type: 'transfer', content: '[转账]', metadata: { amount: '5', status: 'pending' }, timestamp: 1 } as any);
        const backup = await DB.exportFullData();
        const before = (await DB.getMessagesByCharId('c1')).length;
        await DB.deleteDB();
        await DB.importFullData(backup as any);
        expect((await DB.getMessagesByCharId('c1')).length).toBe(before);
        resetAutonomousStateForTests();
        const gate = gateAssistantHighCostAction({ charId: 'c1', action: 'transfer', explicit: false });
        expect(gate.mode).toBe('legacy');
    });
});

