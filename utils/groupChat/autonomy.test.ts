// 群聊自主活跃 —— 调度决策纯函数直测（对应需求 E4：群聊自动触发/冷却/夜间/配额/成员身份）。
import { describe, expect, it, beforeEach } from 'vitest';
import type { GroupProfile, Message } from '../../types';
import {
    GROUP_AUTONOMY_LEVELS,
    GROUP_AUTONOMY_COOLDOWN_MS,
    USER_ACTIVITY_QUIET_MS,
    MAX_MESSAGES_PER_AUTONOMY_ROUND,
    DEFAULT_GROUP_PHOTO_DAILY_CAP,
    autonomyIntervalMs,
    isNightQuietTime,
    nextAutonomyCheckAt,
    loadGroupAutonomyState,
    saveGroupAutonomyState,
    GROUP_AUTONOMY_STATE_KEY,
    checkGroupAutonomyDue,
    lastUserGroupMessageAt,
    recordGroupAutonomyRound,
    ensureGroupAutonomyEntry,
    capAutonomyActions,
    photoQuotaRemaining,
    consumePhotoQuota,
    autonomyDayKey,
    normalizeGroupAutonomyLevel,
} from './autonomy';

const makeGroup = (patch: Partial<GroupProfile> = {}): GroupProfile => ({
    id: 'g1',
    name: '测试群',
    members: ['c1', 'c2'],
    createdAt: 0,
    ...patch,
});

const H = 60 * 60 * 1000;

describe('autonomyIntervalMs（三级活跃程度的随机间隔）', () => {
    it('light 落在 2–4 小时', () => {
        for (const r of [0, 0.25, 0.5, 0.99, 1]) {
            const ms = autonomyIntervalMs('light', () => r);
            expect(ms).toBeGreaterThanOrEqual(GROUP_AUTONOMY_LEVELS.light.minMs);
            expect(ms).toBeLessThanOrEqual(GROUP_AUTONOMY_LEVELS.light.maxMs);
        }
    });
    it('daily 落在 1–2 小时', () => {
        expect(autonomyIntervalMs('daily', () => 0)).toBe(GROUP_AUTONOMY_LEVELS.daily.minMs);
        expect(autonomyIntervalMs('daily', () => 1)).toBe(GROUP_AUTONOMY_LEVELS.daily.maxMs);
    });
    it('lively 落在 30–60 分钟', () => {
        expect(autonomyIntervalMs('lively', () => 0)).toBe(30 * 60 * 1000);
        expect(autonomyIntervalMs('lively', () => 1)).toBe(60 * 60 * 1000);
    });
    it('非法 level 归一为 daily，不抛错', () => {
        expect(autonomyIntervalMs('bogus' as never, () => 0)).toBe(GROUP_AUTONOMY_LEVELS.daily.minMs);
        expect(normalizeGroupAutonomyLevel('nope')).toBe('daily');
    });
});

describe('夜间静默（23:00–07:00）', () => {
    it('识别夜间/白天', () => {
        expect(isNightQuietTime(new Date('2026-05-01T23:30:00'))).toBe(true);
        expect(isNightQuietTime(new Date('2026-05-01T03:00:00'))).toBe(true);
        expect(isNightQuietTime(new Date('2026-05-01T12:00:00'))).toBe(false);
        expect(isNightQuietTime(new Date('2026-05-01T07:00:00'))).toBe(false);
    });
    it('检查点落在夜间时顺延到次日早晨 7 点后（含抖动 <1h）', () => {
        const from = new Date('2026-05-01T22:30:00').getTime();
        const next = nextAutonomyCheckAt('light', from, () => 0);
        const nextDate = new Date(next);
        expect(nextDate.getHours()).toBeGreaterThanOrEqual(7);
        expect(nextDate.getHours()).toBeLessThan(8);
        expect(nextDate.getDate()).toBe(2);
    });
    it('白天落点不动', () => {
        const from = new Date('2026-05-01T10:00:00').getTime();
        const next = nextAutonomyCheckAt('lively', from, () => 0);
        expect(next - from).toBe(30 * 60 * 1000);
    });
});

describe('触发判定 checkGroupAutonomyDue', () => {
    const now = new Date('2026-05-01T12:00:00');
    const noon = now.getTime();

    it('未开启 / 无排程 / 未到点 不触发', () => {
        const disabled = makeGroup();
        expect(checkGroupAutonomyDue(disabled, {}, now).reason).toBe('disabled');
        const enabled = makeGroup({ autonomyConfig: { enabled: true, level: 'daily' } });
        expect(checkGroupAutonomyDue(enabled, {}, now).reason).toBe('no-schedule');
        const state = { g1: { nextCheckAt: noon + H, lastRoundAt: 0 } };
        expect(checkGroupAutonomyDue(enabled, state, now).reason).toBe('not-yet');
    });

    it('到点 + 冷却已过 → 触发', () => {
        const enabled = makeGroup({ autonomyConfig: { enabled: true, level: 'daily' } });
        const state = { g1: { nextCheckAt: noon - 1000, lastRoundAt: noon - GROUP_AUTONOMY_COOLDOWN_MS - 1 } };
        expect(checkGroupAutonomyDue(enabled, state, now).due).toBe(true);
    });

    it('冷却期内不触发（群级冷却）', () => {
        const enabled = makeGroup({ autonomyConfig: { enabled: true, level: 'daily' } });
        const state = { g1: { nextCheckAt: noon - 1000, lastRoundAt: noon - 60_000 } };
        expect(checkGroupAutonomyDue(enabled, state, now).reason).toBe('cooldown');
    });

    it('夜间不触发（即使到点）', () => {
        const night = new Date('2026-05-01T23:30:00');
        const enabled = makeGroup({ autonomyConfig: { enabled: true, level: 'daily' } });
        const state = { g1: { nextCheckAt: night.getTime() - 1000, lastRoundAt: 0 } };
        expect(checkGroupAutonomyDue(enabled, state, night).reason).toBe('night-quiet');
    });

    it('用户刚发言（15 分钟内）不触发——留给手动闪电', () => {
        const enabled = makeGroup({ autonomyConfig: { enabled: true, level: 'daily' } });
        const state = { g1: { nextCheckAt: noon - 1000, lastRoundAt: 0 } };
        const lastUser = noon - USER_ACTIVITY_QUIET_MS + 60_000;
        expect(checkGroupAutonomyDue(enabled, state, now, lastUser).reason).toBe('user-active');
        const oldUser = noon - USER_ACTIVITY_QUIET_MS - 1;
        expect(checkGroupAutonomyDue(enabled, state, now, oldUser).due).toBe(true);
    });
});

describe('用户活跃检测与消息保护', () => {
    it('lastUserGroupMessageAt 取最后一条 user 消息时间戳', () => {
        const msgs = [
            { role: 'user', timestamp: 100 },
            { role: 'assistant', timestamp: 200 },
            { role: 'user', timestamp: 300 },
            { role: 'assistant', timestamp: 400 },
        ] as Pick<Message, 'role' | 'timestamp'>[];
        expect(lastUserGroupMessageAt(msgs)).toBe(300);
        expect(lastUserGroupMessageAt([])).toBeNull();
        expect(lastUserGroupMessageAt([{ role: 'assistant', timestamp: 1 } as never])).toBeNull();
    });

    it('capAutonomyActions 截断到上限（最大连续消息保护）', () => {
        const actions = [1, 2, 3, 4, 5, 6];
        expect(capAutonomyActions(actions)).toHaveLength(MAX_MESSAGES_PER_AUTONOMY_ROUND);
        expect(capAutonomyActions([1, 2])).toHaveLength(2);
        expect(capAutonomyActions([])).toHaveLength(0);
    });
});

describe('状态持久化与排程', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('save/load 往返；坏数据安全回落空表', () => {
        const state = recordGroupAutonomyRound({}, 'g1', 'daily', 1000, () => 0);
        saveGroupAutonomyState(state);
        const loaded = loadGroupAutonomyState();
        expect(loaded.g1.lastRoundAt).toBe(1000);
        expect(loaded.g1.nextCheckAt).toBe(1000 + GROUP_AUTONOMY_LEVELS.daily.minMs);
        localStorage.setItem(GROUP_AUTONOMY_STATE_KEY, 'not-json');
        expect(loadGroupAutonomyState()).toEqual({});
    });

    it('ensureGroupAutonomyEntry：开启补 entry、关闭清掉、不同群互不影响', () => {
        let state = ensureGroupAutonomyEntry({}, 'g1', { enabled: true, level: 'light' }, 0, () => 0);
        expect(state.g1).toBeDefined();
        expect(state.g1.nextCheckAt).toBe(GROUP_AUTONOMY_LEVELS.light.minMs);
        // 已有 entry 不覆盖（保留既有排程与配额）
        state = ensureGroupAutonomyEntry(state, 'g1', { enabled: true, level: 'lively' }, 999, () => 0);
        expect(state.g1.nextCheckAt).toBe(GROUP_AUTONOMY_LEVELS.light.minMs);
        // 关掉 g1 只清 g1
        state = ensureGroupAutonomyEntry(state, 'g2', { enabled: true, level: 'daily' }, 0, () => 0);
        state = ensureGroupAutonomyEntry(state, 'g1', undefined, 0, () => 0);
        expect(state.g1).toBeUndefined();
        expect(state.g2).toBeDefined();
    });
});

describe('图片配额（默认每天 2 张、按天滚动、尝试即消耗）', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('默认配额 2，消耗递减到 0', () => {
        const group = makeGroup({ autonomyConfig: { enabled: true, level: 'daily', photoEnabled: true } });
        let state = consumePhotoQuota({}, 'g1');
        expect(photoQuotaRemaining(group, state.g1)).toBe(1);
        state = consumePhotoQuota(state, 'g1');
        expect(photoQuotaRemaining(group, state.g1)).toBe(0);
    });

    it('配额按天滚动：昨天的用量不占今天', () => {
        const group = makeGroup({ autonomyConfig: { enabled: true, level: 'daily', photoEnabled: true } });
        const yesterday = new Date('2026-05-01T12:00:00');
        const today = new Date('2026-05-02T12:00:00');
        expect(autonomyDayKey(yesterday)).not.toBe(autonomyDayKey(today));
        let state = consumePhotoQuota({}, 'g1', yesterday);
        state = consumePhotoQuota(state, 'g1', yesterday);
        expect(photoQuotaRemaining(group, state.g1, today)).toBe(DEFAULT_GROUP_PHOTO_DAILY_CAP);
    });

    it('photoDailyCap=0 等价关闭自主生图', () => {
        const group = makeGroup({ autonomyConfig: { enabled: true, level: 'daily', photoEnabled: true, photoDailyCap: 0 } });
        expect(photoQuotaRemaining(group, undefined)).toBe(0);
    });
});

