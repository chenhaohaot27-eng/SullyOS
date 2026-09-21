/**
 * useVisualViewport —— iOS/Android 键盘可见性（GLOBAL_MOBILE_COMPOSER_FINAL_HOTFIX）
 * ═════════════════════════════════════════════════════════════════
 * 计算（computeKeyboardInset / deriveViewportState）在 utils/mobileComposer.ts，
 * 这里只是 DOM 订阅 adapter（保持极小）：
 *  - visualViewport resize/scroll + orientationchange → ViewportState
 *  - 无 visualViewport 的老浏览器降级 window resize
 * 全局键盘避让与 CSS 变量（--app-height 等）由 utils/iosStandalone.ts 统一管理，
 * 本 hook 不写 CSS 变量、不加局部 inset，避免双重避让。不写死 keyboardHeight。
 */
import { useEffect, useState } from 'react';
import { deriveViewportState, type ViewportState } from '../utils/mobileComposer';

export { KEYBOARD_INSET_THRESHOLD } from '../utils/mobileComposer';
export type { ViewportState } from '../utils/mobileComposer';

export function readViewportState(): ViewportState {
    if (typeof window === 'undefined') return { height: 0, offsetTop: 0, keyboardInset: 0 };
    const vv = window.visualViewport;
    if (vv) return deriveViewportState(window.innerHeight, vv.height, vv.offsetTop);
    return deriveViewportState(window.innerHeight, window.innerHeight, 0);
}

export function subscribeVisualViewport(callback: (state: ViewportState) => void): () => void {
    if (typeof window === 'undefined') return () => {};
    const emit = () => callback(readViewportState());
    const vv = window.visualViewport;
    if (vv) {
        vv.addEventListener('resize', emit);
        vv.addEventListener('scroll', emit);
        window.addEventListener('orientationchange', emit);
        emit();
        return () => {
            vv.removeEventListener('resize', emit);
            vv.removeEventListener('scroll', emit);
            window.removeEventListener('orientationchange', emit);
        };
    }
    // 降级：无 visualViewport 的老浏览器只用 resize（键盘收发通常触发 window resize）。
    window.addEventListener('resize', emit);
    emit();
    return () => window.removeEventListener('resize', emit);
}

/**
 * React hook：订阅 visualViewport，返回最新键盘/视口状态（只读，不写 CSS 变量——
 * 全局避让由 utils/iosStandalone.ts 负责，这里仅供个别组件做局部判断）。
 */
export function useVisualViewport(): ViewportState {
    const [state, setState] = useState<ViewportState>(() => readViewportState());
    useEffect(() => {
        const unsubscribe = subscribeVisualViewport(setState);
        return unsubscribe;
    }, []);
    return state;
}
