import { describe, it, expect } from 'vitest';
import { DB } from './db';
import {
    syncAssistantPhotoToGallery,
    deleteGalleryImageWithGC,
    isBlobRefReferencedAnywhere,
} from './gallerySync';
import { putImageBlob } from './blobRef';
import { buildMessageFavorite } from './messageFavoriteCapture';
import type { CharacterProfile, GalleryImage, Message } from '../types';

// fake-indexeddb 已通过 test-setup.ts 注入。

const mkChar = (id: string): CharacterProfile => ({ id, name: id, avatar: '' } as any as CharacterProfile);
const mkMsg = (id: number, over: Partial<Message> = {}): Message => ({
    id, charId: 'gc-char', role: 'assistant', type: 'image', content: '', timestamp: Date.now(), ...over,
} as Message);

describe('相册：assistant 生图自动入相册', () => {
    it('成功生成 → 入相册，charId / timestamp / savedDate 正确', async () => {
        await syncAssistantPhotoToGallery({ charId: 'gc-char', messageId: 501, url: 'blobref:photo-a', caption: '海边的下午', now: 1750000000000 });
        const imgs = await DB.getGalleryImages('gc-char');
        expect(imgs.length).toBe(1);
        expect(imgs[0].id).toBe('chatphoto-501');
        expect(imgs[0].charId).toBe('gc-char');
        expect(imgs[0].url).toBe('blobref:photo-a');
        expect(imgs[0].timestamp).toBe(1750000000000);
        expect(imgs[0].savedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(imgs[0].chatContext?.length).toBeGreaterThan(0);
    });

    it('同一消息重复同步（重试 / 重放 / 恢复）→ 不重复插入', async () => {
        await syncAssistantPhotoToGallery({ charId: 'gc-char', messageId: 502, url: 'blobref:photo-b' });
        await syncAssistantPhotoToGallery({ charId: 'gc-char', messageId: 502, url: 'blobref:photo-b' });
        await syncAssistantPhotoToGallery({ charId: 'gc-char', messageId: 502, url: 'blobref:photo-b' });
        const imgs = (await DB.getGalleryImages('gc-char')).filter(i => i.id === 'chatphoto-502');
        expect(imgs.length).toBe(1);
    });

    it('失败中的生成图（空 url 占位）不入相册', async () => {
        await syncAssistantPhotoToGallery({ charId: 'gc-char', messageId: 503, url: '' });
        const imgs = (await DB.getGalleryImages('gc-char')).filter(i => i.id === 'chatphoto-503');
        expect(imgs.length).toBe(0);
    });

    it('用户手动发图的原行为不变（普通 saveGalleryImage 仍可用）', async () => {
        const userImg: GalleryImage = { id: `img-${Date.now()}-user`, charId: 'gc-char', url: 'data:image/png;base64,xxx', timestamp: Date.now() };
        await DB.saveGalleryImage(userImg);
        const imgs = await DB.getGalleryImages('gc-char');
        expect(imgs.some(i => i.id === userImg.id)).toBe(true);
    });
});

describe('相册：删除与 Blob GC', () => {
    it('删除 gallery record（data URL 图片：记录消失即可）', async () => {
        const img: GalleryImage = { id: 'del-1', charId: 'gc-char', url: 'data:image/png;base64,zzz', timestamp: Date.now() };
        await DB.saveGalleryImage(img);
        const { blobDeleted } = await deleteGalleryImageWithGC(img);
        expect(blobDeleted).toBe(false); // data URL 不是 blobref
        expect((await DB.getGalleryImages('gc-char')).some(i => i.id === 'del-1')).toBe(false);
    });

    it('独占 blob：无任何引用 → 删除记录并 GC blob asset', async () => {
        const blob = new Blob(['orphan-bytes'], { type: 'image/png' });
        const ref = await putImageBlob(blob);
        const img: GalleryImage = { id: 'del-orphan', charId: 'gc-char', url: ref, timestamp: Date.now() };
        await DB.saveGalleryImage(img);
        // 只有 gallery 引用它
        expect(await isBlobRefReferencedAnywhere(ref, { skipGalleryId: 'del-orphan' })).toBe(false);
        const { blobDeleted } = await deleteGalleryImageWithGC(img);
        expect(blobDeleted).toBe(true);
        // blob asset 已真正删除
        const blobId = ref.slice('blobref:'.length);
        expect(await DB.getBlobAsset(blobId)).toBeFalsy();
    });

    it('shared blob：仍被聊天消息引用时不删', async () => {
        const blob = new Blob(['shared-msg'], { type: 'image/png' });
        const ref = await putImageBlob(blob);
        await DB.saveMessage({ ...mkMsg(601, { content: ref }) } as any);
        const img: GalleryImage = { id: 'del-shared-msg', charId: 'gc-char', url: ref, timestamp: Date.now() };
        await DB.saveGalleryImage(img);
        const { blobDeleted } = await deleteGalleryImageWithGC(img);
        expect(blobDeleted).toBe(false);
        const blobId = ref.slice('blobref:'.length);
        expect(await DB.getBlobAsset(blobId)).toBeTruthy();
    });

    it('shared blob：仍被留音海螺收藏引用时不删', async () => {
        const blob = new Blob(['shared-fav'], { type: 'image/png' });
        const ref = await putImageBlob(blob);
        const char = mkChar('gc-char');
        await DB.saveMessageFavorite(buildMessageFavorite({ msg: mkMsg(602, { content: ref }), char }));
        const img: GalleryImage = { id: 'del-shared-fav', charId: 'gc-char', url: ref, timestamp: Date.now() };
        await DB.saveGalleryImage(img);
        const { blobDeleted } = await deleteGalleryImageWithGC(img);
        expect(blobDeleted).toBe(false);
    });

    it('shared blob：仍被另一条相册记录引用时不删', async () => {
        const blob = new Blob(['shared-gal'], { type: 'image/png' });
        const ref = await putImageBlob(blob);
        await DB.saveGalleryImage({ id: 'gal-other', charId: 'gc-char', url: ref, timestamp: Date.now() });
        const img: GalleryImage = { id: 'gal-this', charId: 'gc-char', url: ref, timestamp: Date.now() };
        await DB.saveGalleryImage(img);
        const { blobDeleted } = await deleteGalleryImageWithGC(img);
        expect(blobDeleted).toBe(false);
        expect((await DB.getGalleryImages('gc-char')).some(i => i.id === 'gal-other')).toBe(true);
    });

    it('备份/恢复不重复：galleryImages 替换式恢复，chatphoto 记录不叠加', async () => {
        await syncAssistantPhotoToGallery({ charId: 'gc-char', messageId: 701, url: 'blobref:photo-r' });
        const exported = await DB.exportFullData();
        await DB.importFullData(JSON.parse(JSON.stringify(exported)) as any, {});
        const imgs = (await DB.getGalleryImages('gc-char')).filter(i => i.id === 'chatphoto-701');
        expect(imgs.length).toBe(1);
        // 再次导出+恢复仍只有一条
        const exported2 = await DB.exportFullData();
        await DB.importFullData(JSON.parse(JSON.stringify(exported2)) as any, {});
        expect((await DB.getGalleryImages('gc-char')).filter(i => i.id === 'chatphoto-701').length).toBe(1);
    });
});
