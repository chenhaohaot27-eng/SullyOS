import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

describe('锁屏密码：会话锁定行为', () => {
    beforeEach(async () => {
        await setupPinLock(PIN, PIN);
    });

    it('页面新会话（刷新 / 重开）时重新锁定', async () => {
        // 首次进入：需要验证
        expect(isPinGateActive()).toBe(true);

        // 输入正确密码解锁
        expect(await verifyPin(PIN)).toBe(true);
        markSessionUnlocked();
        expect(isSessionUnlocked()).toBe(true);
        expect(isPinGateActive()).toBe(false);

        // 模拟刷新 / 关闭后重开：新会话 → 重新上锁
        startNewSession();
        expect(isSessionUnlocked()).toBe(false);
        expect(isPinGateActive()).toBe(true);
    });

    it('解锁状态只写 sessionStorage，绝不写 localStorage', async () => {
        expect(isPinGateActive()).toBe(true);
        markSessionUnlocked();
        expect(isSessionUnlocked()).toBe(true);
        // localStorage 里除密码配置外不允许出现任何「已解锁」标记
        const storedKeys: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k) storedKeys.push(k);
        }
        expect(storedKeys).toEqual(['sullyos_pin_lock_v1']);
        expect(localStorage.getItem('sullyos_pin_unlocked_v1')).toBeNull();
        expect(localStorage.getItem('sullyos_pin_unlocked')).toBeNull();
    });

    it('已解锁的同一会话内不重复弹密码', async () => {
        expect(await verifyPin(PIN)).toBe(true);
        markSessionUnlocked();
        // 会话内反复查询（模拟在微信 / 见面 / 设置 / 相册等 App 间切换）
        for (let i = 0; i < 5; i++) {
            expect(isPinGateActive()).toBe(false);
        }
        // 密码仍然有效（只是不再要求重输）
        expect(await verifyPin(PIN)).toBe(true);
    });

    it('锁屏关闭时不会出现锁屏门', async () => {
        await disablePinLock(PIN);
        startNewSession(); // 即使换了新会话
        expect(isPinLockEnabled()).toBe(false);
        expect(isPinGateActive()).toBe(false);
    });
});
