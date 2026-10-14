import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Message } from '../../types';

/**
 * SelectionFavoriteAffix — 原生文字选区 → 「🐚 收藏选中文字」浮动按钮。
 *
 * 工作方式：容器元素标 data-frag-msg="<msgId>" 且文本节点可选中（select-text）；
 * iOS Safari 长按出原生选择光标 → selectionchange（250ms 防抖）检测到非空选区
 * 且锚点落在收藏区内 → 显示浮动按钮（固定底部，避开 iOS 原生选择菜单）。
 * 点击时读取 selection.toString()（只收选中的字）+ 锚点前缀计算 occurrence
 * （同一文本节点内重复内容区分），回调后清除选区。
 * 无有效选区绝不收藏全文（onFavoriteText 不会被调用）。
 */

export const FRAG_MSG_ATTR = 'data-frag-msg';

export interface SelectionFavoriteAffixProps {
    /** 从 data-frag-msg 的 msgId 找回 Message；找不到则按钮不生效。 */
    resolveMessage: (msgId: number) => Message | null | undefined;
    /** 收藏选中文字（selectedText 已 trim；occurrence 为节点内第几次出现）。 */
    onFavoriteText: (msg: Message, selectedText: string, occurrence: number) => void;
}

/** 锚点文本节点内、选区之前的出现次数（重复内容去重）。 */
function selectionOccurrence(sel: Selection, selectedText: string): number {
    const node = sel.anchorNode;
    if (!node || !node.textContent) return 0;
    const prefix = node.textContent.slice(0, sel.anchorOffset ?? 0);
    return Math.max(0, prefix.split(selectedText).length - 1);
}

function closestFragElement(sel: Selection | null): HTMLElement | null {
    const node = sel?.anchorNode;
    const el = node instanceof Element ? node : node?.parentElement ?? null;
    return (el?.closest?.(`[${FRAG_MSG_ATTR}]`) as HTMLElement | null) ?? null;
}

const SelectionFavoriteAffix: React.FC<SelectionFavoriteAffixProps> = ({ resolveMessage, onFavoriteText }) => {
    const [visible, setVisible] = useState(false);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        const check = () => {
            const sel = window.getSelection();
            if (!sel || sel.isCollapsed || !sel.toString().trim()) { setVisible(false); return; }
            setVisible(!!closestFragElement(sel));
        };
        const onChange = () => {
            if (timerRef.current) clearTimeout(timerRef.current);
            timerRef.current = setTimeout(check, 250);
        };
        document.addEventListener('selectionchange', onChange);
        return () => {
            document.removeEventListener('selectionchange', onChange);
            if (timerRef.current) clearTimeout(timerRef.current);
        };
    }, []);

    const handleFavorite = useCallback(() => {
        const sel = window.getSelection();
        const text = (sel?.toString() || '').replace(/\s+/g, ' ').trim();
        const el = closestFragElement(sel);
        const msgId = Number(el?.getAttribute(FRAG_MSG_ATTR));
        const msg = el && Number.isFinite(msgId) ? resolveMessage(msgId) : null;
        if (!sel || !text || !msg) return;
        onFavoriteText(msg, text, selectionOccurrence(sel, text));
        try { sel.removeAllRanges(); } catch { /* ignore */ }
        setVisible(false);
    }, [resolveMessage, onFavoriteText]);

    if (!visible) return null;
    return (
        <button
            onClick={(e) => { e.stopPropagation(); e.preventDefault(); handleFavorite(); }}
            className="fixed z-[120] left-1/2 -translate-x-1/2 px-4 py-2.5 rounded-full bg-slate-900/90 text-white text-xs font-bold shadow-xl shadow-black/40 active:scale-95 transition-transform"
            style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 96px)' }}
        >🐚 收藏选中文字</button>
    );
};

export default SelectionFavoriteAffix;
