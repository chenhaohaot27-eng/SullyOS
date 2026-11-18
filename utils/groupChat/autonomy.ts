/**
 * 群聊自主活跃 —— 调度决策与状态持久化（纯逻辑 + 极小 localStorage 状态）。
 *
 * 定位：复用单聊 ProactiveChat「持久化计划 + 前台定时器 + 可见性追赶」的思路，但完全
 * 按群聊独立管理：每个群一份状态（下次检查时刻、上次自主轮时间、当天图片用量），
 * 互不影响。所有涉及「是否该触发、间隔多长、配额还剩多少」的判定都是纯函数，方便直测；
 * 真正的生成由 GroupChat 组件回调执行（复用导演模式管线）。
 *
 * 间隔与保护（对应需求 B3/B6）：
 *   - 轻度 light：2–4 小时随机检查一次
 *   - 日常 daily：1–2 小时随机检查一次
 *   - 热闹 lively：30–60 分钟随机检查一次
 *   - 调度时刻加随机抖动；夜间（23:00–07:00 本地）静默，检查点顺延到次日早晨；
 *   - 群级冷却：两次自主轮之间至少 GROUP_AUTONOMY_COOLDOWN_MS；
 *   - 用户刚在群里说话（USER_ACTIVITY_QUIET_MS 内）不抢戏，留给手动闪电；
 *   - 最大连续消息保护：单轮上限 MAX_MESSAGES_PER_AUTONOMY_ROUND。
 *
 * 前台运行与云端任务共用同一套状态记录与去重键（见 autonomyPhoto 的配额与
 * browserTaskRecovery 的任务台账），不另起炉灶。
 */

import type { GroupAutonomyConfig, GroupAutonomyLevel, GroupProfile, Message } from '../../types';

// ─── 活跃程度与间隔 ─────────────────────────────────────

export const GROUP_AUTONOMY_LEVELS: Record<GroupAutonomyLevel, { label: string; minMs: number; maxMs: number }> = {
    light: { label: '轻度（每 2–4 小时）', minMs: 2 * 60 * 60 * 1000, maxMs: 4 * 60 * 60 * 1000 },
    daily: { label: '日常（每 1–2 小时）', minMs: 1 * 60 * 60 * 1000, maxMs: 2 * 60 * 60 * 1000 },
    lively: { label: '热闹（每 30–60 分钟）', minMs: 30 * 60 * 1000, maxMs: 60 * 60 * 1000 },
};

export const DEFAULT_GROUP_AUTONOMY_LEVEL: GroupAutonomyLevel = 'daily';

/** 容忍旧数据/手改数据里的坏 level。 */
export function normalizeGroupAutonomyLevel(value: unknown): GroupAutonomyLevel {
    return value === 'light' || value === 'lively' ? value : DEFAULT_GROUP_AUTONOMY_LEVEL;
}

/** 单次检查间隔（含随机抖动）。rand 只在测试里注入，运行时用 Math.random。 */
export function autonomyIntervalMs(level: GroupAutonomyLevel, rand: () => number = Math.random): number {
    const { minMs, maxMs } = GROUP_AUTONOMY_LEVELS[normalizeGroupAutonomyLevel(level)];
    return Math.round(minMs + (maxMs - minMs) * Math.min(1, Math.max(0, rand())));
}

// ─── 夜间静默 ───────────────────────────────────────────

export const NIGHT_QUIET_START_HOUR = 23;
export const NIGHT_QUIET_END_HOUR = 7;

/** 是否落在夜间静默窗（23:00–次日 07:00，按设备本地钟）。 */
export function isNightQuietTime(date: Date): boolean {
    const hour = date.getHours();
    return hour >= NIGHT_QUIET_START_HOUR || hour < NIGHT_QUIET_END_HOUR;
}

/**
 * 计算下一次检查时刻：from + 随机间隔；若落进夜间静默窗，顺延到次日早晨
 * （NIGHT_QUIET_END_HOUR 点起再加 0–60 分钟随机抖动，避免整点齐发）。
 */
export function nextAutonomyCheckAt(level: GroupAutonomyLevel, from: number, rand: () => number = Math.random): number {
    const candidate = from + autonomyIntervalMs(level, rand);
    const candidateDate = new Date(candidate);
    if (!isNightQuietTime(candidateDate)) return candidate;
    const morning = new Date(candidateDate);
    // 当天还没过 07:00 → 就是今天早上；否则（已过 23:00）是第二天早上
    morning.setDate(candidateDate.getHours() >= NIGHT_QUIET_START_HOUR ? candidateDate.getDate() + 1 : candidateDate.getDate());
    morning.setHours(NIGHT_QUIET_END_HOUR, 0, 0, 0);
    return morning.getTime() + Math.round(rand() * 60 * 60 * 1000);
}

// ─── 冷却与保护 ─────────────────────────────────────────

/** 两次自主轮之间的群级最小间隔。 */
export const GROUP_AUTONOMY_COOLDOWN_MS = 10 * 60 * 1000;
/** 用户在群里发言后多久内不触发自主轮（避免抢戏；手动闪电不受限）。 */
export const USER_ACTIVITY_QUIET_MS = 15 * 60 * 1000;
/** 单轮自主消息条数上限（最大连续消息保护）。 */
export const MAX_MESSAGES_PER_AUTONOMY_ROUND = 4;
/** 默认每群每天自主生图上限。 */
export const DEFAULT_GROUP_PHOTO_DAILY_CAP = 2;

// ─── 状态持久化 ─────────────────────────────────────────

export const GROUP_AUTONOMY_STATE_KEY = 'group_autonomy_state_v1';

export interface GroupAutonomyStateEntry {
    /** 下次检查时刻（epoch ms）。 */
    nextCheckAt: number;
    /** 上一次自主轮触发时刻（无论当轮是否有人发言）。 */
    lastRoundAt: number;
    /** 图片用量：dayKey(本地 YYYY-MM-DD) → 当天已生成的自主图片数。 */
    photoUsage?: Record<string, number>;
}

export type GroupAutonomyState = Record<string, GroupAutonomyStateEntry>;

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function loadGroupAutonomyState(storage: StorageLike = localStorage): GroupAutonomyState {
    try {
        const parsed = JSON.parse(storage.getItem(GROUP_AUTONOMY_STATE_KEY) || '{}');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const result: GroupAutonomyState = {};
        for (const [groupId, value] of Object.entries(parsed as Record<string, unknown>)) {
            const record = value as Partial<GroupAutonomyStateEntry> | null;
            if (record && typeof record.nextCheckAt === 'number' && typeof record.lastRoundAt === 'number') {
                result[groupId] = {
                    nextCheckAt: record.nextCheckAt,
                    lastRoundAt: record.lastRoundAt,
                    photoUsage: record.photoUsage && typeof record.photoUsage === 'object' ? record.photoUsage : {},
                };
            }
        }
        return result;
    } catch {
        return {};
    }
}

export function saveGroupAutonomyState(state: GroupAutonomyState, storage: StorageLike = localStorage): void {
    try {
        if (Object.keys(state).length === 0) storage.removeItem(GROUP_AUTONOMY_STATE_KEY);
        else storage.setItem(GROUP_AUTONOMY_STATE_KEY, JSON.stringify(state));
    } catch { /* 存储满/隐私模式：调度停摆比整页崩溃好 */ }
}

/** 群配置缺省视为关闭。 */
export function isGroupAutonomyEnabled(group: Pick<GroupProfile, 'autonomyConfig'>): boolean {
    return group.autonomyConfig?.enabled === true;
}

/** 本地时区 dayKey（YYYY-MM-DD），图片配额按它滚动。 */
export function autonomyDayKey(now: Date = new Date()): string {
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

/** 当天已用自主图片数。 */
export function photoQuotaUsed(entry: GroupAutonomyStateEntry | undefined, now: Date = new Date()): number {
    const key = autonomyDayKey(now);
    return entry?.photoUsage?.[key] || 0;
}

export function groupPhotoDailyCap(group: Pick<GroupProfile, 'autonomyConfig'>): number {
    const cap = group.autonomyConfig?.photoDailyCap;
    return typeof cap === 'number' && Number.isFinite(cap) && cap >= 0 ? Math.floor(cap) : DEFAULT_GROUP_PHOTO_DAILY_CAP;
}

/** 当天剩余自主图片配额。 */
export function photoQuotaRemaining(
    group: Pick<GroupProfile, 'autonomyConfig'>,
    entry: GroupAutonomyStateEntry | undefined,
    now: Date = new Date(),
): number {
    return Math.max(0, groupPhotoDailyCap(group) - photoQuotaUsed(entry, now));
}

/**
 * 消耗一张配额（生成尝试即消耗——请求可能已计费，失败不返还，避免反复扣费）。
 * 返回消耗后的完整 state（新对象，调用方负责写回）。
 */
export function consumePhotoQuota(
    state: GroupAutonomyState,
    groupId: string,
    now: Date = new Date(),
): GroupAutonomyState {
    const key = autonomyDayKey(now);
    const entry = state[groupId] || { nextCheckAt: 0, lastRoundAt: 0, photoUsage: {} };
    const usage = { ...(entry.photoUsage || {}) };
    usage[key] = (usage[key] || 0) + 1;
    return { ...state, [groupId]: { ...entry, photoUsage: usage } };
}

// ─── 触发判定（纯函数核心）──────────────────────────────

export interface AutonomyDueCheck {
    due: boolean;
    reason?: string;
}

/**
 * 判断某个群此刻是否该触发自主轮。所有保护按顺序过：
 * 开关 → 到点 → 冷却 → 夜间静默 → 用户刚发言。
 */
export function checkGroupAutonomyDue(
    group: Pick<GroupProfile, 'id' | 'autonomyConfig'>,
    state: GroupAutonomyState,
    now: Date = new Date(),
    lastUserMessageAt: number | null = null,
): AutonomyDueCheck {
    if (!isGroupAutonomyEnabled(group)) return { due: false, reason: 'disabled' };
    const entry = state[group.id];
    if (!entry || !entry.nextCheckAt) return { due: false, reason: 'no-schedule' };
    if (entry.nextCheckAt > now.getTime()) return { due: false, reason: 'not-yet' };
    if (now.getTime() - entry.lastRoundAt < GROUP_AUTONOMY_COOLDOWN_MS) return { due: false, reason: 'cooldown' };
    if (isNightQuietTime(now)) return { due: false, reason: 'night-quiet' };
    if (lastUserMessageAt !== null && now.getTime() - lastUserMessageAt < USER_ACTIVITY_QUIET_MS) {
        return { due: false, reason: 'user-active' };
    }
    return { due: true };
}

/** 最近一条用户群消息的时间戳（没有则 null）。 */
export function lastUserGroupMessageAt(messages: Pick<Message, 'role' | 'timestamp'>[]): number | null {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i].role === 'user') return messages[i].timestamp;
    }
    return null;
}

/**
 * 触发后写账：记录本轮时刻并排下一次检查（带抖动 + 夜间顺延）。
 * 上限截断（最大连续消息保护）由调用方在派发前执行（capAutonomyActions）。
 */
export function recordGroupAutonomyRound(
    state: GroupAutonomyState,
    groupId: string,
    level: GroupAutonomyLevel,
    now: number = Date.now(),
    rand: () => number = Math.random,
): GroupAutonomyState {
    const entry = state[groupId] || { nextCheckAt: 0, lastRoundAt: 0 };
    return {
        ...state,
        [groupId]: {
            ...entry,
            lastRoundAt: now,
            nextCheckAt: nextAutonomyCheckAt(level, now, rand),
        },
    };
}

/** 群配置变化时补/清调度入口：没 entry 就建一个（从现在起算首次检查）。 */
export function ensureGroupAutonomyEntry(
    state: GroupAutonomyState,
    groupId: string,
    config: GroupAutonomyConfig | undefined,
    now: number = Date.now(),
    rand: () => number = Math.random,
): GroupAutonomyState {
    if (!config?.enabled) {
        if (!(groupId in state)) return state;
        // 开关关掉：清掉该群状态（保留其他群）。
        const next = { ...state };
        delete next[groupId];
        return next;
    }
    if (state[groupId]) return state;
    const level = normalizeGroupAutonomyLevel(config.level);
    return {
        ...state,
        [groupId]: {
            nextCheckAt: nextAutonomyCheckAt(level, now, rand),
            lastRoundAt: 0,
            photoUsage: {},
        },
    };
}

/** 截断单轮动作数（最大连续消息保护）。 */
export function capAutonomyActions<T>(actions: T[], max = MAX_MESSAGES_PER_AUTONOMY_ROUND): T[] {
    return actions.slice(0, max);
}

// ─── 前台调度器（薄壳：定时器 + 可见性，逻辑全在上面纯函数里）───

export interface GroupAutonomySchedulerOptions {
    /** 拿当前全部群（含配置）。 */
    getGroups: () => Pick<GroupProfile, 'id' | 'autonomyConfig'>[];
    /** 某个群到点后的回调（执行自主轮）。 */
    onRound: (groupId: string) => Promise<void>;
    /** 拉某个群的近期消息（判定用户活跃度用）。 */
    getGroupMessages?: (groupId: string) => Promise<Pick<Message, 'role' | 'timestamp'>[]>;
    /** 轮询间隔，默认 60s。 */
    tickMs?: number;
    storage?: StorageLike;
    now?: () => Date;
    rand?: () => number;
}

/**
 * 前台调度器单例。页面打开期间每分钟检查一次到点的群；document.hidden 时跳过
 * （iOS Safari 后台定时器不可靠——nextCheckAt 是持久化事实，回前台后下一次 tick
 * 自然补上，最多补一轮，不会连环爆发）。
 */
class GroupAutonomySchedulerImpl {
    private timer: ReturnType<typeof setInterval> | null = null;
    private running = false;
    private opts: GroupAutonomySchedulerOptions | null = null;
    private visibilityHandler: (() => void) | null = null;

    start(opts: GroupAutonomySchedulerOptions): void {
        this.stop();
        this.opts = opts;
        this.running = true;
        this.timer = setInterval(() => void this.tick(), opts.tickMs ?? 60_000);
        if (typeof document !== 'undefined') {
            this.visibilityHandler = () => { if (!document.hidden) void this.tick(); };
            document.addEventListener('visibilitychange', this.visibilityHandler);
        }
        void this.tick();
    }

    stop(): void {
        this.running = false;
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
        if (this.visibilityHandler && typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', this.visibilityHandler);
            this.visibilityHandler = null;
        }
        this.opts = null;
    }

    isRunning(): boolean {
        return this.running;
    }

    /** 单次检查。串行处理到点的群，避免多群并发生成互相抢 API 配额。 */
    async tick(): Promise<void> {
        const opts = this.opts;
        if (!opts || !this.running) return;
        if (typeof document !== 'undefined' && document.hidden) return;
        const storage = opts.storage ?? localStorage;
        const now = opts.now ?? (() => new Date());
        let state = loadGroupAutonomyState(storage);
        // 先给所有开着自主活跃的群补 entry（新建/导入的群首次纳入调度）
        for (const group of opts.getGroups()) {
            state = ensureGroupAutonomyEntry(state, group.id, group.autonomyConfig, now().getTime(), opts.rand);
        }
        saveGroupAutonomyState(state, storage);
        for (const group of opts.getGroups()) {
            let lastUserAt: number | null = null;
            if (opts.getGroupMessages) {
                try {
                    lastUserAt = lastUserGroupMessageAt(await opts.getGroupMessages(group.id));
                } catch { /* 拉不到消息就当没有用户活跃信号，不阻塞判定 */ }
            }
            const check = checkGroupAutonomyDue(group, state, now(), lastUserAt);
            if (!check.due) continue;
            // 先重排（无论回调成败，本轮到点已消费；失败不重试，等下一个检查点）
            state = recordGroupAutonomyRound(state, group.id, normalizeGroupAutonomyLevel(group.autonomyConfig?.level), now().getTime(), opts.rand);
            saveGroupAutonomyState(state, storage);
            try {
                await opts.onRound(group.id);
            } catch (error) {
                console.warn('[GroupAutonomy] 自主轮执行失败（等下一个检查点）', { groupId: group.id, error });
            }
        }
    }
}

export const GroupAutonomyScheduler = new GroupAutonomySchedulerImpl();

