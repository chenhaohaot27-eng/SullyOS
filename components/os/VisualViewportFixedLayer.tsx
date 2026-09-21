/**
 * VisualViewportFixedLayer —— 键盘态固定层（MOBILE_KEYBOARD_ANCHORING_HOTFIX）
 * ═════════════════════════════════════════════════════════════════
 * position:fixed 的「当前键盘上方真实可视屏幕」：
 *   top    = var(--visual-viewport-offset-top, 0px)
 *   height = var(--visual-viewport-height, 100lvh)
 *   bottom = auto
 *
 * 这两个变量由 utils/iosStandalone.ts 的 setViewportVars 持续维护
 * （visualViewport resize/scroll + orientationchange），无键盘时 layer = 全屏，
 * 行为与 fixed inset-0 等价；键盘弹出时 layer 底边 = 键盘上沿。
 *
 * 键盘态 Bottom Sheet / 含输入的弹层外层一律用它承载，
 * 不再用 fixed inset-0（那会锚到 layout viewport bottom，落进键盘后面）。
 * 传入 className/style 保持各页面视觉；其余 props 原样透传。
 */
import React from 'react';

export interface VisualViewportFixedLayerProps extends React.HTMLAttributes<HTMLDivElement> {
    zIndex?: number;
}

const VisualViewportFixedLayer = React.forwardRef<HTMLDivElement, VisualViewportFixedLayerProps>(
    function VisualViewportFixedLayer({ zIndex = 9000, className = '', style, children, ...rest }, ref) {
        return (
            <div
                {...rest}
                ref={ref}
                className={className}
                style={{
                    position: 'fixed',
                    left: 0,
                    right: 0,
                    top: 'var(--visual-viewport-offset-top, 0px)',
                    height: 'var(--visual-viewport-height, 100lvh)',
                    bottom: 'auto',
                    overflow: 'hidden',
                    zIndex,
                    ...style,
                }}
            >
                {children}
            </div>
        );
    },
);

export default VisualViewportFixedLayer;
