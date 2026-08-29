/**
 * 聊天照片全屏预览（Phase 2A.1）的接线守卫。
 *
 * 和 amsg2CharToggle.wiring.test.ts 同一套路：仓库 vitest 默认 Node 环境，
 * ChatPhotoViewer / MessageItem 是 React 组件渲染不起来测行为，这里做**源码级**断言。
 * 它验证不了运行时时序，只防「点击放大 / 三种关闭 / 长按原生菜单 / 分享-下载兜底 /
 * 不新增持久化副本」这些契约被误删或改回去。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const messageItem = read('../components/chat/MessageItem.tsx');
const viewer = read('../components/chat/ChatPhotoViewer.tsx');
const helper = read('./chatPhotoViewer.ts');

// MessageItem 里其他组件（语音条、贴纸等）合理使用 preventDefault / onContextMenu，
// 负面断言只针对聊天照片气泡这一段。
const bubbleStart = messageItem.indexOf('const ChatPhotoBubble');
const bubbleEnd = messageItem.indexOf('\n};', messageItem.indexOf('return (', bubbleStart));
const bubble = messageItem.slice(bubbleStart, bubbleEnd);

describe('点击聊天图片打开全屏预览', () => {
    it('ChatPhotoBubble 的 ready 图片是真实 <img> 且点击打开 ChatPhotoViewer', () => {
        expect(messageItem).toMatch(/import ChatPhotoViewer from '\.\/ChatPhotoViewer';/);
        expect(messageItem).toMatch(/onClick=\{\(\) => setViewerOpen\(true\)\}/);
        expect(messageItem).toMatch(/<ChatPhotoViewer\s/);
    });

    it('预览只复用消息既有的 content / 显示 URL，关闭回 bubbles 本地 state', () => {
        expect(messageItem).toMatch(/onClose=\{\(\) => setViewerOpen\(false\)\}/);
        expect(viewer).toMatch(/displayUrl: string;/);
    });

    it('气泡图片的 lazy 加载与 onMediaLoad 既有接线不被破坏', () => {
        expect(messageItem).toMatch(/loading=\{isLatestMessage \? 'eager' : 'lazy'\}/);
        expect(messageItem).toMatch(/onLoad=\{\(\) => onMediaLoad\?\.\(messageId\)\}/);
    });
});

describe('预览的三种关闭途径', () => {
    it('右上角关闭按钮', () => {
        expect(viewer).toMatch(/aria-label="关闭预览"[\s\S]{0,80}onClick=\{onClose\}/);
    });

    it('点击背景关闭（backdrop 的 onClick 就是 onClose）', () => {
        expect(viewer).toMatch(/aria-label="照片预览"[\s\S]{0,600}onClick=\{onClose\}/);
    });

    it('桌面端 Escape 关闭', () => {
        expect(viewer).toMatch(/addEventListener\('keydown'/);
        expect(viewer).toMatch(/e\.key === 'Escape'/);
        expect(viewer).toMatch(/removeEventListener\('keydown'/);
    });
});

describe('长按唤起 iOS 原生菜单的契约', () => {
    it('预览图与气泡图都是真实 <img> 且 -webkit-touch-callout: default', () => {
        expect(viewer).toMatch(/<img[\s\S]{0,400}WebkitTouchCallout: 'default'/);
        expect(messageItem).toMatch(/WebkitTouchCallout: 'default'/);
    });

    it('不拦截 contextmenu、不 preventDefault 长按/触摸事件', () => {
        for (const src of [viewer, bubble]) {
            expect(src).not.toMatch(/onContextMenu/);
            expect(src).not.toMatch(/addEventListener\('contextmenu'/);
            expect(src).not.toMatch(/\.preventDefault\(\)/);
            expect(src).not.toMatch(/onTouchStart/);
        }
    });

    it('portal 挂到 document.body，脱离聊天滚动/transform 容器，不影响聊天滚动', () => {
        expect(viewer).toMatch(/createPortal\(/);
        expect(viewer).toMatch(/document\.body/);
    });
});

describe('iPhone 安全区域与分享按钮', () => {
    it('安全区 padding 用 env(safe-area-inset-*)，关闭按钮锚在安全区内', () => {
        expect(viewer).toMatch(/env\(safe-area-inset-top/);
        expect(viewer).toMatch(/env\(safe-area-inset-bottom/);
        expect(viewer).toMatch(/env\(safe-area-inset-right/);
    });

    it('保存按钮在 File 异步备好前禁用（保证 share 落在用户点击事件内）', () => {
        expect(viewer).toMatch(/const \[preparing, setPreparing\] = useState\(true\)/);
        expect(viewer).toMatch(/disabled=\{preparing\}/);
        expect(viewer).toMatch(/prepareChatPhotoFile/);
        expect(viewer).toMatch(/saveChatPhotoFile\(/);
    });
});

describe('不新增持久化副本 / 不碰生图协议', () => {
    it('预览辅助模块绝不写库、绝不创建 blobref（只读 getBlobForRef / dataUrlToBlob）', () => {
        expect(helper).not.toMatch(/putImageBlob|saveMessage|updateMessage|blobRef:\s*['"`]/);
        expect(helper).not.toMatch(/from '\.\/db'/);
        expect(helper).not.toMatch(/imageGeneration/);
    });

    it('预览组件只读消息管线（getBlobForRef），不写 IndexedDB', () => {
        expect(viewer).toMatch(/getBlobForRef/);
        expect(viewer).not.toMatch(/putImageBlob|saveMessage|updateMessageMetadata/);
    });
});
