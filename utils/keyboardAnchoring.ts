/**
 * keyboardAnchoring —— 键盘锚定纯逻辑（MOBILE_KEYBOARD_ANCHORING_HOTFIX）
 * ═════════════════════════════════════════════════════════════════
 * 全部纯函数，无 DOM 写副作用；DOM 侧（iosStandalone.ts / VisualViewportFixedLayer）
 * 只做薄 adapter。真实可视区域唯一来源 = window.visualViewport。
 *
 * 三个问题域：
 *  1. ANCHORING：fixed 层不能锚 layout viewport bottom，要锚 visual viewport bottom；
 *  2. FOCUS VISIBILITY：键盘展开过程中 vv 连续 resize，聚焦元素可能仍被遮，
 *     需按「rect vs 可视区」计算最小滚动 delta，优先滚最近 scroll container；
 *  3. TOUCHMOVE：键盘态锁外层滚动时，textarea / INPUT / 可滚祖先必须放行，
 *     否则 textarea 内部滚动与 selection handles 被破坏。
 */

// ───────────────────────── 1. VisualViewport 固定层几何 ─────────────────────────

export interface ViewportLayerRect {
    top: number;
    height: number;
    bottom: number;
}

/**
 * 键盘态 fixed layer 的真实可视矩形（CSS: top=offsetTop, height=visual height, bottom=auto）。
 * 例：layout 844 / visual 390 / offsetTop 0 → top 0、height 390、bottom 390（不是 844）。
 */
export function resolveVisualViewportLayerRect(visualHeight: number, visualOffsetTop: number): ViewportLayerRect {
    const top = Math.max(0, Math.round(visualOffsetTop));
    const height = Math.max(0, Math.round(visualHeight));
    return { top, height, bottom: top + height };
}

// ───────────────────────── 2. 聚焦元素可视性 / 最小滚动 ─────────────────────────

/** 聚焦元素与可视区下缘至少保留的余量（含输入辅助栏呼吸空间）。 */
export const FOCUS_VISIBLE_MARGIN_PX = 48;

export interface FocusRect { top: number; bottom: number; }
export interface FocusScrollDecision {
    /** 是否需要滚动。 */
    needsScroll: boolean;
    /** 最近 scroll container 应增加的 scrollTop（正=向下滚把元素滚上来；负=元素在顶上被遮）。 */
    delta: number;
}

/**
 * 判断聚焦元素是否落在 [visibleTop, visibleBottom] 内（留 margin）。
 * 只做一次最小必要滚动的计算，绝不每 keypress 滚。
 */
export function computeFocusScrollDelta(
    rect: FocusRect,
    visibleTop: number,
    visibleBottom: number,
    margin = FOCUS_VISIBLE_MARGIN_PX,
): FocusScrollDecision {
    const lowerBound = visibleBottom - margin;
    if (rect.bottom > lowerBound) {
        return { needsScroll: true, delta: Math.round(rect.bottom - lowerBound) };
    }
    if (rect.top < visibleTop + margin) {
        return { needsScroll: true, delta: -Math.round(visibleTop + margin - rect.top) };
    }
    return { needsScroll: false, delta: 0 };
}

/**
 * 滚动 container 后元素 rect 的预估位移（container 向下滚 delta，元素视觉上移 delta）。
 * 供 caller 在滚动后复核是否仍被遮（避免无限循环：delta 已吃到 scrollMax 就停）。
 */
export function clampScrollDelta(delta: number, scrollTop: number, scrollHeight: number, clientHeight: number): number {
    const maxScroll = Math.max(0, scrollHeight - clientHeight);
    const next = Math.min(Math.max(scrollTop + delta, 0), maxScroll);
    return next - scrollTop;
}

// ───────────────────────── 3. 键盘态 touchmove 放行判定 ─────────────────────────

/**
 * 键盘态允许滚动的容器/元素选择器：
 *  - 原生 text-entry（textarea/input/select/contenteditable）永远放行（不碰 caret/selection/内部滚动）；
 *  - 明确标记：.sully-autogrow-textarea / [data-keyboard-scroll]；
 *  - 既有滚动容器 class：.overflow-y-auto / .overflow-auto。
 */
export const KEYBOARD_SCROLL_SELECTOR = [
    'textarea',
    'input',
    'select',
    '[contenteditable]',
    '[contenteditable] *',
    '.sully-autogrow-textarea',
    '[data-keyboard-scroll]',
    '[data-keyboard-scroll] *',
    '.overflow-y-auto',
    '.overflow-auto',
].join(', ');

export interface TouchMoveProbe {
    tagName: string;
    isContentEditable: boolean;
    /** 是否命中 KEYBOARD_SCROLL_SELECTOR（由 DOM closest 计算，测试注入）。 */
    matchesKeyboardScrollSelector: boolean;
    /** 是否处于「可滚祖先」内（scrollHeight>clientHeight 且 overflowY auto/scroll，由 DOM walker 计算，测试注入）。 */
    withinScrollableAncestor: boolean;
}

export type TouchMoveDecision = 'allow' | 'block';

/**
 * 键盘态 touchmove 判定：
 *  E. textarea（text-entry）→ allow；
 *  F. 可滚 sheet 子元素 / 明确标记 → allow；
 *  G. 普通背景 → block（仍锁外层，防 iOS 把整页顶飞）。
 */
export function decideTouchMove(probe: TouchMoveProbe): TouchMoveDecision {
    const tag = probe.tagName.toUpperCase();
    if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return 'allow';
    if (probe.isContentEditable) return 'allow';
    if (probe.matchesKeyboardScrollSelector) return 'allow';
    if (probe.withinScrollableAncestor) return 'allow';
    return 'block';
}
