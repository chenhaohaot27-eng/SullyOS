import { beforeEach, describe, expect, it } from 'vitest';
import { DB } from './db';
import type { CharacterProfile, Message, MessageFavorite } from '../types';
import {
    buildTextFragmentFavorite,
    cachedVoiceLinesForMessage,
    cleanupFragmentAssetIfOrphaned,
    favoriteVoiceLine,
    rememberLineAudio,
    resetLineAudioCacheForTests,
    takeLineAudioBlob,
    textFragmentId,
    voiceFragmentAssetRef,
    voiceFragmentId,
    voiceLineFragmentKey,
} from './dateFragmentFavorite';

// fake-indexeddb 已通过 test-setup.ts 注入（同 messageFavorites.db.test.ts）。
beforeEach(async () => {
    await DB.deleteDB();
    resetLineAudioCacheForTests();
});

const CHAR: CharacterProfile = { id: 'c1', name: '小鱼' } as unknown as CharacterProfile;

function makeMsg(overrides: Partial<Message> = {}): Message {
    return {
        id: 42,
        charId: 'c1',
        role: 'assistant',
        type: 'text',
        content: '"第一句台词。"\n旁白一行\n"第二句台词。"\n"晚安，好梦。"',
        timestamp: 1_700_000_000_000,
        ...overrides,
    } as Message;
}

const audioBlob = () => new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/mpeg' });

describe('dateFragmentFavorite — 文字选区收藏', () => {
    it('Test 1 — 只存选中的几个字，绝不保存整条', () => {
        const fav = buildTextFragmentFavorite({ msg: makeMsg(), char: CHAR, selectedText: '好梦', occurrence: 0 });
        expect(fav.favoriteType).toBe('text');
        expect(fav.contentSnapshot).toBe('好梦');
        expect(fav.id).toBe(textFragmentId(42, 0, '好梦'));
        expect(fav.id).not.toBe('mfav-42'); // 片段 id ≠ 旧整条 id
        expect(fav.metadataSnapshot).toEqual({ fragment: { kind: 'text', messageId: 42, occurrence: 0 } });
    });

    it('Test 2 — 同一条 Message 收藏两个不同片段：并存互不覆盖', async () => {
        const msg = makeMsg();
        const a = buildTextFragmentFavorite({ msg, char: CHAR, selectedText: '第一句台词' });
        const b = buildTextFragmentFavorite({ msg, char: CHAR, selectedText: '晚安' });
        await DB.saveMessageFavorite(a);
        await DB.saveMessageFavorite(b);
        const rows = await DB.getMessageFavorites('c1');
        expect(rows).toHaveLength(2);
        expect(rows.map(r => r.contentSnapshot).sort()).toEqual(['晚安', '第一句台词']);
    });

    it('Test 3 — 相同文本重复出现：occurrence 区分两个独立收藏', () => {
        const msg = makeMsg({ content: '"喜欢你。"\n旁白\n"喜欢你。"' });
        const first = buildTextFragmentFavorite({ msg, char: CHAR, selectedText: '喜欢你', occurrence: 0 });
        const second = buildTextFragmentFavorite({ msg, char: CHAR, selectedText: '喜欢你', occurrence: 1 });
        expect(first.id).not.toBe(second.id);
        expect(first.id).toBe(buildTextFragmentFavorite({ msg, char: CHAR, selectedText: '喜欢你', occurrence: 0 }).id);
    });

    it('Test 4 — 幂等：同一片段重复保存只有一条且保留首次时间', async () => {
        const msg = makeMsg();
        const fav = buildTextFragmentFavorite({ msg, char: CHAR, selectedText: '第二句', occurrence: 0 });
        await DB.saveMessageFavorite(fav);
        await DB.saveMessageFavorite({ ...fav, favoritedAt: fav.favoritedAt + 5000 });
        const rows = await DB.getMessageFavorites('c1');
        expect(rows).toHaveLength(1);
        expect(rows[0].favoritedAt).toBe(fav.favoritedAt);
    });

    it('Test 5 — 旧整条收藏与新片段收藏并存（DB v79 非唯一索引）', async () => {
        const msg = makeMsg();
        const whole: MessageFavorite = {
            id: 'mfav-42', sourceMessageId: 42, charId: 'c1', charNameSnapshot: '小鱼',
            messageRole: 'assistant', messageType: 'text', favoriteType: 'text',
            contentSnapshot: '旧整条', favoritedAt: 1, originalTimestamp: 1,
        };
        await DB.saveMessageFavorite(whole);
        await DB.saveMessageFavorite(buildTextFragmentFavorite({ msg, char: CHAR, selectedText: '片段A' }));
        await DB.saveMessageFavorite(buildTextFragmentFavorite({ msg, char: CHAR, selectedText: '片段B' }));
        const rows = await DB.getMessageFavorites('c1');
        expect(rows).toHaveLength(3); // 同 sourceMessageId=42 的三条共存
        expect(rows.some(r => r.id === 'mfav-42')).toBe(true);
    });
});

describe('dateFragmentFavorite — 单句语音原声收藏', () => {
    const MSG = makeMsg();
    const LINES = MSG.content.split('\n');

    it('Test 6 — 五句消息只收藏第三句：媒体与收藏只对应 lineIdx=2', async () => {
        rememberLineAudio(voiceLineFragmentKey(42, 2, LINES[2]), { url: 'blob:mock', blob: audioBlob(), lineText: LINES[2] });
        const result = await favoriteVoiceLine(
            { msg: MSG, char: CHAR, lineIdx: 2, lineText: LINES[2] },
            () => takeLineAudioBlob(voiceLineFragmentKey(42, 2, LINES[2])),
        );
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.created).toBe(true);
        expect(result.favorite.mediaRef).toBe(voiceFragmentAssetRef(42, 2, LINES[2]));
        expect(result.favorite.contentSnapshot).toBe(LINES[2]);
        expect(result.favorite.metadataSnapshot?.lazySynth).toBeUndefined(); // 原声收藏绝不 lazySynth
        // 资产已持久化且可直读原始字节
        const stored = await DB.getAssetRaw(result.favorite.mediaRef!) as { blob?: Blob } | null;
        expect(stored?.blob).toBeInstanceOf(Blob);
        // 收藏只有这一条——不含其它句
        expect(await DB.getMessageFavorites('c1')).toHaveLength(1);
    });

    it('Test 7 — 第一句和第三句分别收藏：两条独立记录、两个独立资产', async () => {
        const line0 = LINES[0], line2 = LINES[2];
        rememberLineAudio(voiceLineFragmentKey(42, 0, line0), { url: 'blob:a', blob: audioBlob(), lineText: line0 });
        rememberLineAudio(voiceLineFragmentKey(42, 2, line2), { url: 'blob:b', blob: audioBlob(), lineText: line2 });
        const r0 = await favoriteVoiceLine({ msg: MSG, char: CHAR, lineIdx: 0, lineText: line0 }, () => takeLineAudioBlob(voiceLineFragmentKey(42, 0, line0)));
        const r2 = await favoriteVoiceLine({ msg: MSG, char: CHAR, lineIdx: 2, lineText: line2 }, () => takeLineAudioBlob(voiceLineFragmentKey(42, 2, line2)));
        expect(r0.ok && r2.ok).toBe(true);
        const rows = await DB.getMessageFavorites('c1');
        expect(rows).toHaveLength(2);
        expect(new Set(rows.map(r => r.mediaRef)).size).toBe(2);
    });

    it('Test 8 — 幂等：同一句收藏两次 created=false，不重复取音频', async () => {
        const line = LINES[2];
        const key = voiceLineFragmentKey(42, 2, line);
        rememberLineAudio(key, { url: 'blob:c', blob: audioBlob(), lineText: line });
        const first = await favoriteVoiceLine({ msg: MSG, char: CHAR, lineIdx: 2, lineText: line }, () => takeLineAudioBlob(key));
        const second = await favoriteVoiceLine({ msg: MSG, char: CHAR, lineIdx: 2, lineText: line }, async () => { throw new Error('不应再次取音频'); });
        expect(first.ok && first.created).toBe(true);
        expect(second.ok && second.created === false).toBe(true);
        expect(await DB.getMessageFavorites('c1')).toHaveLength(1);
    });

    it('Test 9 — 原声未保存：明确失败，不收藏、不写资产', async () => {
        const line = LINES[0];
        const result = await favoriteVoiceLine({ msg: MSG, char: CHAR, lineIdx: 0, lineText: line }, () => takeLineAudioBlob(voiceLineFragmentKey(42, 0, line)));
        expect(result).toEqual({ ok: false, reason: 'audio_unavailable' });
        expect(await DB.getMessageFavorites('c1')).toHaveLength(0);
    });

    it('Test 10 — takeLineAudioBlob：blob 直取原始音频（同一 Blob 实例，零网络）', async () => {
        const blob = audioBlob();
        rememberLineAudio(voiceLineFragmentKey(42, 1, LINES[1]), { url: 'blob:d', blob, lineText: LINES[1] });
        await expect(takeLineAudioBlob(voiceLineFragmentKey(42, 1, LINES[1]))).resolves.toBe(blob);
        await expect(takeLineAudioBlob('missing|0|x')).resolves.toBeNull();
    });

    it('Test 11 — cachedVoiceLinesForMessage：只列播放过的句子', () => {
        rememberLineAudio(voiceLineFragmentKey(42, 2, LINES[2]), { url: 'blob:e', blob: null, lineText: LINES[2] });
        expect(cachedVoiceLinesForMessage(42).map(c => c.lineIdx)).toEqual([2]);
        expect(cachedVoiceLinesForMessage(999)).toEqual([]);
    });

    it('Test 12 — 取消收藏清理孤儿资产；仍被引用时绝不误删；voice_msg_* 永不动', async () => {
        const line = LINES[2];
        const key = voiceLineFragmentKey(42, 2, line);
        rememberLineAudio(key, { url: 'blob:f', blob: audioBlob(), lineText: line });
        const okResult = await favoriteVoiceLine({ msg: MSG, char: CHAR, lineIdx: 2, lineText: line }, () => takeLineAudioBlob(key));
        if (!okResult.ok) throw new Error('should be ok');
        const { favorite } = okResult;
        // 仍被引用 → 不删
        await cleanupFragmentAssetIfOrphaned(favorite.mediaRef);
        expect(await DB.getAssetRaw(favorite.mediaRef!)).not.toBeNull();
        // 删掉收藏 → 孤儿 → 删
        await DB.deleteMessageFavorite(favorite.id);
        await cleanupFragmentAssetIfOrphaned(favorite.mediaRef);
        expect(await DB.getAssetRaw(favorite.mediaRef!)).toBeNull();
        // 旧 voice_msg_* 语义不受影响
        await DB.saveAssetRaw('voice_msg_9', { blob: audioBlob() });
        await cleanupFragmentAssetIfOrphaned('voice_msg_9');
        expect(await DB.getAssetRaw('voice_msg_9')).not.toBeNull();
    });

    it('Test 13 — voiceFragmentId：不以台词文本为唯一索引（同文本不同行 → 不同 id）', () => {
        const sameText = '"同一句话"';
        expect(voiceFragmentId(42, 1, sameText)).not.toBe(voiceFragmentId(42, 4, sameText));
        expect(voiceFragmentId(42, 1, sameText)).toBe(voiceFragmentId(42, 1, sameText));
    });
});
