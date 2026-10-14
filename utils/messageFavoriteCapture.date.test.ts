import { beforeEach, describe, expect, it } from 'vitest';
import { DB } from './db';
import type { CharacterProfile, Message } from '../types';
import {
    buildMessageFavorite,
    resolveFavoriteType,
    stripVoiceMarkersForSpeech,
    toggleMessageFavorite,
    voiceAssetKeyForMessage,
} from './messageFavoriteCapture';

// fake-indexeddb 已通过 test-setup.ts 注入（同 messageFavorites.db.test.ts）。
beforeEach(async () => {
    await DB.deleteDB();
});

const CHAR: CharacterProfile = {
    id: 'char-a',
    name: '小星',
} as unknown as CharacterProfile;

function makeMsg(overrides: Partial<Message> = {}): Message {
    return {
        id: 42,
        charId: 'char-a',
        role: 'assistant',
        type: 'text',
        content: '今晚的月色真好',
        timestamp: 1_700_000_000_000,
        ...overrides,
    } as Message;
}

describe('messageFavoriteCapture — 见面模式收藏（date）', () => {
    it('Test 1 — date 文本消息收藏：text 类型，保留角色名与原始时间', () => {
        const fav = buildMessageFavorite({ msg: makeMsg(), char: CHAR });
        expect(fav.favoriteType).toBe('text');
        expect(fav.id).toBe('mfav-42');
        expect(fav.charId).toBe('char-a');
        expect(fav.charNameSnapshot).toBe('小星');
        expect(fav.contentSnapshot).toBe('今晚的月色真好');
        expect(fav.originalTimestamp).toBe(1_700_000_000_000);
        expect(fav.mediaRef).toBeUndefined();
        expect(fav.metadataSnapshot).toBeUndefined();
    });

    it('Test 2 — date 语音收藏（forceVoice）：voice 类型 + spokenText 快照 + lazySynth 标记，不要求已有音频', () => {
        const fav = buildMessageFavorite({
            msg: makeMsg({ content: '[v:温柔]今晚的月色真好' }),
            char: CHAR,
            forceVoice: true,
        });
        expect(fav.favoriteType).toBe('voice');
        expect(fav.mediaRef).toBe(voiceAssetKeyForMessage(42)); // voice_msg_42，回放时可惰性合成
        expect(fav.metadataSnapshot?.spokenText).toBe('今晚的月色真好'); // [v:] 标记已剥
        expect(fav.metadataSnapshot?.lazySynth).toBe(true);
        expect(fav.contentSnapshot).toBe('[v:温柔]今晚的月色真好'); // 原文快照保留
    });

    it('Test 3 — stripVoiceMarkersForSpeech：剥 [v:] 与 <语音> 标记', () => {
        expect(stripVoiceMarkersForSpeech('[v:开心]你好呀<语音 lang=zh>')).toBe('你好呀');
        expect(stripVoiceMarkersForSpeech('  ')).toBe('');
        expect(stripVoiceMarkersForSpeech('没有标记的句子')).toBe('没有标记的句子');
    });

    it('Test 4 — resolveFavoriteType 兼容矩阵：image 优先 / <语音> 标签 / forceVoice / 纯文本', () => {
        expect(resolveFavoriteType(makeMsg({ type: 'image' as any, content: 'blobref:x' }))).toBe('image');
        expect(resolveFavoriteType(makeMsg({ content: '喂？<语音>' }))).toBe('voice');
        expect(resolveFavoriteType(makeMsg({ content: '普通文字' }), null, true)).toBe('voice');
        expect(resolveFavoriteType(makeMsg({ content: '普通文字' }))).toBe('text');
    });
});

describe('toggleMessageFavorite — 共享收藏开关（Chat / DateApp 同一入口）', () => {
    it('Test 5 — 幂等：toggle 收藏 → DB 仅一条；重复 save 不产生第二条；再 toggle → 取消收藏', async () => {
        // 第一次：收藏
        const first = await toggleMessageFavorite({ msg: makeMsg(), char: CHAR });
        expect(first.added).toBe(true);
        let rows = await DB.getMessageFavorites('char-a');
        expect(rows).toHaveLength(1);
        expect(rows[0].sourceMessageId).toBe(42);

        // DB 层幂等：同一收藏再 save 不产生第二条、不覆盖 favoritedAt
        await DB.saveMessageFavorite(buildMessageFavorite({ msg: makeMsg(), char: CHAR, now: 9 }));
        rows = await DB.getMessageFavorites('char-a');
        expect(rows).toHaveLength(1);
        expect(rows[0].favoritedAt).toBe(first.favorite!.favoritedAt);

        // toggle（无 wasFavorited 提示，自动查库）→ 取消收藏
        const second = await toggleMessageFavorite({ msg: makeMsg(), char: CHAR });
        expect(second.added).toBe(false);
        expect(await DB.getMessageFavorites('char-a')).toHaveLength(0);
    });

    it('Test 6 — wasFavorited 提示路径（Chat 用法）：跳查库，行为一致', async () => {
        const added = await toggleMessageFavorite({ msg: makeMsg({ id: 7 }), char: CHAR, wasFavorited: false });
        expect(added.added).toBe(true);
        const removed = await toggleMessageFavorite({ msg: makeMsg({ id: 7 }), char: CHAR, wasFavorited: true });
        expect(removed.added).toBe(false);
        expect(await DB.getMessageFavorites('char-a')).toHaveLength(0);
    });

    it('Test 7 — Chat 原路径不受影响：voiceData.url 存在时不打 lazySynth 标记', () => {
        const fav = buildMessageFavorite({
            msg: makeMsg({ content: '喂？' }),
            char: CHAR,
            voiceData: { url: 'blob:existing', spokenText: '喂？', lang: 'zh' },
        });
        expect(fav.favoriteType).toBe('voice');
        expect(fav.metadataSnapshot?.lazySynth).toBeUndefined(); // 已有音频，走直读
        expect(fav.metadataSnapshot?.spokenText).toBe('喂？');
    });

    it('Test 8 — date 与 chat 收藏同一消息 id：toggle 互通（同一收藏记录）', async () => {
        // chat 侧先收藏（文字）
        await toggleMessageFavorite({ msg: makeMsg({ id: 99 }), char: CHAR, wasFavorited: false });
        // date 侧对同一消息 toggle（自动查库发现已收藏）→ 取消
        const result = await toggleMessageFavorite({ msg: makeMsg({ id: 99 }), char: CHAR, forceVoice: true });
        expect(result.added).toBe(false);
        expect(await DB.getMessageFavorites('char-a')).toHaveLength(0);
    });
});
