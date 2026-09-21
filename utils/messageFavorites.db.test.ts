import { describe, it, expect } from 'vitest';
import { DB } from './db';
import { buildMessageFavorite, resolveFavoriteType, MESSAGE_FAVORITE_ID_PREFIX } from './messageFavoriteCapture';
import type { CharacterProfile, Message, MessageFavorite } from '../types';

// fake-indexeddb 已通过 test-setup.ts 注入。

const mkChar = (id: string, name = '测试角色'): CharacterProfile => ({ id, name, avatar: '' } as any as CharacterProfile);
const mkMsg = (id: number, over: Partial<Message> = {}): Message => ({
    id, charId: 'c1', role: 'assistant', type: 'text', content: '你好呀', timestamp: 1718000000000, ...over,
} as Message);

describe('留音海螺：收藏快照构造', () => {
    it('文字 / 语音 / 图片正确分类', () => {
        expect(resolveFavoriteType(mkMsg(1))).toBe('text');
        expect(resolveFavoriteType(mkMsg(1, { type: 'image', content: 'blobref:img1' }))).toBe('image');
        // 有合成音频 → 语音
        expect(resolveFavoriteType(mkMsg(1), { url: 'blob:x' })).toBe('voice');
        // 原文带 <语音> 标签（还没合成音频）→ 也算语音
        expect(resolveFavoriteType(mkMsg(1, { content: '<语音>你好</语音>' }))).toBe('voice');
    });

    it('id 由 sourceMessageId 决定；图片 mediaRef=content；语音 mediaRef=voice 资产 key', () => {
        const char = mkChar('c1', '小螺');
        const textFav = buildMessageFavorite({ msg: mkMsg(7), char, now: 123 });
        expect(textFav.id).toBe(`${MESSAGE_FAVORITE_ID_PREFIX}7`);
        expect(textFav.favoriteType).toBe('text');
        expect(textFav.contentSnapshot).toBe('你好呀');
        expect(textFav.mediaRef).toBeUndefined();

        const imgFav = buildMessageFavorite({ msg: mkMsg(8, { type: 'image', content: 'blobref:abc' }), char });
        expect(imgFav.favoriteType).toBe('image');
        expect(imgFav.mediaRef).toBe('blobref:abc');
        expect(imgFav.contentSnapshot).toBe('');

        const voiceFav = buildMessageFavorite({ msg: mkMsg(9), char, voiceData: { url: 'blob:y', spokenText: 'hello', lang: 'ja' } });
        expect(voiceFav.favoriteType).toBe('voice');
        expect(voiceFav.mediaRef).toBe('voice_msg_9');
        expect(voiceFav.metadataSnapshot).toEqual({ spokenText: 'hello', lang: 'ja' });
    });
});

describe('留音海螺：message_favorites store', () => {
    it('text / voice / image 收藏均落库；重复收藏幂等不产生两条', async () => {
        const char = mkChar('c1', '小螺');
        await DB.saveCharacter(char as any);
        await DB.saveMessage(mkMsg(1));
        await DB.saveMessage(mkMsg(2, { type: 'image', content: 'blobref:img1' }));
        await DB.saveMessage(mkMsg(3));

        const textFav = buildMessageFavorite({ msg: mkMsg(1), char });
        const imgFav = buildMessageFavorite({ msg: mkMsg(2, { type: 'image', content: 'blobref:img1' }), char });
        const voiceFav = buildMessageFavorite({ msg: mkMsg(3), char, voiceData: { url: 'blob:v', spokenText: '嗯' } });
        await DB.saveMessageFavorite(textFav);
        await DB.saveMessageFavorite(imgFav);
        await DB.saveMessageFavorite(voiceFav);

        // 重复收藏同一消息（不同 favoritedAt）→ 仍只有一条，且保留第一次的收藏时间
        await DB.saveMessageFavorite({ ...textFav, favoritedAt: textFav.favoritedAt + 9999 });

        const all = await DB.getMessageFavorites();
        expect(all.length).toBe(3);
        const kept = await DB.getMessageFavoriteBySource(1);
        expect(kept?.favoritedAt).toBe(textFav.favoritedAt);
    });

    it('原消息删除后收藏仍在（快照独立于消息）', async () => {
        const char = mkChar('c1');
        const msgId = await DB.saveMessage(mkMsg(0, { content: '会被删的话' }) as any);
        const fav = buildMessageFavorite({ msg: mkMsg(msgId, { content: '会被删的话' }), char });
        await DB.saveMessageFavorite(fav);
        await DB.deleteMessage(msgId);
        const still = await DB.getMessageFavoriteBySource(msgId);
        expect(still?.contentSnapshot).toBe('会被删的话');
    });

    it('按角色筛选 + 取消收藏', async () => {
        const charA = mkChar('charA', 'A');
        const charB = mkChar('charB', 'B');
        const totalBefore = (await DB.getMessageFavorites()).length;
        await DB.saveMessageFavorite(buildMessageFavorite({ msg: mkMsg(101, { charId: 'charA' }), char: charA }));
        await DB.saveMessageFavorite(buildMessageFavorite({ msg: mkMsg(102, { charId: 'charB' }), char: charB }));
        expect((await DB.getMessageFavorites('charA')).length).toBe(1);
        expect((await DB.getMessageFavorites('charB')).map(f => f.charId)).toEqual(['charB']);
        const aFav = (await DB.getMessageFavorites('charA'))[0];
        await DB.deleteMessageFavorite(aFav.id);
        expect(await DB.getMessageFavorites('charA')).toEqual([]);
        // 其它角色的收藏（含本文件更早用例的 c1 记录）不受影响，总数只少了刚删的那条
        expect((await DB.getMessageFavorites()).length).toBe(totalBefore + 1);
    });
});

describe('留音海螺：备份 roundtrip', () => {
    const clearAllFavorites = async () => {
        for (const f of await DB.getMessageFavorites()) await DB.deleteMessageFavorite(f.id);
    };

    it('exportFullData → JSON → importFullData 后收藏恢复且不重复', async () => {
        await clearAllFavorites();
        const char = mkChar('rt-char', '往返');
        await DB.saveCharacter(char as any);
        const fav: MessageFavorite = buildMessageFavorite({ msg: mkMsg(555, { charId: 'rt-char' }), char });
        await DB.saveMessageFavorite(fav);

        const exported = await DB.exportFullData();
        expect((exported.messageFavorites || []).some(f => f.id === fav.id)).toBe(true);
        const onDisk = JSON.parse(JSON.stringify(exported));

        // 清掉再恢复
        await DB.deleteMessageFavorite(fav.id);
        expect(await DB.getMessageFavorites()).toEqual([]);
        await DB.importFullData(onDisk as any, {});
        const restored = await DB.getMessageFavorites();
        expect(restored.map(f => f.id)).toEqual([fav.id]);

        // 再导一次、再恢复一次 → 仍只有一条（clearAndAdd 替换式恢复不叠加）
        const exported2 = await DB.exportFullData();
        await DB.importFullData(JSON.parse(JSON.stringify(exported2)) as any, {});
        expect((await DB.getMessageFavorites()).length).toBe(1);
    });

    it('legacy 备份没有 messageFavorites 字段 → 正常恢复为空', async () => {
        await clearAllFavorites();
        const legacy = JSON.parse(JSON.stringify(await DB.exportFullData()));
        delete legacy.messageFavorites;
        await DB.importFullData(legacy as any, {});
        expect(await DB.getMessageFavorites()).toEqual([]);
    });
});
