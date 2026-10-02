/**
 * chatPhotoViewer（Phase 2A.1 聊天照片预览保存/分享辅助）的行为测试。
 *
 * jsdom 没有真实的 Web Share / object URL，全部用 spy 垫上；断言落在：
 *   · 文件名 / MIME 构造正确（含非法字符清洗）；
 *   · Web Share 可用时优先 navigator.share({ files }) 分享 File，用户取消不误报失败；
 *   · 不可用时回退 a.download；iOS 类环境改为 window.open 原图（长按保存提示由 UI 层给）；
 *   · 兜底路径自建的 object URL 一律按时 revoke，绝不泄漏、绝不 revoke 调用方的 URL。
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    buildChatPhotoFileName,
    chatPhotoExtOf,
    chatPhotoMimeOf,
    prepareChatPhotoFile,
    canShareChatPhotoFile,
    isIosLikeWeb,
    downloadChatPhotoBlob,
    saveChatPhotoFile,
} from './chatPhotoViewer';

// jsdom 没有 URL.createObjectURL / revokeObjectURL，垫一层并记录调用。
let blobUrlSeq = 0;
const createObjectURL = vi.fn(() => `blob:photo-${++blobUrlSeq}`);
const revokeObjectURL = vi.fn();
vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL }));

const pngBlob = (size = 8) => new Blob([new Uint8Array(size)], { type: 'image/png' });
const jpgBlob = () => new Blob([new Uint8Array(8)], { type: 'image/jpeg' });

describe('buildChatPhotoFileName / prepareChatPhotoFile', () => {
    it('MIME 兜底为 image/png，扩展名从 MIME 推导（jpeg→jpg）', () => {
        expect(chatPhotoMimeOf(pngBlob())).toBe('image/png');
        expect(chatPhotoMimeOf(new Blob([new Uint8Array(4)], { type: 'application/octet-stream' }))).toBe('image/png');
        expect(chatPhotoExtOf('image/png')).toBe('png');
        expect(chatPhotoExtOf('image/jpeg')).toBe('jpg');
        expect(chatPhotoExtOf('image/webp')).toBe('webp');
        expect(chatPhotoExtOf('image/gif')).toBe('gif');
    });

    it('caption 里的非法字符被清洗、过长被截断，文件名带扩展名', () => {
        const name = buildChatPhotoFileName('你看/我:拍*的"猫"', 'image/png', new Date('2026-01-02T03:04:05').getTime());
        expect(name).toMatch(/^photo_/);
        expect(name).toMatch(/\.png$/);
        for (const bad of ['/', ':', '*', '"', '<', '>']) expect(name).not.toContain(bad);
        const long = buildChatPhotoFileName('a'.repeat(80), 'image/jpeg', 0);
        expect(long).toMatch(/\.jpg$/);
        expect(long.length).toBeLessThan(80);
        // 无 caption 也有安全默认名。
        expect(buildChatPhotoFileName('', 'image/png', 0)).toMatch(/^photo_\d{8}-\d{4}\.png$/);
    });

    it('prepareChatPhotoFile 生成带正确文件名与 MIME 的 File，caption 保留但非法字符已清洗', () => {
        const file = prepareChatPhotoFile(jpgBlob(), '和她的合照');
        expect(file).toBeInstanceOf(File);
        expect(file.type).toBe('image/jpeg');
        expect(file.name).toMatch(/^photo_.+\.jpg$/);
        expect(file.name).toContain('和她的合照');
        expect(file.size).toBe(8);
    });
});

describe('canShareChatPhotoFile / isIosLikeWeb（feature detection）', () => {
    const file = prepareChatPhotoFile(pngBlob(), undefined);

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('没有 navigator.share 时为 false', () => {
        vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0)' });
        expect(canShareChatPhotoFile(file)).toBe(false);
    });

    it('有 share 且 canShare({files}) 通过时为 true；canShare 缺失但 share 存在时也放行', () => {
        vi.stubGlobal('navigator', {
            userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)',
            share: vi.fn(async () => {}),
            canShare: vi.fn(() => true),
        });
        expect(canShareChatPhotoFile(file)).toBe(true);
        vi.stubGlobal('navigator', { userAgent: 'x', share: vi.fn(async () => {}) });
        expect(canShareChatPhotoFile(file)).toBe(true);
    });

    it('canShare({files}) 拒绝时为 false（只允许分享文本的环境）', () => {
        vi.stubGlobal('navigator', {
            userAgent: 'x',
            share: vi.fn(async () => {}),
            canShare: vi.fn((d: { files?: unknown }) => !('files' in d)),
        });
        expect(canShareChatPhotoFile(file)).toBe(false);
    });

    it('isIosLikeWeb 识别 iPhone / iPad / 触屏 Mac，排除桌面浏览器', () => {
        const ua = (s: string, maxTouchPoints = 0) => {
            vi.stubGlobal('navigator', { userAgent: s, maxTouchPoints });
        };
        ua('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'); expect(isIosLikeWeb()).toBe(true);
        ua('Mozilla/5.0 (iPad; CPU OS 16_0)'); expect(isIosLikeWeb()).toBe(true);
        ua('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', 5); expect(isIosLikeWeb()).toBe(true);
        ua('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', 0); expect(isIosLikeWeb()).toBe(false);
        ua('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 10); expect(isIosLikeWeb()).toBe(false);
    });
});

describe('saveChatPhotoFile 分享 / 兜底路径', () => {
    let anchorClick: ReturnType<typeof vi.fn>;
    let clickedAnchor: HTMLAnchorElement | null;

    beforeEach(() => {
        vi.useFakeTimers();
        createObjectURL.mockClear();
        revokeObjectURL.mockClear();
        anchorClick = vi.fn();
        clickedAnchor = null;
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
            clickedAnchor = this;
            anchorClick();
        });
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    const stubNavigator = (nav: Record<string, unknown>) => {
        vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', ...nav });
    };

    it('Web Share 文件可用 → navigator.share 收到 File，结果 shared，不创建 object URL', async () => {
        const share = vi.fn(async () => {});
        stubNavigator({ share, canShare: () => true });
        const file = prepareChatPhotoFile(pngBlob(), 'cat');
        const outcome = await saveChatPhotoFile(file, { shareTitle: '照片' });
        expect(outcome).toBe('shared');
        expect(share).toHaveBeenCalledTimes(1);
        const payload = share.mock.calls[0][0];
        expect(payload.title).toBe('照片');
        expect(payload.files[0]).toBe(file);
        expect(payload.files[0]).toBeInstanceOf(File);
        expect(createObjectURL).not.toHaveBeenCalled();
    });

    it('用户取消分享（AbortError）→ cancelled，且不走下载兜底', async () => {
        const share = vi.fn(async () => { const e = new Error('cancel'); e.name = 'AbortError'; throw e; });
        stubNavigator({ share, canShare: () => true });
        expect(await saveChatPhotoFile(prepareChatPhotoFile(pngBlob()))).toBe('cancelled');
        expect(anchorClick).not.toHaveBeenCalled();
    });

    it('share 抛错但非取消 → 落到下载兜底（桌面）', async () => {
        const share = vi.fn(async () => { throw new Error('boom'); });
        stubNavigator({ share, canShare: () => true });
        expect(await saveChatPhotoFile(prepareChatPhotoFile(pngBlob(), 'x'))).toBe('downloaded');
        expect(anchorClick).toHaveBeenCalledTimes(1);
    });

    it('不支持文件分享（桌面）→ a.download 下载：URL 创建后按时回收', async () => {
        stubNavigator({});
        const file = prepareChatPhotoFile(pngBlob(), 'x');
        const outcome = await saveChatPhotoFile(file);
        expect(outcome).toBe('downloaded');
        expect(anchorClick).toHaveBeenCalledTimes(1);
        expect(clickedAnchor?.download).toBe(file.name);
        expect(String(clickedAnchor?.href)).toMatch(/^blob:photo-/);
        expect(createObjectURL).toHaveBeenCalledTimes(1);
        expect(revokeObjectURL).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1100);
        expect(revokeObjectURL).toHaveBeenCalledWith(createObjectURL.mock.results[0].value);
    });

    it('iOS 无文件分享 → window.open 原图：优先复用调用方 URL，不新建不回收', async () => {
        const open = vi.fn(() => ({ closed: false }));
        vi.stubGlobal('window', Object.assign(window, { open }));
        stubNavigator({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' });
        const outcome = await saveChatPhotoFile(prepareChatPhotoFile(pngBlob()), { fallbackUrl: 'blob:bubble-owned' });
        expect(outcome).toBe('opened');
        expect(open).toHaveBeenCalledWith('blob:bubble-owned', '_blank');
        expect(createObjectURL).not.toHaveBeenCalled();
        expect(revokeObjectURL).not.toHaveBeenCalled();
    });

    it('iOS 无 fallbackUrl → 自建 object URL 打开原图，60s 后兜底回收', async () => {
        const open = vi.fn(() => ({ closed: false }));
        vi.stubGlobal('window', Object.assign(window, { open }));
        stubNavigator({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' });
        expect(await saveChatPhotoFile(prepareChatPhotoFile(pngBlob()))).toBe('opened');
        expect(createObjectURL).toHaveBeenCalledTimes(1);
        expect(open).toHaveBeenCalledWith(createObjectURL.mock.results[0].value, '_blank');
        expect(revokeObjectURL).not.toHaveBeenCalled();
        vi.advanceTimersByTime(61_000);
        expect(revokeObjectURL).toHaveBeenCalledWith(createObjectURL.mock.results[0].value);
    });

    it('空文件直接抛简短错误，不崩不调分享', async () => {
        stubNavigator({ share: vi.fn(async () => {}), canShare: () => true });
        await expect(saveChatPhotoFile(new File([], 'empty.png', { type: 'image/png' })))
            .rejects.toThrow('图片还没准备好');
    });

    it('downloadChatPhotoBlob 在无 DOM 环境下给出简短错误', () => {
        const doc = (globalThis as { document?: Document }).document;
        (globalThis as { document?: Document }).document = undefined;
        try {
            expect(() => downloadChatPhotoBlob(pngBlob(), 'a.png')).toThrow('当前环境不支持下载');
        } finally {
            (globalThis as { document?: Document }).document = doc;
        }
    });
});
