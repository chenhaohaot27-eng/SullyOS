// browserTaskRecovery —— 浏览器侧在途任务台账直测（对应需求 E4：后台切换/锁屏恢复/任务幂等）。
import { describe, expect, it, beforeEach } from 'vitest';
import {
    registerBrowserTask,
    settleBrowserTask,
    heartbeatBrowserTask,
    listOpenBrowserTasks,
    listStaleBrowserTasks,
    pruneBrowserTasks,
    isBrowserTaskStale,
    BROWSER_TASK_LEDGER_KEY,
    BROWSER_TASK_STALE_MS,
} from './browserTaskRecovery';

const storage = () => localStorage;

describe('登记/销账/心跳', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('登记后可列出；销账后消失；重复销账幂等', () => {
        const id = registerBrowserTask({ kind: 'photo', charId: 'c1', now: 1000 }, storage());
        expect(listOpenBrowserTasks(storage())).toHaveLength(1);
        expect(listOpenBrowserTasks(storage())[0]).toMatchObject({ kind: 'photo', charId: 'c1', startedAt: 1000 });
        settleBrowserTask(id, storage());
        settleBrowserTask(id, storage()); // 幂等
        expect(listOpenBrowserTasks(storage())).toHaveLength(0);
        expect(localStorage.getItem(BROWSER_TASK_LEDGER_KEY)).toBeNull(); // 空表不落盘
    });

    it('心跳续期：长任务不被误判为中断', () => {
        const id = registerBrowserTask({ kind: 'group-round', groupId: 'g1', now: 0 }, storage());
        const now = BROWSER_TASK_STALE_MS + 1;
        // 没心跳：按开始时刻判超时
        expect(isBrowserTaskStale(listOpenBrowserTasks(storage())[0], now)).toBe(true);
        heartbeatBrowserTask(id, storage(), now - 1000);
        // 心跳时刻 now-1000，距今仅 1000ms：不再超时
        expect(isBrowserTaskStale(listOpenBrowserTasks(storage())[0], now)).toBe(false);
    });

    it('坏数据安全回落空表', () => {
        localStorage.setItem(BROWSER_TASK_LEDGER_KEY, 'broken');
        expect(listOpenBrowserTasks(storage())).toEqual([]);
    });
});

describe('恢复检测与清理', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('listStaleBrowserTasks 按 kind/charId/groupId 过滤且只报超时的', () => {
        const now = 10_000_000;
        registerBrowserTask({ kind: 'photo', charId: 'c1', now: now - BROWSER_TASK_STALE_MS - 1 }, storage()); // 超时
        registerBrowserTask({ kind: 'photo', charId: 'c2', now: now - 1000 }, storage()); // 新鲜
        const groupTask = registerBrowserTask({ kind: 'group-round', groupId: 'g1', now: now - BROWSER_TASK_STALE_MS - 1 }, storage()); // 超时
        const stalePhotos = listStaleBrowserTasks({ kind: 'photo' }, storage(), now);
        expect(stalePhotos).toHaveLength(1);
        expect(stalePhotos[0].charId).toBe('c1');
        const staleGroup = listStaleBrowserTasks({ kind: 'group-round', groupId: 'g1' }, storage(), now);
        expect(staleGroup).toHaveLength(1);
        expect(staleGroup[0].taskId).toBe(groupTask);
        // 其他群不受牵连
        expect(listStaleBrowserTasks({ kind: 'group-round', groupId: 'g9' }, storage(), now)).toHaveLength(0);
    });

    it('pruneBrowserTasks 只清陈年记录（24h+），保留近期未销账', () => {
        const now = 100_000_000_000;
        registerBrowserTask({ kind: 'chat', charId: 'c1', now: now - 25 * 60 * 60 * 1000 }, storage());
        registerBrowserTask({ kind: 'chat', charId: 'c2', now: now - 60_000 }, storage());
        const removed = pruneBrowserTasks(storage(), now);
        expect(removed).toBe(1);
        expect(listOpenBrowserTasks(storage())).toHaveLength(1);
    });
});
