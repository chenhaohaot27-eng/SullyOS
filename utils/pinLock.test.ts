import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    PIN_LENGTH,
    __resetPinLockSessionForTests,
    changePinLock,
    disablePinLock,
    isPinLockEnabled,
    isPinGateActive,
    isSessionUnlocked,
    isValidPin,
    markSessionUnlocked,
    setupPinLock,
    verifyPin,
} from './pinLock';

const PIN = '135790';
const OTHER_PIN = '246810';

/** 模拟「新会话」（刷新 / 关标签重开 / PWA 重进）。 */
const startNewSession = () => __resetPinLockSessionForTests();

const clearAll = () => {
    localStorage.clear();
    startNewSession();
};

beforeEach(clearAll);
afterEach(clearAll);

describe('锁屏密码：开启与校验', () => {
    it('默认未开启（旧用户无数据时自然兼容）', () => {
        expect(isPinLockEnabled()).toBe(false);
        expect(isPinGateActive()).toBe(false);
    });

    it('只允许 6 位纯数字密码', async () => {
        expect(isValidPin('12345')).toBe(false);
        expect(isValidPin('1234567')).toBe(false);
        expect(isValidPin('12345a')).toBe(false);
        expect(isValidPin('abc')).toBe(false);
        expect(isValidPin(PIN)).toBe(true);
        expect(PIN_LENGTH).toBe(6);

        for (const bad of ['12345', '1234567', '12345a', '']) {
            const r = await setupPinLock(bad, bad);
            expect(r.ok).toBe(false);
        }
        expect(isPinLockEnabled()).toBe(false);
    });

    it('两次新密码不一致不能保存', async () => {
        const r = await setupPinLock(PIN, OTHER_PIN);
        expect(r.ok).toBe(false);
        expect(!r.ok && r.error).toBe('两次输入的密码不一致');
        expect(isPinLockEnabled()).toBe(false);
    });

    it('开启后 localStorage 只存 salt/hash，不存明文 PIN', async () => {
        const r = await setupPinLock(PIN, PIN);
        expect(r.ok).toBe(true);
        expect(isPinLockEnabled()).toBe(true);
        const raw = localStorage.getItem('sullyos_pin_lock_v1')!;
        expect(raw).toBeTruthy();
        expect(raw).not.toContain(PIN);
        const parsed = JSON.parse(raw);
        expect(parsed.enabled).toBe(true);
        expect(parsed.salt).toMatch(/^[0-9a-f]{32}$/);
        expect(parsed.hash).toMatch(/^[0-9a-f]{64}$/);
        expect(parsed.iterations).toBeGreaterThan(0);
    });

    it('正确密码可以解锁，错误密码不能解锁', async () => {
        await setupPinLock(PIN, PIN);
        expect(await verifyPin(PIN)).toBe(true);
        expect(await verifyPin(OTHER_PIN)).toBe(false);
        expect(await verifyPin('000000')).toBe(false);
        expect(await verifyPin('12345')).toBe(false); // 非 6 位
    });
});

describe('锁屏密码：修改与关闭', () => {
    beforeEach(async () => {
        await setupPinLock(PIN, PIN);
    });

    it('修改密码必须先验对旧密码', async () => {
        const wrong = await changePinLock('000000', OTHER_PIN, OTHER_PIN);
        expect(wrong.ok).toBe(false);
        expect(!wrong.ok && wrong.error).toBe('当前密码错误');
        // 旧密码验不过去 → 密码不能被改掉，旧密码仍有效
        expect(await verifyPin(PIN)).toBe(true);
        expect(await verifyPin(OTHER_PIN)).toBe(false);

        // 新密码两次不一致也不能改
        const mismatch = await changePinLock(PIN, OTHER_PIN, '999999');
        expect(mismatch.ok).toBe(false);
        expect(await verifyPin(OTHER_PIN)).toBe(false);

        // 正确流程：旧密码 + 新密码两次一致
        const ok = await changePinLock(PIN, OTHER_PIN, OTHER_PIN);
        expect(ok.ok).toBe(true);
        expect(await verifyPin(PIN)).toBe(false); // 旧密码失效
        expect(await verifyPin(OTHER_PIN)).toBe(true); // 新密码生效
    });

    it('关闭密码必须先验对旧密码', async () => {
        const wrong = await disablePinLock('000000');
        expect(wrong.ok).toBe(false);
        expect(!wrong.ok && wrong.error).toBe('当前密码错误');
        expect(isPinLockEnabled()).toBe(true);

        const ok = await disablePinLock(PIN);
        expect(ok.ok).toBe(true);
        expect(isPinLockEnabled()).toBe(false);
        expect(isPinGateActive()).toBe(false); // 关闭后不再出现锁屏
    });
});

describe('锁屏密码：会话锁定行为（解锁状态只存当前 JS 页面生命周期的内存）', () => {
    /**
     * 真实浏览器的生命周期（本组测试对齐的设计）：
     *  - 刷新 / 关标签重开 / PWA 重进 = 销毁旧 JS 上下文并创建全新的（内存必清零）；
     *  - SPA 内部切 App = 同一 JS 上下文内的组件导航（模块内存保留）。
     * 因此解锁标记只放模块级变量，不依赖 sessionStorage —— 它在同标签页刷新后
     * 并不清空，靠它做「会话已解锁」会把解锁状态泄漏到刷新之后。
     * 测试里用 vi.resetModules() + 重新动态 import 来忠实模拟「新 JS 上下文」，
     * 而不是只调用 __resetPinLockSessionForTests 复位同一个实例。
     */

    beforeEach(async () => {
        localStorage.clear();
        __resetPinLockSessionForTests();
        vi.resetModules();
        await setupPinLock(PIN, PIN);
    });

    it('模拟真实刷新（重新加载 JS 上下文）：解锁状态消失，重新上锁', async () => {
        // 页面 A：输入正确密码并解锁
        const pageA = await import('./pinLock');
        expect(await pageA.verifyPin(PIN)).toBe(true);
        pageA.markSessionUnlocked();
        expect(pageA.isSessionUnlocked()).toBe(true);
        expect(pageA.isPinGateActive()).toBe(false);

        // 刷新 = 销毁旧 JS 上下文、创建新 JS 上下文（重新加载模块）。
        // localStorage 里的 PIN 配置仍在（重新上锁的前提），内存里的解锁标记不复存在。
        vi.resetModules();
        const pageB = await import('./pinLock');
        expect(pageB.isSessionUnlocked()).toBe(false);
        expect(pageB.isPinLockEnabled()).toBe(true);
        expect(pageB.isPinGateActive()).toBe(true);
        // 新页面里 PIN 仍然有效，但必须重新验证一次才能开门
        expect(await pageB.verifyPin(PIN)).toBe(true);
        expect(pageB.isPinGateActive()).toBe(true);
        pageB.markSessionUnlocked();
        expect(pageB.isPinGateActive()).toBe(false);
    });

    it('关闭后重开（同样是全新 JS 上下文）：重新上锁', async () => {
        const pageA = await import('./pinLock');
        pageA.markSessionUnlocked();
        expect(pageA.isPinGateActive()).toBe(false);
        vi.resetModules();
        const pageB = await import('./pinLock');
        expect(pageB.isPinGateActive()).toBe(true);
    });

    it('解锁状态不落到任何持久存储：不写 localStorage，也不读写 sessionStorage', async () => {
        const ss = {
            getItem: vi.fn((): string | null => null),
            setItem: vi.fn(),
            removeItem: vi.fn(),
            clear: vi.fn(),
            key: vi.fn((): string | null => null),
            length: 0,
        };
        const hadSS = Object.prototype.hasOwnProperty.call(globalThis, 'sessionStorage');
        const origSS = (globalThis as any).sessionStorage;
        (globalThis as any).sessionStorage = ss;
        try {
            vi.resetModules();
            const page = await import('./pinLock');
            await page.setupPinLock(PIN, PIN);
            page.markSessionUnlocked();
            expect(page.isSessionUnlocked()).toBe(true);
            // 即使 sessionStorage 存在也完全不碰（防回归：一旦开始用它，
            // 同标签页刷新后 sessionStorage 仍保留旧值，锁会失效）
            expect(ss.getItem).not.toHaveBeenCalled();
            expect(ss.setItem).not.toHaveBeenCalled();
            expect(ss.removeItem).not.toHaveBeenCalled();
            expect(localStorage.getItem('sullyos_pin_unlocked_v1')).toBeNull();
            // localStorage 里只有 PIN 配置（enabled/salt/hash/iterations），没有解锁标记
            const storedKeys: string[] = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k) storedKeys.push(k);
            }
            expect(storedKeys).toEqual(['sullyos_pin_lock_v1']);
        } finally {
            if (hadSS) (globalThis as any).sessionStorage = origSS;
            else delete (globalThis as any).sessionStorage;
        }
    });

    it('同一页面内（SPA 切换 App）不重复弹密码', async () => {
        expect(await verifyPin(PIN)).toBe(true);
        markSessionUnlocked();
        // 同一 JS 上下文内反复查询（模拟在微信 / 见面 / 设置 / 相册等 App 间切换）
        for (let i = 0; i < 5; i++) {
            expect(isPinGateActive()).toBe(false);
        }
        // 密码仍然有效（只是本次打开期间不再要求重输）
        expect(await verifyPin(PIN)).toBe(true);
    });

    it('锁屏关闭时不会出现锁屏门', async () => {
        await disablePinLock(PIN);
        __resetPinLockSessionForTests(); // 即使换了新会话 / 新页面
        expect(isPinLockEnabled()).toBe(false);
        expect(isPinGateActive()).toBe(false);
    });
});
