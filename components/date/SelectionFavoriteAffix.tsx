import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Message } from '../../types';

/**
 * SelectionFavoriteAffix — 原生文字选区 → 「🐚 收藏选中文字」浮动按钮。
 *
 * iOS 关键点：点击按钮的瞬间系统可能已清空 Selection —— 因此**不在点击时读选区**，
 * 而是在 selectionchange（防抖）确认选区有效时就保存完整快照
 * { msgId, text, occurrence }（锚点解析也在快照时刻完成，绝不误关联别的消息）；
 * 点击只消费快照。快照缺失（异常路径）绝不静默：回调 onError 给出明确提示。
 *
 * 容器约定：元素标 data-frag-msg="<msgId>" 且文本可选中（select-text）。
 */

export const FRAG_MSG_ATTR = 'data-frag-msg';

export interface SelectionFavoriteAffixProps {
    /** 从 data-frag-msg 的 msgId 找回 Message；找不到则视为快照失效。 */
    resolveMessage: (msgId: number) => Message | null | undefined;
    /** 收藏选中文字（快照时刻的精确文本；occurrence 为节点内第几次出现）。 */
    onFavoriteText: (msg: Message, selectedText: string, occurrence: number) => void;
    /** 无有效选区/快照失效时的明确提示回调（禁止静默失败）。 */
    onError?: (reason: 'no_selection' | 'message_not_found') => void;
}

interface SelectionSnapshot {
    msgId: number;
    text: string;
    occurrence: number;
}

function closestFragElement(sel: Selection | null): HTMLElement | null {
    const node = sel?.anchorNode;
    const el = node instanceof Element ? node : node?.parentElement ?? null;
    return (el?.closest?.(`[${FRAG_MSG_ATTR}]`) as HTMLElement | null) ?? null;
}

const SelectionFavoriteAffix: React.FC<SelectionFavoriteAffixProps> = ({ resolveMessage, onFavoriteText, onError }) => {
    const [visible, setVisible] = useState(false);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // 选区快照：selectionchange 确认有效时写入；点击时只读它，绝不碰实时 Selection
    const snapRef = useRef<SelectionSnapshot | null>(null);

    useEffect(() => {
        const check = () => {
            const sel = window.getSelection();
            const text = (sel?.toString() || '').replace(/\s+/g, ' ').trim();
            const el = (!sel || sel.isCollapsed || !text) ? null : closestFragElement(sel);
            if (!sel || !el) {
                snapRef.current = null;
                setVisible(false);
                return;
            }
            // 快照时刻解析：目标消息 + 精确文本 + 节点内出现序号（重复内容区分）
            const node = sel.anchorNode;
            const nodeText = node?.textContent || '';
            const prefix = nodeText.slice(0, sel.anchorOffset ?? 0);
            const occurrence = Math.max(0, prefix.split(text).length - 1);
            const msgId = Number(el.getAttribute(FRAG_MSG_ATTR));
            if (!Number.isFinite(msgId)) {
                snapRef.current = null;
                setVisible(false);
                return;
            }
            snapRef.current = { msgId, text, occurrence };
            setVisible(true);
        };
        const schedule = () => {
            if (timerRef.current) clearTimeout(timerRef.current);
            timerRef.current = setTimeout(check, 250);
        };
        document.addEventListener('selectionchange', schedule);
        // iOS Safari 部分场景 selectionchange 不触发/延迟：mouseup/touchend 兜底再查一次
        document.addEventListener('mouseup', schedule);
        document.addEventListener('touchend', schedule);
        return () => {
            document.removeEventListener('selectionchange', schedule);
            document.removeEventListener('mouseup', schedule);
            document.removeEventListener('touchend', schedule);
            if (timerRef.current) clearTimeout(timerRef.current);
        };
    }, []);

    const handleFavorite = useCallback(() => {
        const snap = snapRef.current;
        if (!snap) {
            // 没有有效选区快照：绝不静默吞掉
            onError?.('no_selection');
            setVisible(false);
            return;
        }
        const msg = resolveMessage(snap.msgId);
        if (!msg) {
            onError?.('message_not_found');
            setVisible(false);
            return;
        }
        onFavoriteText(msg, snap.text, snap.occurrence);
        snapRef.current = null;
        setVisible(false);
        try { window.getSelection()?.removeAllRanges(); } catch { /* ignore */ }
    }, [resolveMessage, onFavoriteText, onError]);

    if (!visible) return null;
    return (
        <button
            onPointerDown={(e) => { e.stopPropagation(); }}
            onClick={(e) => { e.stopPropagation(); e.preventDefault(); handleFavorite(); }}
            className="fixed z-[120] left-1/2 -translate-x-1/2 px-4 py-2.5 rounded-full bg-slate-900/90 text-white text-xs font-bold shadow-xl shadow-black/40 active:scale-95 transition-transform"
            style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 96px)' }}
        >🐚 收藏选中文字</button>
    );
};

export default SelectionFavoriteAffix;

