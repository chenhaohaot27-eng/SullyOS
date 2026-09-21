/**
 * mobileComposer —— 移动端多行输入共享纯逻辑（GLOBAL_MOBILE_COMPOSER_FINAL_HOTFIX）
 * ═════════════════════════════════════════════════════════════════
 * 全部为无 React / 无 DOM 写副作用的纯函数，供 hooks/useAutoGrowTextarea.ts、
 * hooks/useVisualViewport.ts、components/os/MobileAutoGrowTextarea.tsx 复用，
 * 并在 utils/mobileComposer.test.ts 中做 Node 环境单测。
 *
 * 不变量（硬要求）：
 *  - auto-grow 只计算高度与 overflow，绝不触碰 selection / caret / DOM 替换；
 *  - 多行粘贴的 \n / 空行 / 段落结构原样保留（无 flatten / trim / 截断）；
 *  - IME composition 中的 Enter 永不触发发送。
 */

// ───────────────────────── auto-grow 高度计算 ─────────────────────────

export interface AutoGrowResult {
    /** 应设置的 textarea 高度（px）。 */
    height: number;
    /** 是否需要内部滚动（内容超过最大可见高度）。 */
    overflow: boolean;
}

/**
 * clamp(scrollHeight, minHeight, maxHeight)。
 * scrollHeight 在 jsdom / Node 中由调用方 mock，公式本身可精确单测。
 */
export function computeAutoGrowHeight(scrollHeight: number, minHeight = 44, maxHeight = 152): AutoGrowResult {
    const safeMin = Math.max(0, Math.min(minHeight, maxHeight));
    const height = Math.min(Math.max(scrollHeight, safeMin), maxHeight);
    return { height, overflow: scrollHeight > maxHeight };
}

/**
 * 输入/删除/清空后的高度流转（纯函数视图，供测试推演组件行为）：
 * one-line → min；多行增长 → 跟随内容；到达 max 后固定 max + overflow；
 * 删除回缩；清空 → min。数值本身由 computeAutoGrowHeight 决定。
 */
export function computeAutoGrowSequence(scrollHeights: number[], minHeight = 44, maxHeight = 152): AutoGrowResult[] {
    return scrollHeights.map(sh => computeAutoGrowHeight(sh, minHeight, maxHeight));
}

// ───────────────────────── Enter 键策略 ─────────────────────────

export type EnterKeyAction = 'send' | 'newline' | 'default';

export interface EnterActionInput {
    isCoarse: boolean;
    key: string;
    shiftKey?: boolean;
    ctrlKey?: boolean;
    metaKey?: boolean;
    /** e.nativeEvent.isComposing 或组件层 compositionstart/end 跟踪值。 */
    isComposing?: boolean;
    /** 老 WebKit 在 composition 结束瞬间的 keydown keyCode 为 229。 */
    keyCode?: number;
}

/**
 * 触屏环境探测：优先 matchMedia((pointer: coarse))，其次 (pointer: fine) 排除，
 * 最后退 navigator.maxTouchPoints。不依赖 UA 字符串（可被桌面触屏误导但方向保守）。
 */
export function isCoarsePointerEnvironment(matchMedia?: (q: string) => { matches: boolean }, maxTouchPoints?: number): boolean {
    if (typeof window === 'undefined' && typeof navigator === 'undefined' && !matchMedia && maxTouchPoints === undefined) return false;
    const mm = matchMedia ?? (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia : null);
    const mtp = maxTouchPoints ?? (typeof navigator !== 'undefined' ? (navigator.maxTouchPoints ?? 0) : 0);
    try {
        if (mm?.('(pointer: coarse)').matches) return true;
        if (mm?.('(pointer: fine)').matches) return false;
    } catch {
        // 个别 WebView 对指针查询抛错，落到 maxTouchPoints 兜底。
    }
    return mtp > 1;
}

/**
 * 统一 Enter 语义：
 *  - 移动端（coarse pointer）：Enter = 换行（'newline'，调用方不 preventDefault、不发送），发送走按钮；
 *  - 桌面端：Enter = 发送，Shift+Enter = 换行（保持既有桌面效率）；
 *  - IME composition（isComposing 或 keyCode 229）：'default'，绝不拦截、绝不发送。
 */
export function resolveEnterAction(input: EnterActionInput): EnterKeyAction {
    if (input.key !== 'Enter') return 'default';
    if (input.isComposing || input.keyCode === 229) return 'default';
    if (input.isCoarse) return 'newline';
    return input.shiftKey ? 'newline' : 'send';
}

// ───────────────────────── VisualViewport / 键盘高度 ─────────────────────────

export interface ViewportState {
    /** window.visualViewport.height（无 API 时为 window.innerHeight）。 */
    height: number;
    /** visual viewport 顶部相对 layout viewport 的偏移。 */
    offsetTop: number;
    /** 估算的键盘高度（px，0 = 键盘不可见）。 */
    keyboardInset: number;
}

/** 视口收缩超过该值才判定为键盘出现（吸收 iOS 地址栏收放的几十像素抖动）。 */
export const KEYBOARD_INSET_THRESHOLD = 90;

/**
 * 键盘 inset 估算：layout − visual，超过阈值才算键盘；再扣除 offsetTop
 * （iOS 键盘弹出把 visual viewport 上推时，真实遮挡小于差值）。
 * 不写死 keyboardHeight，不针对机型。
 */
export function computeKeyboardInset(layoutHeight: number, visualHeight: number, visualOffsetTop: number): number {
    if (layoutHeight <= 0 || visualHeight <= 0) return 0;
    const inset = layoutHeight - visualHeight;
    if (inset < KEYBOARD_INSET_THRESHOLD) return 0;
    return Math.max(0, Math.round(inset - visualOffsetTop));
}

/** 由（可 mock 的）视口尺寸推导当前 ViewportState。 */
export function deriveViewportState(layoutHeight: number, visualHeight: number, visualOffsetTop: number): ViewportState {
    return {
        height: visualHeight,
        offsetTop: visualOffsetTop,
        keyboardInset: computeKeyboardInset(layoutHeight, visualHeight, visualOffsetTop),
    };
}
