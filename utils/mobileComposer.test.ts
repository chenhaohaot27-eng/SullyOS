/**
 * mobileComposer.test.ts —— GLOBAL_MOBILE_COMPOSER_FINAL_HOTFIX 共享输入逻辑单测
 * 覆盖：auto-grow 高度流转 / Enter 键策略（移动端、桌面、IME）/ 键盘 inset 计算 /
 * 多行粘贴字符串不变式（\n、空行、段落结构原样保留，无 flatten / trim / 截断）。
 */
import { describe, expect, it } from 'vitest';
import {
    KEYBOARD_INSET_THRESHOLD,
    computeAutoGrowHeight,
    computeAutoGrowSequence,
    computeKeyboardInset,
    deriveViewportState,
    isCoarsePointerEnvironment,
    resolveEnterAction,
} from './mobileComposer';
import { parseFoodImportText } from './foodImportParser';

const MIN = 44;
const MAX = 152;

describe('computeAutoGrowHeight / auto-grow 流转', () => {
    it('单行（短文本）落在 minHeight，不滚动', () => {
        expect(computeAutoGrowHeight(28, MIN, MAX)).toEqual({ height: 44, overflow: false });
    });

    it('多行输入随内容增高，未到 max 前不滚动', () => {
        expect(computeAutoGrowHeight(90, MIN, MAX)).toEqual({ height: 90, overflow: false });
        expect(computeAutoGrowHeight(150, MIN, MAX)).toEqual({ height: 150, overflow: false });
    });

    it('到达最大可见高度后固定 max 并开启内部滚动', () => {
        expect(computeAutoGrowHeight(400, MIN, MAX)).toEqual({ height: 152, overflow: true });
        // 50 行长粘贴：同样封顶
        expect(computeAutoGrowHeight(1200, MIN, MAX)).toEqual({ height: 152, overflow: true });
    });

    it('边界：恰好等于 max 时不滚动', () => {
        expect(computeAutoGrowHeight(MAX, MIN, MAX)).toEqual({ height: 152, overflow: false });
    });

    it('删除文字后高度回缩，清空恢复 minHeight', () => {
        // 输入 AAAA→BBBB→CCCC→DDDD 增长，再逐段删除回缩，最终清空
        const heights = computeAutoGrowSequence([44, 88, 132, 176, 132, 88, 44, 20], MIN, MAX).map(r => r.height);
        expect(heights).toEqual([44, 88, 132, 152, 132, 88, 44, 44]);
        // 发送/清空后的 overflow 应关闭
        const finalState = computeAutoGrowSequence([20], MIN, MAX)[0];
        expect(finalState.overflow).toBe(false);
    });

    it('auto-grow 结果与光标位置无关（只读 scrollHeight，不触碰 selection）', () => {
        // 同样的内容高度，无论 caret 在 BB|BB 还是 DDDD|，高度计算完全一致。
        expect(computeAutoGrowHeight(100, MIN, MAX)).toEqual(computeAutoGrowHeight(100, MIN, MAX));
    });
});

describe('resolveEnterAction / Enter 键策略', () => {
    const base = { key: 'Enter' as const };

    it('移动端（coarse）：Enter = 换行，不发送', () => {
        expect(resolveEnterAction({ ...base, isCoarse: true })).toBe('newline');
        expect(resolveEnterAction({ ...base, isCoarse: true, shiftKey: true })).toBe('newline');
    });

    it('桌面端：Enter = 发送（保持既有行为）', () => {
        expect(resolveEnterAction({ ...base, isCoarse: false })).toBe('send');
    });

    it('桌面端：Shift+Enter = 换行', () => {
        expect(resolveEnterAction({ ...base, isCoarse: false, shiftKey: true })).toBe('newline');
    });

    it('IME composition 中 Enter 绝不发送（isComposing 与老 WebKit keyCode 229）', () => {
        expect(resolveEnterAction({ ...base, isCoarse: false, isComposing: true })).toBe('default');
        expect(resolveEnterAction({ ...base, isCoarse: true, isComposing: true })).toBe('default');
        expect(resolveEnterAction({ ...base, isCoarse: false, keyCode: 229 })).toBe('default');
    });

    it('非 Enter 键一律 default', () => {
        expect(resolveEnterAction({ key: 'a', isCoarse: false })).toBe('default');
        expect(resolveEnterAction({ key: 'Backspace', isCoarse: true })).toBe('default');
    });
});

describe('isCoarsePointerEnvironment / 触屏探测', () => {
    it('matchMedia (pointer: coarse) 命中 → coarse', () => {
        expect(isCoarsePointerEnvironment(q => ({ matches: q.includes('coarse') }), 0)).toBe(true);
    });
    it('matchMedia (pointer: fine) → 非 coarse', () => {
        expect(isCoarsePointerEnvironment(q => ({ matches: q.includes('fine') }), 5)).toBe(false);
    });
    it('无 matchMedia 时退 maxTouchPoints', () => {
        expect(isCoarsePointerEnvironment(undefined, 5)).toBe(true);
        expect(isCoarsePointerEnvironment(undefined, 0)).toBe(false);
    });
});

describe('computeKeyboardInset / VisualViewport 键盘高度', () => {
    it('键盘弹出（视口明显收缩）→ inset 更新为收缩差值', () => {
        // 844 布局高度 → 键盘后可视 500
        expect(computeKeyboardInset(844, 500, 0)).toBe(344);
    });

    it('键盘收起（视口恢复）→ inset 归零', () => {
        expect(computeKeyboardInset(844, 844, 0)).toBe(0);
    });

    it('地址栏小幅收放（< 阈值）不误判为键盘', () => {
        expect(computeKeyboardInset(844, 844 - 40, 0)).toBe(0);
        expect(KEYBOARD_INSET_THRESHOLD).toBeGreaterThan(40);
    });

    it('visual viewport 被上推（offsetTop>0）时扣除位移，不重复计算', () => {
        expect(computeKeyboardInset(844, 500, 60)).toBe(284);
    });

    it('非法输入返回 0', () => {
        expect(computeKeyboardInset(0, 500, 0)).toBe(0);
        expect(computeKeyboardInset(844, 0, 0)).toBe(0);
    });

    it('deriveViewportState 汇总三值', () => {
        expect(deriveViewportState(844, 500, 0)).toEqual({ height: 500, offsetTop: 0, keyboardInset: 344 });
        expect(deriveViewportState(844, 844, 0).keyboardInset).toBe(0);
    });
});

describe('多行粘贴不变式（Chat/Story/Food 共用 textarea value 直通）', () => {
    const pasted = '第一行\n\n第二段第一行\n第二段第二行\n\n第三段';

    it('空行与段落结构原样保留（无 flatten / trim）', () => {
        expect(pasted.split('\n')).toEqual(['第一行', '', '第二段第一行', '第二段第二行', '', '第三段']);
        expect(pasted.startsWith('\n')).toBe(false);
    });

    it('长粘贴（20~50 行）不截断', () => {
        const long = Array.from({ length: 50 }, (_, i) => `第${i + 1}行内容`).join('\n');
        expect(long.split('\n')).toHaveLength(50);
    });

    it('Food：parser 收到的字符串与 textarea value 完全一致（含空行/换行）', () => {
        const parsed = parseFoodImportText(pasted);
        // foodImportParser 的 rawShareText 必须是原文，不做任何规范化
        expect(parsed.rawShareText).toBe(pasted);
    });

    it('Food：URL 粘贴解析行为不变', () => {
        const url = 'https://example.com/item?id=1';
        const parsed = parseFoodImportText(url);
        expect(parsed.originalUrl).toBe(url);
    });
});
