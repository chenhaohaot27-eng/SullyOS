/**
 * ChatPhotoViewer — 聊天照片全屏预览（Phase 2A.1）。
 *
 * 交互契约（见 docs/handoff/chat_context_image_phase2a_handoff.md Phase 2A.1）：
 *   · 深色全屏背景，图片按原比例完整显示（object-contain）；
 *   · 关闭途径：右上角关闭按钮 / 点击背景 / 桌面端 Escape；
 *   · 适配 iPhone Safari / PWA 安全区（env(safe-area-inset-*)，含横屏左右）；
 *   · 预览图是真实 <img> 且 -webkit-touch-callout: default —— 长按可唤起 iOS 原生
 *     「存储到照片 / 拷贝」菜单；不拦截 contextmenu、不 preventDefault，不影响聊天滚动；
 *   · 「保存 / 分享」：优先 Web Share 文件分享（iPhone 可选「存储图像」）。File 在预览
 *     打开后异步备好、备好才启用按钮，保证 navigator.share 落在用户点击事件内；
 *     不支持文件分享时按 saveChatPhotoFile 的三级兜底（下载 / 打开原图长按保存）；
 *   · 图片与 Blob 全部复用消息既有的 blobref 管线（getBlobForRef / dataUrlToBlob），
 *     不写库、不新增持久化副本；本组件不创建、不回收 object URL（显示 URL 归气泡的
 *     useBlobRefUrl 管），只透传给兜底路径复用。
 *
 * 通过 createPortal 挂到 document.body，脱离聊天的 transform/滚动容器，fixed 定位不被劫持。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { dataUrlToBlob, getBlobForRef, isBlobRef } from '../../utils/blobRef';
import { canShareChatPhotoFile, prepareChatPhotoFile, saveChatPhotoFile } from '../../utils/chatPhotoViewer';

export interface ChatPhotoViewerProps {
    /** 消息 content：blobref 令牌 / data URL / http(s) URL（决定能否取回 Blob 做文件分享）。 */
    content: string;
    /** 气泡已解析好的显示 URL（useBlobRefUrl 的 object URL，生命周期归气泡管，这里只读）。 */
    displayUrl: string;
    caption?: string;
    onClose: () => void;
}

type Hint = { text: string; type: 'info' | 'success' | 'error' } | null;

/** 从消息 content 取回原始 Blob（blobref → data URL → 取不到返回 null）。 */
async function resolveChatPhotoBlob(content: string): Promise<Blob | null> {
    try {
        if (isBlobRef(content)) return await getBlobForRef(content);
        if (content.startsWith('data:')) return dataUrlToBlob(content);
    } catch (e) {
        console.warn('[ChatPhotoViewer] 读取图片数据失败，仅提供预览兜底:', e);
    }
    return null;
}

const ChatPhotoViewer: React.FC<ChatPhotoViewerProps> = ({ content, displayUrl, caption, onClose }) => {
    // 分享用的 File：预览打开后就异步准备，备好才启用保存按钮（保证 share 在点击事件内触发）。
    const [shareFile, setShareFile] = useState<File | null>(null);
    const [preparing, setPreparing] = useState(true);
    const [hint, setHint] = useState<Hint>(null);

    useEffect(() => {
        let alive = true;
        setPreparing(true);
        setShareFile(null);
        resolveChatPhotoBlob(content).then(blob => {
            if (!alive) return;
            if (blob && blob.size > 0) setShareFile(prepareChatPhotoFile(blob, caption));
            setPreparing(false);
        });
        return () => { alive = false; };
    }, [content, caption]);

    // 桌面端 Escape 关闭。
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    // 简短提示自动消失（不打断预览，也不依赖外层 toast 通路）。
    useEffect(() => {
        if (!hint) return;
        const timer = setTimeout(() => setHint(null), 3500);
        return () => clearTimeout(timer);
    }, [hint]);

    const handleSave = useCallback(async () => {
        try {
            if (shareFile) {
                const outcome = await saveChatPhotoFile(shareFile, {
                    shareTitle: caption || shareFile.name,
                    fallbackUrl: displayUrl,
                });
                if (outcome === 'shared') {
                    setHint({ text: '已打开分享面板，可选择「存储图像」保存到照片', type: 'success' });
                } else if (outcome === 'opened') {
                    setHint({ text: '已打开原图，长按图片选择「存储到照片」', type: 'info' });
                } else if (outcome === 'downloaded') {
                    setHint({ text: '已开始下载图片', type: 'success' });
                }
                // cancelled：用户自己取消，不打扰。
            } else {
                // 取不回 Blob（如 http 外链）：直接打开原图走系统长按保存。
                window.open(displayUrl, '_blank');
                setHint({ text: '已打开原图，长按图片选择「存储到照片」', type: 'info' });
            }
        } catch (e) {
            const msg = e instanceof Error && e.message ? e.message : '未知错误';
            setHint({ text: `保存失败：${msg}`.slice(0, 60), type: 'error' });
        }
    }, [shareFile, caption, displayUrl]);

    if (typeof document === 'undefined') return null;

    const saveLabel = preparing
        ? '准备中…'
        : shareFile && canShareChatPhotoFile(shareFile)
            ? '保存 / 分享'
            : '保存图片';

    return createPortal(
        <div
            role="dialog"
            aria-modal="true"
            aria-label="照片预览"
            className="fixed inset-0 z-[9999] flex flex-col items-center justify-center"
            style={{
                background: 'rgba(0, 0, 0, 0.96)',
                paddingTop: 'env(safe-area-inset-top, 0px)',
                paddingBottom: 'env(safe-area-inset-bottom, 0px)',
                paddingLeft: 'env(safe-area-inset-left, 0px)',
                paddingRight: 'env(safe-area-inset-right, 0px)',
            }}
            onClick={onClose}
        >
            {/* 关闭按钮：锚在安全区之内，iPhone 刘海 / 圆角不遮挡 */}
            <button
                type="button"
                aria-label="关闭预览"
                onClick={onClose}
                className="absolute z-10 flex h-10 w-10 items-center justify-center rounded-full bg-white/12 text-white/90 backdrop-blur-sm transition-transform active:scale-90"
                style={{
                    top: 'calc(env(safe-area-inset-top, 0px) + 12px)',
                    right: 'calc(env(safe-area-inset-right, 0px) + 12px)',
                }}
            >
                <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>

            {/* 真实 <img> + 默认长按行为：iOS 原生「存储到照片」菜单靠它 */}
            <img
                src={displayUrl}
                alt={caption || '照片'}
                className="max-h-full max-w-full object-contain"
                draggable={false}
                style={{ WebkitTouchCallout: 'default' } as React.CSSProperties}
                onClick={(e) => e.stopPropagation()}
            />

            {/* 底部操作条：caption + 保存/分享 + 简短提示 */}
            <div
                className="absolute inset-x-0 bottom-0 z-10 flex flex-col items-center gap-1.5 px-4 pb-[calc(env(safe-area-inset-bottom,0px)+16px)] pt-8"
                style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.55), rgba(0,0,0,0))' }}
                onClick={(e) => e.stopPropagation()}
            >
                {!!caption?.trim() && (
                    <div className="mb-0.5 max-w-[86%] truncate text-center text-[12px] text-white/60">{caption}</div>
                )}
                <button
                    type="button"
                    aria-label="保存或分享照片"
                    disabled={preparing}
                    onClick={handleSave}
                    className="rounded-full bg-white/92 px-6 py-2 text-[13px] font-bold text-slate-900 shadow-lg transition-transform active:scale-95 disabled:opacity-50"
                >
                    {saveLabel}
                </button>
                {hint && (
                    <div className={`text-center text-[11px] leading-snug ${hint.type === 'error' ? 'text-rose-300' : hint.type === 'success' ? 'text-emerald-300' : 'text-white/70'}`}>
                        {hint.text}
                    </div>
                )}
            </div>
        </div>,
        document.body,
    );
};

export default ChatPhotoViewer;
