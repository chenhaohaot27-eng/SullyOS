/**
 * MobileAutoGrowTextarea —— 玩家多行输入统一组件（GLOBAL_MOBILE_COMPOSER_FINAL_HOTFIX）
 * ═════════════════════════════════════════════════════════════════
 * 组合 useAutoGrowTextarea：
 *  - 真正的 multiline textarea（原生选择/复制/粘贴/光标全保留，零 preventDefault）
 *  - 输入自动增高，maxHeight 后内部滚动（touch 惯性 + overscroll contain），页面不被撑高
 *  - 删除/清空自动回缩
 *  - 字号 >= 16px（iOS Safari 聚焦不自动 zoom）
 *  - 不改 value、不重挂 DOM、不动 selection —— 光标/IME 安全
 *
 * 键盘避让不加局部 padding：全局由 utils/iosStandalone.ts 统一处理（--app-height 跟随
 * 可视区 + ios-keyboard-open），组件层再叠 inset 会双重让位。
 *
 * 使用方传 className / style 保持各页面视觉；onChange/onKeyDown/onFocus 等全部透传。
 */
import React, { useCallback } from 'react';
import { ensureTextareaVisible, useAutoGrowTextarea } from '../../hooks/useAutoGrowTextarea';

export interface MobileAutoGrowTextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
    /** 最小高度 px（默认 44 ≈ 1 行）。 */
    minHeight?: number;
    /** 最大可见高度 px（默认 152 ≈ 5-6 行；超过后内部滚动）。 */
    maxHeight?: number;
    /** 聚焦时是否做一次最小可视保障 scrollIntoView（默认 true；只在 focus 时，绝不在每次输入时）。 */
    ensureVisibleOnFocus?: boolean;
}

const BASE_CLASS = 'sully-autogrow-textarea w-full resize-none bg-transparent outline-none';

const MobileAutoGrowTextarea = React.forwardRef<HTMLTextAreaElement, MobileAutoGrowTextareaProps>(function MobileAutoGrowTextarea(
    {
        minHeight = 44,
        maxHeight = 152,
        ensureVisibleOnFocus = true,
        className = '',
        style,
        onFocus,
        value,
        ...rest
    },
    forwardedRef,
) {
    const innerRef = useAutoGrowTextarea<HTMLTextAreaElement>(typeof value === 'string' ? value : '');

    const setRefs = useCallback((node: HTMLTextAreaElement | null) => {
        (innerRef as React.MutableRefObject<HTMLTextAreaElement | null>).current = node;
        if (typeof forwardedRef === 'function') forwardedRef(node);
        else if (forwardedRef) (forwardedRef as React.MutableRefObject<HTMLTextAreaElement | null>).current = node;
    }, [innerRef, forwardedRef]);

    const handleFocus = useCallback((event: React.FocusEvent<HTMLTextAreaElement>) => {
        if (ensureVisibleOnFocus) ensureTextareaVisible(event.currentTarget);
        onFocus?.(event);
    }, [ensureVisibleOnFocus, onFocus]);

    return (
        <textarea
            {...rest}
            ref={setRefs}
            value={value}
            onFocus={handleFocus}
            className={`${BASE_CLASS} ${className}`}
            style={{
                minHeight: `${minHeight}px`,
                maxHeight: `${maxHeight}px`,
                overflowY: 'auto',
                WebkitOverflowScrolling: 'touch',
                overscrollBehavior: 'contain',
                fontSize: '16px',
                ...style,
            }}
        />
    );
});

export default MobileAutoGrowTextarea;

