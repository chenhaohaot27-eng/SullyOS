/** Shared across tabs where Web Locks is available; fail visibly rather than race. */
let readers = 0;
let deleting = false;
export async function withMemoryMutation<T>(task: () => Promise<T>, exclusive = false): Promise<T> {
    const run = async () => {
        if (deleting || (exclusive && readers)) throw new Error('记忆提取、消化或同步正在运行，请完成后重试删除。');
        if (exclusive) deleting = true; else readers++;
        try { return await task(); }
        finally { if (exclusive) deleting = false; else readers--; }
    };
    if (typeof navigator !== 'undefined' && navigator.locks) {
        return navigator.locks.request('sully-memory-mutation', {
            mode: exclusive ? 'exclusive' : 'shared', ifAvailable: true,
        }, lock => {
            if (!lock) throw new Error('其他页面正在处理记忆，请稍后重试。');
            return run();
        });
    }
    return run();
}
