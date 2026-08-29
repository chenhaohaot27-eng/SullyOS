/**
 * chatPhotoViewer — 聊天照片全屏预览的「保存 / 分享」辅助（Phase 2A.1）。
 *
 * 只封装浏览器原生能力，不落库、不复制图片副本、不碰生图协议：
 *   · 首选 Web Share API 的文件分享（iPhone 分享面板里可选「存储图像 / 保存到照片」），
 *     严格 feature detection（navigator.share + navigator.canShare({files})）；
 *   · 不可用时回退 a.download；iOS Safari / PWA 不认 a.download 时打开原图并提示长按保存；
 *   · 分享必须在用户点击事件内发起 —— File 由调用方（预览组件）提前异步备好、备好才启用按钮；
 *   · 临时 object URL 一律在本模块的兜底路径内创建并按时回收，绝不持久化 blob: URL，
 *     也不 revoke 调用方（useBlobRefUrl）自己管理的显示 URL。
 */

/** 保存动作的结果，调用方据此给出简短提示。 */
export type ChatPhotoSaveOutcome = 'shared' | 'downloaded' | 'opened' | 'cancelled';

/** Blob 的 MIME 兜底：非 image/* 一律按 PNG 对待（生图服务产出的都是位图）。 */
export function chatPhotoMimeOf(blob: Blob): string {
    return /^image\//i.test(blob.type) ? blob.type : 'image/png';
}

/** 从 MIME 推扩展名（分享面板里文件名带扩展名更容易被识别为图片）。 */
export function chatPhotoExtOf(mime: string): 'png' | 'jpg' | 'webp' | 'gif' {
    const m = mime.toLowerCase();
    if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
    if (m.includes('webp')) return 'webp';
    if (m.includes('gif')) return 'gif';
    return 'png';
}

/** 文件名里的非法字符压成空格、空白折叠成下划线、超长截断。 */
function sanitizeFileNameBase(caption: string | undefined | null): string {
    return (caption || '')
        .replace(/[\\/:*?"<>|\r\n\t]+/g, ' ')
        .trim()
        .replace(/\s+/g, '_')
        .slice(0, 24)
        .replace(/^[_.]+|[_.]+$/g, '');
}

/** 生成 `photo_<caption>_<YYYYMMDD-HHmm>.<ext>` 形式的安全文件名。 */
export function buildChatPhotoFileName(caption: string | undefined | null, mime: string, ts: number = Date.now()): string {
    const ext = chatPhotoExtOf(mime);
    const base = sanitizeFileNameBase(caption);
    const d = new Date(ts);
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    return base ? `photo_${base}_${stamp}.${ext}` : `photo_${stamp}.${ext}`;
}

/** 把 Blob 包成带正确文件名 / MIME 的 File（供 Web Share 文件分享）。 */
export function prepareChatPhotoFile(blob: Blob, caption: string | undefined | null): File {
    const mime = chatPhotoMimeOf(blob);
    return new File([blob], buildChatPhotoFileName(caption, mime), { type: mime });
}

/** Web Share 文件分享能力检测：有 share 且（没有 canShare 或 canShare({files}) 为真）。 */
export function canShareChatPhotoFile(file: File): boolean {
    return typeof navigator !== 'undefined'
        && typeof navigator.share === 'function'
        && (typeof navigator.canShare !== 'function' || navigator.canShare({ files: [file] }));
}

/** iOS / iPadOS 触屏设备（含桌面模式 iPad）。这些环境的 a.download 基本无效。 */
export function isIosLikeWeb(): boolean {
    if (typeof navigator === 'undefined') return false;
    const ua = navigator.userAgent || '';
    if (/iPhone|iPod/i.test(ua)) return true;
    if (/iPad/i.test(ua)) return true;
    return /Macintosh/i.test(ua) && typeof navigator.maxTouchPoints === 'number' && navigator.maxTouchPoints > 1;
}

/** a.download 下载兜底：临时 object URL 用完按时回收（沿用 shareExport.ts 的 1s 缓冲）。 */
export function downloadChatPhotoBlob(blob: Blob, fileName: string): void {
    if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
        throw new Error('当前环境不支持下载');
    }
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * 保存入口（必须在用户点击事件里同步调用到；File 请提前用 prepareChatPhotoFile 备好）：
 *   1) Web Share 文件分享可用 → navigator.share({ files })，用户取消返回 'cancelled'；
 *   2) iOS 类环境 → window.open 原图（优先复用调用方的显示 URL，避免再造副本），
 *      返回 'opened'，由调用方提示「长按图片存储到照片」；
 *   3) 其余 → a.download 下载，返回 'downloaded'。
 * 兜底路径里自建的 object URL 由本函数负责回收；opts.fallbackUrl 归调用方管，绝不 revoke。
 */
export async function saveChatPhotoFile(
    file: File,
    opts: { shareTitle?: string; fallbackUrl?: string } = {},
): Promise<ChatPhotoSaveOutcome> {
    if (!(file instanceof Blob) || file.size === 0) throw new Error('图片还没准备好，稍后再试');

    if (canShareChatPhotoFile(file)) {
        try {
            await navigator.share({ title: opts.shareTitle || file.name, files: [file] });
            return 'shared';
        } catch (e) {
            if ((e as { name?: string })?.name === 'AbortError') return 'cancelled';
            console.warn('[ChatPhotoViewer] Web Share 失败，走下载兜底:', e);
        }
    }

    if (isIosLikeWeb()) {
        const reuseCallerUrl = !!opts.fallbackUrl;
        const url = reuseCallerUrl ? opts.fallbackUrl! : URL.createObjectURL(file);
        const win = typeof window !== 'undefined' && typeof window.open === 'function'
            ? window.open(url, '_blank')
            : null;
        if (!reuseCallerUrl) {
            // 新标签页异步加载 blob: URL，太早 revoke 会白屏；60s 后兜底回收防泄漏。
            setTimeout(() => URL.revokeObjectURL(url), 60_000);
        }
        if (win) return 'opened';
        // window.open 被拦截：退回下载（预览里的大图本身可长按存储）。
        downloadChatPhotoBlob(file, file.name);
        return 'downloaded';
    }

    downloadChatPhotoBlob(file, file.name);
    return 'downloaded';
}
