import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
    findPendingSharedSong,
    normalizeNeteaseLyrics,
    sampleLyricsForContext,
    LYRICS_CONTEXT_CHAR_CAP,
    getMusicInsight,
    setMusicInsight,
    sanitizeMusicInsight,
    extractMusicInsightMarker,
    stripMusicInsightMarkers,
    harvestMusicInsight,
    buildSharedSongContextBlock,
} from './musicContext';
import { ChatPrompts } from './chatPrompts';
import { clearAll as clearMusicApiCache } from './musicCache';
import type { Message } from '../types';
import type { SharedMusicSong } from './musicShare';

const chatParserSource = readFileSync(fileURLToPath(new URL('./chatParser.ts', import.meta.url)), 'utf-8');
const payloadSource = readFileSync(fileURLToPath(new URL('./chatRequestPayload.ts', import.meta.url)), 'utf-8');
const musicContextSource = readFileSync(fileURLToPath(new URL('./musicContext.ts', import.meta.url)), 'utf-8');

const SONG: SharedMusicSong = {
    songId: 186016, name: '晴天', artists: '周杰伦', album: '叶惠美',
    albumPic: 'https://p1.music.126.net/x.jpg', duration: 269, fee: 8,
};

let seq = 0;
const msg = (role: Message['role'], type: Message['type'], extra: any = {}, content = 'hi'): Message => ({
    id: ++seq, charId: 'c1', role, type, content, timestamp: seq, metadata: extra.metadata,
});
const shareMsg = (song: SharedMusicSong = SONG): Message => msg('user', 'music_card', {
    metadata: { intent: 'share', source: 'netease', shareUrl: `https://music.163.com/song?id=${song.songId}`, song },
});

describe('findPendingSharedSong（A/B/C/D 场景）', () => {
    it('A：分享后未回复 → 命中', () => {
        const pending = findPendingSharedSong([msg('user', 'text'), shareMsg()]);
        expect(pending?.song.songId).toBe(SONG.songId);
        expect(pending?.shareUrl).toContain('music.163.com');
    });
    it('B：分享已被 assistant 回复 → null（不重复注入）', () => {
        const pending = findPendingSharedSong([shareMsg(), msg('assistant', 'text')]);
        expect(pending).toBeNull();
    });
    it('C：分享后又发一句文字 → 仍命中', () => {
        const pending = findPendingSharedSong([shareMsg(), msg('user', 'text', {}, '你听听这个')]);
        expect(pending?.song.songId).toBe(SONG.songId);
    });
    it('D：A 已回复后再分享 B → 只命中 B', () => {
        const songB = { ...SONG, songId: 1, name: 'B 歌' };
        const pending = findPendingSharedSong([
            shareMsg(), msg('assistant', 'text'), shareMsg(songB),
        ]);
        expect(pending?.song.songId).toBe(1);
    });
    it('没有分享 / 只有角色侧 MUSIC_ACTION 卡 → null', () => {
        expect(findPendingSharedSong([])).toBeNull();
        expect(findPendingSharedSong([msg('user', 'text')])).toBeNull();
        // 角色（assistant）侧的音乐动作卡不是用户分享，不算待回应
        expect(findPendingSharedSong([msg('assistant', 'music_card', { metadata: { intent: 'join', song: SONG } })])).toBeNull();
    });
});

describe('normalizeNeteaseLyrics', () => {
    it('去时间戳、丢 metadata 行/空行、按时间戳排序', () => {
        const lrc = [
            '[ti:晴天]',
            '[ar:周杰伦]',
            '[00:01.00]故事的小黄花',
            '[00:02.00]',
            '[00:03.50]从出生那年就飘着',
            '[00:02.20]插队在中间的一句',
        ].join('\n');
        const out = normalizeNeteaseLyrics(lrc);
        const lines = out.split('\n');
        expect(lines).toEqual(['故事的小黄花', '插队在中间的一句', '从出生那年就飘着']);
        expect(out).not.toContain('[');
        expect(out).not.toContain('ti:');
    });
    it('连续重复行折叠，文字本身不变', () => {
        const out = normalizeNeteaseLyrics('[00:01.00]风吹过\n[00:02.00]风吹过\n[00:03.00]风吹过\n[00:04.00]雨落下');
        expect(out).toBe('风吹过\n雨落下');
    });
    it('空输入 → 空串', () => {
        expect(normalizeNeteaseLyrics('')).toBe('');
        expect(normalizeNeteaseLyrics('[ti:纯音乐]')).toBe('');
    });
});

describe('sampleLyricsForContext（token 压缩）', () => {
    it('总量没超上限 → 原样返回', () => {
        const text = '一行\n两行\n三行';
        expect(sampleLyricsForContext(text, 100)).toBe(text);
    });
    it('超上限 → 前/中/后确定性采样 + 省略号，长度受控', () => {
        const lines = Array.from({ length: 300 }, (_, i) => `歌词第${i}行`);
        const text = lines.join('\n');
        const sampled = sampleLyricsForContext(text, 300);
        expect(sampled.length).toBeLessThanOrEqual(300 + 16);
        expect(sampled).toContain('歌词第0行');            // 头
        expect(sampled).toContain(`歌词第${lines.length - 1}行`); // 尾
        expect(sampled).toContain('……');
        // 确定性：同一输入两次采样完全一致
        expect(sampleLyricsForContext(text, 300)).toBe(sampled);
        // 原始文字不被改写（出现的行都是原文行）
        for (const l of sampled.split('\n')) {
            if (l !== '……') expect(lines).toContain(l);
        }
    });
});

describe('musicInsightCache', () => {
    beforeEach(() => { localStorage.clear(); });

    it('set/get 往返 + key 形如 netease:<songId>:v1', () => {
        setMusicInsight({ songId: 42, title: 'T', artist: 'A', themes: ['离别'], mood: ['平静'], narrative: 'n', keyIdeas: ['k'], updatedAt: 1, version: 1 });
        expect(localStorage.getItem('netease:42:v1')).toBeTruthy();
        const got = getMusicInsight(42);
        expect(got?.title).toBe('T');
        expect(got?.version).toBe(1);
    });
    it('脏数据（缺 title/artist、songId 非法）→ null，不进 prompt', () => {
        expect(sanitizeMusicInsight({ songId: 1, title: '', artist: '', themes: ['x'] })).toBeNull();
        expect(sanitizeMusicInsight({ songId: 'abc', title: 't' })).toBeNull();
        localStorage.setItem('netease:7:v1', '{not json');
        expect(getMusicInsight(7)).toBeNull();
    });
});

describe('MUSIC_INSIGHT 标记提取/剥离', () => {
    beforeEach(() => { localStorage.clear(); });

    it('合法标记 → insight 解析成功 + 正文彻底剥离', () => {
        const reply = '这句我知道你为什么会发给我。\n[[MUSIC_INSIGHT:{"songId":186016,"title":"晴天","artist":"周杰伦","themes":["青春"],"mood":["克制"],"narrative":"雨天告别","keyIdeas":["握住你的手"]}]]';
        const { insight, cleaned } = extractMusicInsightMarker(reply);
        expect(insight?.songId).toBe(186016);
        expect(insight?.themes).toEqual(['青春']);
        expect(cleaned).toBe('这句我知道你为什么会发给我。');
        expect(cleaned).not.toContain('MUSIC_INSIGHT');
    });
    it('非法 JSON → insight 为 null，但标记照样剥干净', () => {
        const reply = '正常回复[[MUSIC_INSIGHT:{bad json}]]';
        const { insight, cleaned } = extractMusicInsightMarker(reply);
        expect(insight).toBeNull();
        expect(cleaned).toBe('正常回复');
    });
    it('无标记 → 原样', () => {
        expect(stripMusicInsightMarkers('普通回复')).toBe('普通回复');
    });
    it('harvest：提取即落缓存，返回净文', () => {
        const cleaned = harvestMusicInsight('回复正文[[MUSIC_INSIGHT:{"songId":9,"title":"T","artist":"A"}]]');
        expect(cleaned).toBe('回复正文');
        expect(getMusicInsight(9)?.title).toBe('T');
    });
});

describe('buildSharedSongContextBlock（cache miss / hit / 歌词失败）', () => {
    const CFG = { workerUrl: '', cookie: '', quality: 'standard' } as any;
    const LYRIC_LRC = '[00:10.00]故事的小黄花\n[00:20.00]从出生那年就飘着\n[00:30.00]童年的荡秋千';

    beforeEach(() => {
        localStorage.clear();
        clearMusicApiCache(); // musicApi 的内存缓存层跨用例残留会让 fetch stub 失真
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true, status: 200,
            json: async () => ({ lrc: { lyric: LYRIC_LRC } }),
        })));
    });
    afterEach(() => { vi.unstubAllGlobals(); });

    it('cache miss + 歌词可取 → metadata + 歌词材料 + 标记指令 + 反幻觉约束', async () => {
        const block = await buildSharedSongContextBlock({ song: SONG, cfg: CFG, userName: '阿明' });
        expect(block).toBeTruthy();
        expect(block).toContain('《晴天》');
        expect(block).toContain('周杰伦');
        expect(block).toContain('歌词材料');
        expect(block).toContain('故事的小黄花');
        expect(block).toContain('[[MUSIC_INSIGHT:');
        expect(block).toContain('不要虚构编曲');
    });

    it('cache hit → 精简 insight，不再注入歌词、不再要标记', async () => {
        setMusicInsight({ songId: SONG.songId, title: '晴天', artist: '周杰伦', themes: ['青春', '遗憾'], mood: ['克制'], narrative: '雨天告别', keyIdeas: ['握住你的手'], updatedAt: 1, version: 1 });
        const block = await buildSharedSongContextBlock({ song: SONG, cfg: CFG, userName: '阿明' });
        expect(block).toContain('理解摘要');
        expect(block).toContain('雨天告别');
        expect(block).not.toContain('故事的小黄花');
        expect(block).not.toContain('[[MUSIC_INSIGHT:');
        // fetch 不应被调用（歌词整段跳过）
        expect((globalThis.fetch as any).mock.calls.length).toBe(0);
    });

    it('歌词拉取失败 → 降级 metadata-only，仍可构建请求，且不假装知道歌词', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
        const block = await buildSharedSongContextBlock({ song: SONG, cfg: CFG, userName: '阿明' });
        expect(block).toContain('《晴天》');
        expect(block).toContain('没有拿到这首歌的歌词材料');
        expect(block).not.toContain('歌词材料（节选）');
        expect(block).not.toContain('[[MUSIC_INSIGHT:');
    });

    it('没有 cfg 也绝不抛错 → metadata-only', async () => {
        const block = await buildSharedSongContextBlock({ song: SONG, cfg: null, userName: '阿明' });
        expect(block).toContain('《晴天》');
        expect(block).toContain('没有拿到这首歌的歌词材料');
    });

    it('歌词为空（纯音乐）→ metadata-only', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ lrc: { lyric: '' } }) })));
        const block = await buildSharedSongContextBlock({ song: SONG, cfg: CFG, userName: '阿明' });
        expect(block).toContain('没有拿到这首歌的歌词材料');
    });
});

describe('历史投影：旧分享只是一行短引用（不带歌词）', () => {
    it('buildMessageHistory 把 user music_card 投影成单行，且不含歌曲 metadata JSON', () => {
        const char = { id: 'c1', name: '祁煜', contextRangePolicyVersion: 1 } as any;
        const userProfile = { name: '阿明', bio: '' } as any;
        const messages = [
            shareMsg(),
            msg('assistant', 'text', {}, '收到，我听听'),
            msg('user', 'text', {}, '普通聊天'),
        ];
        const built = (ChatPrompts as any).buildMessageHistory(messages, 20, char, userProfile, [], undefined, { includeTimeGapHint: false });
        const shareLine = (built.apiMessages || built.messages).find((m: any) => typeof m.content === 'string' && m.content.includes('用户分享音乐'));
        expect(shareLine).toBeTruthy();
        expect(shareLine.content).toContain('《晴天》');
        expect(shareLine.content).toContain('周杰伦');
        expect(shareLine.content).not.toContain('albumPic');
        expect(shareLine.content.length).toBeLessThan(80);
    });
});

describe('单次模型调用铁律（源码约束）', () => {
    it('musicContext.ts 不 import 任何 LLM 客户端', () => {
        for (const banned of ['chatCompletionClient', 'useChatAI', 'safeApi', 'gemini', 'openai', 'completeChat']) {
            expect(musicContextSource).not.toContain(banned);
        }
    });
    it('chatParser 的 MUSIC_INSIGHT 分支只做本地提取+缓存，无网络无模型', () => {
        const slice = chatParserSource.slice(
            chatParserSource.indexOf('MUSIC_INSIGHT — 模型在同一次正常回复'),
            chatParserSource.indexOf('MUSIC_INSIGHT — 模型在同一次正常回复') + 700,
        );
        expect(slice).toContain('harvestMusicInsight');
        expect(slice).not.toContain('fetch(');
        expect(slice).not.toContain('completeChat');
    });
    it('chatRequestPayload 音乐块：只拉上下文材料，不发生成请求', () => {
        const slice = payloadSource.slice(
            payloadSource.indexOf('findPendingSharedSong(input.historyMsgs)'),
            payloadSource.indexOf('findPendingSharedSong(input.historyMsgs)') + 600,
        );
        expect(slice).toContain('buildSharedSongContextBlock');
        expect(slice).not.toContain('completeChat');
        expect(slice).not.toContain('safeFetchJson(');
        expect(slice).not.toContain('triggerAI');
    });
    it('歌词注入有硬上限常量且 ≤1800', () => {
        expect(LYRICS_CONTEXT_CHAR_CAP).toBeLessThanOrEqual(1800);
    });
});
