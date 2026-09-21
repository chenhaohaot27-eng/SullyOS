/**
 * useAutoGrowTextarea —— 移动端多行输入统一行为（GLOBAL_MOBILE_COMPOSER_FINAL_HOTFIX）
 * ═════════════════════════════════════════════════════════════════
 * 纯高度控制的 auto-grow（计算在 utils/mobileComposer.ts），绝不触碰 selection/caret/DOM 身份：
 *  - height = clamp(scrollHeight, minHeight, maxHeight)
 *  - 超过 maxHeight 后 overflow-y: auto（textarea 内部滚动），页面不被撑高
 *  - 删除文字自动缩回；清空恢复 minHeight
 *  - 只写 style.height / style.overflowY，不改 value、不 focus、不 setSelectionRange
 *  - IME 安全：高度重算由 input 事件驱动（composition 期间也只改高度，不动光标）
 */
import { useEffect, useLayoutEffect, useRef } from 'react';
import { computeAutoGrowHeight } from '../utils/mobileComposer';

export interface AutoGrowOptions {
    /** 最小高度（px），默认 44。 */
    minHeight?: number;
    /** 最大可见高度（px），默认 152。超过后内部滚动。 */
    maxHeight?: number;
}

export function useAutoGrowTextarea<T extends HTMLTextAreaElement>(
    value: string,
    options: AutoGrowOptions = {},
): React.RefObject<T> {
    const ref = useRef<T>(null);
    const { minHeight = 44, maxHeight = 152 } = options;

    const resize = () => {
        const el = ref.current;
        if (!el) return;
        // 先复位再量：拿到的才是内容真实需要的高度。
        el.style.height = 'auto';
        const { height, overflow } = computeAutoGrowHeight(el.scrollHeight, minHeight, maxHeight);
        el.style.height = `${height}px`;
        el.style.overflowY = overflow ? 'auto' : 'hidden';
    };

    // 值变化后同步高度（含清空/发送后回缩）。
    useEffect(() => {
        resize();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [value, minHeight, maxHeight]);

    // 字体加载 / 首帧兜底（useLayoutEffect 避免 iOS 首次聚焦闪跳）。
    useLayoutEffect(() => {
        resize();
        if (typeof document !== 'undefined' && 'fonts' in document) {
            (document as any).fonts?.ready?.then(() => resize()).catch(() => {});
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return ref;
}

/** 供组件在 onFocus 时（而非每键）调用的最小可视保障：不改变 selection。 */
export function ensureTextareaVisible(el: HTMLTextAreaElement | null): void {
    if (!el || document.activeElement !== el) return;
    try {
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    } catch {
        // 老 iOS 不支持 options 形态。
        el.scrollIntoView(false);
    }
}

