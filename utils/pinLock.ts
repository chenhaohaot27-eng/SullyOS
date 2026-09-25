/**
 * pinLock.ts
 * 本地锁屏密码（6 位数字 PIN）的核心逻辑 + 持久化。
 *
 * 设计约束（见需求）：
 *  - 密码验证完全在本机完成，不调用任何聊天 API，不消耗 token，不上传服务器。
 *  - 不明文保存 PIN：Web Crypto PBKDF2-SHA256 + random salt，localStorage 只存
 *    { enabled, salt(hex), hash(hex), iterations }。
 *  - 「本次是否已解锁」只存当前 JS 页面生命周期的内存（模块级变量）：
 *      · 刷新 / 关标签重开 / PWA 重进 = 创建全新 JS 上下文，内存清零 → 重新上锁；
 *      · SPA 内部切 App 不刷新页面，模块内存保留 → 不重复验证。
 *    （不用 sessionStorage：它只在「标签页关闭」时清空，同标签页刷新后仍保留，
 *      「刷新后重新锁定」会失效。）
 *  - 旧用户没有任何相关数据时自然视为「锁屏关闭」，零额外步骤。
 *
 * 自包含模块（不进 OSContext），对齐 backupReminder.ts 的写法。
 */

export const PIN_LENGTH = 6;

const STORAGE_KEY = 'sullyos_pin_lock_v1';

/** PBKDF2 迭代次数。本地验证 6 位 PIN 足够，同时保证手机上毫秒级完成。 */
const PBKDF2_ITERATIONS = 100000;

export interface PinLockStoredConfig {
    enabled: true;
    /** 随机盐，hex。 */
    salt: string;
    /** PBKDF2 派生的密钥，hex。 */
    hash: string;
    iterations: number;
}

export type PinLockResult = { ok: true } | { ok: false; error: string };

/* ───────── 持久化（localStorage / sessionStorage，全部容错） ───────── */

const readStoredConfig = (): PinLockStoredConfig | null => {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (
            !parsed ||
            parsed.enabled !== true ||
            typeof parsed.salt !== 'string' ||
            typeof parsed.hash !== 'string' ||
            !Number.isFinite(parsed.iterations) ||
            parsed.iterations <= 0
        ) {
            return null;
        }
        return parsed as PinLockStoredConfig;
    } catch {
        return null;
    }
};

const writeStoredConfig = (config: PinLockStoredConfig | null): void => {
    try {
        if (config) localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
        else localStorage.removeItem(STORAGE_KEY);
    } catch { /* 隐私模式等存不进去：锁屏功能视为不可用，不影响其他数据 */ }
};

/* ───────── 会话解锁状态：只存当前 JS 页面生命周期的内存 ─────────
 * 刷新 / 关标签 / PWA 重进都会销毁整个 JS 上下文（内存必清零，比任何 storage 事件都可靠），
 * 而 SPA 内部切换 App 只是组件级导航，不重载模块 → 状态保留，不重复弹密码。
 * 不读不写 localStorage / sessionStorage，天然不会被持久化。 */
let sessionUnlocked = false;

/* ───────── 密码派生与校验（Web Crypto PBKDF2-SHA256） ───────── */

const toHex = (buf: ArrayBuffer): string =>
    Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');

const fromHex = (hex: string): Uint8Array => {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
};

/** 长度不等直接 false；等长时逐字符异或汇总，避免普通 === 的早退时序差。 */
const timingSafeEqualHex = (a: string, b: string): boolean => {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
};

const derivePinHash = async (pin: string, saltHex: string, iterations: number): Promise<string> => {
    const subtle = (globalThis as any).crypto?.subtle;
    if (!subtle) throw new Error('Web Crypto 不可用');
    const keyMaterial = await subtle.importKey(
        'raw',
        new TextEncoder().encode(pin),
        { name: 'PBKDF2' },
        false,
        ['deriveBits'],
    );
    const bits = await subtle.deriveBits(
        { name: 'PBKDF2', hash: 'SHA-256', salt: fromHex(saltHex), iterations },
        keyMaterial,
        256,
    );
    return toHex(bits as ArrayBuffer);
};

/** 16 字节随机盐（hex）。 */
const randomSaltHex = (): string | null => {
    const cryptoObj = (globalThis as any).crypto;
    if (!cryptoObj || typeof cryptoObj.getRandomValues !== 'function') return null;
    return toHex(cryptoObj.getRandomValues(new Uint8Array(16)).buffer as ArrayBuffer);
};

/* ───────── 对外 API ───────── */

/** 只允许 6 位纯数字。 */
export const isValidPin = (pin: unknown): pin is string =>
    typeof pin === 'string' && new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin);

/** 锁屏密码是否已开启（旧用户无数据 → false）。 */
export const isPinLockEnabled = (): boolean => readStoredConfig() !== null;

/** 本次页面会话是否已解锁过（仅 JS 内存；刷新 / 关闭页面即消失）。 */
export const isSessionUnlocked = (): boolean => sessionUnlocked;

/** 验证通过后调用：本次页面生命周期内不再弹锁屏。只改内存变量，绝不写任何 storage。 */
export const markSessionUnlocked = (): void => { sessionUnlocked = true; };

/**
 * PhoneShell 用：当前是否需要挡住锁屏。
 * = 已开启密码 且 本次会话尚未解锁。锁屏关闭的老用户恒为 false，完全无感。
 */
export const isPinGateActive = (): boolean => isPinLockEnabled() && !isSessionUnlocked();

/**
 * 开启锁屏密码：两次输入一致且均为 6 位数字后，生成 random salt 并落盘哈希。
 */
export const setupPinLock = async (pin: string, confirmPin: string): Promise<PinLockResult> => {
    if (!isValidPin(pin)) return { ok: false, error: '密码必须是 6 位数字' };
    if (pin !== confirmPin) return { ok: false, error: '两次输入的密码不一致' };
    const subtle = (globalThis as any).crypto?.subtle;
    const salt = randomSaltHex();
    if (!subtle || !salt) return { ok: false, error: '当前环境不支持安全存储，无法开启' };
    const hash = await derivePinHash(pin, salt, PBKDF2_ITERATIONS);
    writeStoredConfig({ enabled: true, salt, hash, iterations: PBKDF2_ITERATIONS });
    return { ok: true };
};

/** 校验 PIN 是否正确。未开启时返回 false（调用方应先判断 isPinLockEnabled）。 */
export const verifyPin = async (pin: string): Promise<boolean> => {
    const config = readStoredConfig();
    if (!config || !isValidPin(pin)) return false;
    try {
        const hash = await derivePinHash(pin, config.salt, config.iterations);
        return timingSafeEqualHex(hash, config.hash);
    } catch {
        return false;
    }
};

/** 修改密码：必须先验对当前密码，再两次输入一致的新 6 位密码。 */
export const changePinLock = async (
    currentPin: string,
    newPin: string,
    confirmNewPin: string,
): Promise<PinLockResult> => {
    const config = readStoredConfig();
    if (!config) return { ok: false, error: '锁屏密码尚未开启' };
    if (!(await verifyPin(currentPin))) return { ok: false, error: '当前密码错误' };
    if (!isValidPin(newPin)) return { ok: false, error: '密码必须是 6 位数字' };
    if (newPin !== confirmNewPin) return { ok: false, error: '两次输入的密码不一致' };
    const subtle = (globalThis as any).crypto?.subtle;
    const salt = randomSaltHex();
    if (!subtle || !salt) return { ok: false, error: '当前环境不支持安全存储' };
    const hash = await derivePinHash(newPin, salt, config.iterations);
    writeStoredConfig({ enabled: true, salt, hash, iterations: config.iterations });
    return { ok: true };
};

/** 关闭锁屏密码：必须先验对当前密码。 */
export const disablePinLock = async (currentPin: string): Promise<PinLockResult> => {
    const config = readStoredConfig();
    if (!config) return { ok: false, error: '锁屏密码尚未开启' };
    if (!(await verifyPin(currentPin))) return { ok: false, error: '当前密码错误' };
    writeStoredConfig(null);
    // 关掉之后 isPinLockEnabled 为 false，锁屏门自然消失。
    return { ok: true };
};

/** 仅供测试：把内存里的解锁标记复位（真实浏览器里刷新 / 重开页面会自然发生）。 */
export const __resetPinLockSessionForTests = (): void => {
    sessionUnlocked = false;
};
