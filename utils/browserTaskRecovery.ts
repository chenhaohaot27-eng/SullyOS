/**
 * browserTaskRecovery — 浏览器侧在途任务台账（A 类后台恢复的统一登记处）。
 *
 * 背景：云端即时对话（amsgInstantChat）有自己的待收记录与服务端账本，恢复闭环完整；
 * 但**直接从浏览器发出**的请求（本地聊天生成、聊天拍照、群聊导演/轮询轮）一旦页面
 * 切后台/锁屏/刷新，fetch 是否已到达上游、是否已计费，客户端永远无法确定。
 *
 * 本模块只做三件事，不猜测、不自动重发：
 *   1. 发起前登记（kind + 归属 + 开始时刻），完成后销账——台账落 localStorage，扛得住刷新；
 *   2. 回到页面时列出未销账任务：超过冷静期仍未销账的，交由调用方按「结果待确认」
 *      处理（拍照消息翻成 failed+手动重试；聊天/群轮指示灯随组件重挂载自然熄灭）；
 *   3. 陈年记录自动清理，台账不无限膨胀。
 *
 * 纪律（对应需求 A4/E）：生成接口（imageGenerationService 及各聊天 API）当前都是
 * 同步请求/响应协议，**没有异步任务 ID 可查**；因此绝不自动重发在途任务——重复扣费
 * 的风险永远由用户手动重试来承担知情权。
 */

export type BrowserTaskKind = 'chat' | 'photo' | 'group-round';

export interface BrowserTaskRecord {
    taskId: string;
    kind: BrowserTaskKind;
    /** 归属角色（photo/chat）或群（group-round）；排查用。 */
    charId?: string;
    groupId?: string;
    /** 发起时刻（epoch ms）。 */
    startedAt: number;
    /** 最近一次仍在途的确认时刻（调用方可在长任务中续期）。 */
    heartbeatAt?: number;
}

export const BROWSER_TASK_LEDGER_KEY = 'browser_task_recovery_v1';

/** 超过这个时长仍未销账的任务视为「结果待确认」（拍照生成超时上限 300s，取宽裕值）。 */
export const BROWSER_TASK_STALE_MS = 10 * 60 * 1000;

type Ledger = Record<string, BrowserTaskRecord>;

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const readLedger = (storage: StorageLike): Ledger => {
    try {
        const parsed = JSON.parse(storage.getItem(BROWSER_TASK_LEDGER_KEY) || '{}');
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Ledger : {};
    } catch {
        return {};
    }
};

const writeLedger = (ledger: Ledger, storage: StorageLike): void => {
    try {
        if (Object.keys(ledger).length === 0) storage.removeItem(BROWSER_TASK_LEDGER_KEY);
        else storage.setItem(BROWSER_TASK_LEDGER_KEY, JSON.stringify(ledger));
    } catch { /* 写不进就算了：恢复提示缺失比任务本身失败好 */ }
};

const makeTaskId = (): string => (
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `btask-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
);

/** 发起浏览器侧任务前登记。返回 taskId，调用方在完成/失败时 settleBrowserTask。 */
export function registerBrowserTask(
    input: { kind: BrowserTaskKind; charId?: string; groupId?: string; now?: number },
    storage: StorageLike = localStorage,
): string {
    const ledger = readLedger(storage);
    const taskId = makeTaskId();
    const now = input.now ?? Date.now();
    ledger[taskId] = {
        taskId,
        kind: input.kind,
        charId: input.charId,
        groupId: input.groupId,
        startedAt: now,
        heartbeatAt: now,
    };
    writeLedger(ledger, storage);
    return taskId;
}

/** 任务结束（成功或明确失败）后销账。未知 taskId 静默忽略（幂等）。 */
export function settleBrowserTask(taskId: string, storage: StorageLike = localStorage): void {
    const ledger = readLedger(storage);
    if (!(taskId in ledger)) return;
    delete ledger[taskId];
    writeLedger(ledger, storage);
}

/** 长任务中途续期（仍在前台正常执行，别被恢复逻辑误判成中断）。 */
export function heartbeatBrowserTask(taskId: string, storage: StorageLike = localStorage, now: number = Date.now()): void {
    const ledger = readLedger(storage);
    const record = ledger[taskId];
    if (!record) return;
    record.heartbeatAt = now;
    writeLedger(ledger, storage);
}

export function listOpenBrowserTasks(storage: StorageLike = localStorage): BrowserTaskRecord[] {
    return Object.values(readLedger(storage));
}

/** 是否已超过冷静期（心跳/开始时刻起算）。 */
export function isBrowserTaskStale(record: BrowserTaskRecord, now: number = Date.now(), staleMs = BROWSER_TASK_STALE_MS): boolean {
    const anchor = Math.max(record.startedAt, record.heartbeatAt || 0);
    return now - anchor > staleMs;
}

/** 清掉陈年记录（超过 maxAge 的直接删）。返回清理后的条数。 */
export function pruneBrowserTasks(storage: StorageLike = localStorage, now: number = Date.now(), maxAgeMs = 24 * 60 * 60 * 1000): number {
    const ledger = readLedger(storage);
    let removed = 0;
    for (const [taskId, record] of Object.entries(ledger)) {
        if (now - record.startedAt > maxAgeMs) {
            delete ledger[taskId];
            removed += 1;
        }
    }
    if (removed > 0) writeLedger(ledger, storage);
    return removed;
}

/**
 * 回到页面时的恢复检测：列出超时未销账的任务（按 kind 过滤）。
 * 调用方据此把对应的 pending 消息翻成「结果待确认」并给手动重试；本模块不碰消息库。
 */
export function listStaleBrowserTasks(
    filter: { kind?: BrowserTaskKind; charId?: string; groupId?: string },
    storage: StorageLike = localStorage,
    now: number = Date.now(),
    staleMs = BROWSER_TASK_STALE_MS,
): BrowserTaskRecord[] {
    return listOpenBrowserTasks(storage).filter(record => {
        if (filter.kind && record.kind !== filter.kind) return false;
        if (filter.charId && record.charId !== filter.charId) return false;
        if (filter.groupId && record.groupId !== filter.groupId) return false;
        return isBrowserTaskStale(record, now, staleMs);
    });
}
