/**
 * keyboardAnchoring.test.ts —— MOBILE_KEYBOARD_ANCHORING_HOTFIX 场景 A–G
 */
import { describe, expect, it } from 'vitest';
import {
    FOCUS_VISIBLE_MARGIN_PX,
    KEYBOARD_SCROLL_SELECTOR,
    clampScrollDelta,
    computeFocusScrollDelta,
    decideTouchMove,
    resolveVisualViewportLayerRect,
} from './keyboardAnchoring';

describe('场景 A：visual viewport 390 / layout 844', () => {
    it('固定层 height=390，bottom 落在 y=390 而不是 y=844', () => {
        const rect = resolveVisualViewportLayerRect(390, 0);
        expect(rect).toEqual({ top: 0, height: 390, bottom: 390 });
        expect(rect.bottom).not.toBe(844);
    });
});

describe('场景 B：offsetTop != 0', () => {
    it('top = offsetTop，bottom = offsetTop + height', () => {
        const rect = resolveVisualViewportLayerRect(400, 60);
        expect(rect.top).toBe(60);
        expect(rect.bottom).toBe(60 + 400);
    });
    it('非法输入归零', () => {
        expect(resolveVisualViewportLayerRect(-10, -5)).toEqual({ top: 0, height: 0, bottom: 0 });
    });
});

describe('场景 C：active field 被键盘遮挡 → 触发局部滚动', () => {
    it('rect.bottom 超出可视区下缘 → delta > 0', () => {
        const visibleTop = 0;
        const visibleBottom = 390;
        const decision = computeFocusScrollDelta({ top: 320, bottom: 360 }, visibleTop, visibleBottom);
        expect(decision.needsScroll).toBe(true);
        expect(decision.delta).toBe(Math.round(360 - (visibleBottom - FOCUS_VISIBLE_MARGIN_PX)));
        expect(decision.delta).toBeGreaterThan(0);
    });

    it('元素在顶部被遮 → 负 delta 往回滚', () => {
        const decision = computeFocusScrollDelta({ top: 10, bottom: 50 }, 60, 460);
        expect(decision.needsScroll).toBe(true);
        expect(decision.delta).toBeLessThan(0);
    });

    it('clampScrollDelta 尊重 scrollMax（已滚到底就不再要求滚动）', () => {
        // scrollHeight 800 / clientHeight 390 → maxScroll 410；当前 410 = 已到底
        expect(clampScrollDelta(60, 410, 800, 390)).toBe(0);
        // 中部：delta 足额生效
        expect(clampScrollDelta(60, 100, 800, 390)).toBe(60);
        // 顶部边界不会滚成负
        expect(clampScrollDelta(-200, 50, 800, 390)).toBe(-50);
    });
});

describe('场景 D：active field 已可见 → 不滚', () => {
    it('rect 完全在可视区（含 margin）→ needsScroll=false, delta=0', () => {
        const decision = computeFocusScrollDelta({ top: 100, bottom: 140 }, 0, 390);
        expect(decision.needsScroll).toBe(false);
        expect(decision.delta).toBe(0);
    });
});

describe('场景 E：textarea touchmove 不得 preventDefault', () => {
    it('TEXTAREA → allow', () => {
        expect(decideTouchMove({ tagName: 'textarea', isContentEditable: false, matchesKeyboardScrollSelector: false, withinScrollableAncestor: false })).toBe('allow');
    });
    it('INPUT / SELECT → allow', () => {
        expect(decideTouchMove({ tagName: 'INPUT', isContentEditable: false, matchesKeyboardScrollSelector: false, withinScrollableAncestor: false })).toBe('allow');
        expect(decideTouchMove({ tagName: 'SELECT', isContentEditable: false, matchesKeyboardScrollSelector: false, withinScrollableAncestor: false })).toBe('allow');
    });
    it('contenteditable → allow', () => {
        expect(decideTouchMove({ tagName: 'DIV', isContentEditable: true, matchesKeyboardScrollSelector: false, withinScrollableAncestor: false })).toBe('allow');
    });
});

describe('场景 F：可滚 sheet 子元素 → allow', () => {
    it('命中 [data-keyboard-scroll] 标记 → allow', () => {
        expect(decideTouchMove({ tagName: 'DIV', isContentEditable: false, matchesKeyboardScrollSelector: true, withinScrollableAncestor: false })).toBe('allow');
    });
    it('处于可滚祖先内（computed overflowY auto/scroll）→ allow（未来新页面无需记得加 class）', () => {
        expect(decideTouchMove({ tagName: 'DIV', isContentEditable: false, matchesKeyboardScrollSelector: false, withinScrollableAncestor: true })).toBe('allow');
    });
    it('选择器常量包含既有滚动 class 与明确标记', () => {
        expect(KEYBOARD_SCROLL_SELECTOR).toContain('.overflow-y-auto');
        expect(KEYBOARD_SCROLL_SELECTOR).toContain('[data-keyboard-scroll]');
        expect(KEYBOARD_SCROLL_SELECTOR).toContain('.sully-autogrow-textarea');
    });
});

describe('场景 G：普通背景区域仍阻止外层错误滚动', () => {
    it('非 text-entry、无标记、无可滚祖先 → block', () => {
        expect(decideTouchMove({ tagName: 'DIV', isContentEditable: false, matchesKeyboardScrollSelector: false, withinScrollableAncestor: false })).toBe('block');
        expect(decideTouchMove({ tagName: 'SPAN', isContentEditable: false, matchesKeyboardScrollSelector: false, withinScrollableAncestor: false })).toBe('block');
    });
});
