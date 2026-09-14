import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
    parseNeteaseSongId,
    isNeteaseShortLink,
    isNeteaseCnShortUrl,
    extractUrlFromShareText,
    resolveNeteaseShareInput,
    buildNeteaseShareUrl,
    buildSharedMusicCardMessage,
    songToSharedSnapshot,
    shareSongToCharacter,
    type SharedMusicSong,
} from './musicShare';
import { findPendingSharedSong } from './musicContext';
import { DB } from './db';
import { normalizeMessageContent } from './messageFormat';

const chatSource = readFileSync(fileURLToPath(new URL('../apps/Chat.tsx', import.meta.url)), 'utf-8');
const inputAreaSource = readFileSync(fileURLToPath(new URL('../components/chat/ChatInputArea.tsx', import.meta.url)), 'utf-8');

const SONG: SharedMusicSong = {
    songId: 186016,
    name: '晴天',
    artists: '周杰伦',
    album: '叶惠美',
    albumPic: 'https://p1.music.126.net/xxx.jpg',
    duration: 269,
    fee: 8,
};

describe('parseNeteaseSongId', () => {
    it('完整歌曲链接 → songId', () => {
        expect(parseNeteaseSongId('https://music.163.com/song?id=123456')).toBe(123456);
    });
    it('带 # 的 hash 路由链接 → songId', () => {
        expect(parseNeteaseSongId('https://music.163.com/#/song?id=123456')).toBe(123456);
    });
    it('分享文案里夹着链接 → songId', () => {
        expect(parseNeteaseSongId('分享周杰伦的单曲《晴天》: https://y.music.163.com/m/song?id=65786&userid=1')).toBe(65786);
    });
    it('纯数字 → songId', () => {
        expect(parseNeteaseSongId('  123456 ')).toBe(123456);
    });
    it('非法输入 → null', () => {
        expect(parseNeteaseSongId('')).toBeNull();
        expect(parseNeteaseSongId('https://www.baidu.com/s?wd=abc')).toBeNull();
        expect(parseNeteaseSongId('hello world')).toBeNull();
        expect(parseNeteaseSongId('https://music.163.com/song?idx=123')).toBeNull();
    });
    it('163cn.tv 短链识别（展开交给 resolveNeteaseShareInput，纯 parser 仍不认）', () => {
        expect(isNeteaseShortLink('https://163cn.tv/AbCdEf')).toBe(true);
        expect(isNeteaseShortLink('https://music.163.com/song?id=1')).toBe(false);
        // 短链不带 id 参数，纯同步解析必然 null —— 展开链路见下方 resolveNeteaseShareInput
        expect(parseNeteaseSongId('https://163cn.tv/AbCdEf')).toBeNull();
        expect(isNeteaseCnShortUrl('https://163cn.tv/AbCdEf')).toBe(true);
        expect(isNeteaseCnShortUrl('https://www.163cn.tv/x')).toBe(true);
        expect(isNeteaseCnShortUrl('https://music.163.com/song?id=1')).toBe(false);
        expect(isNeteaseCnShortUrl('not a url')).toBe(false);
    });
    it('shareUrl 可从 songId 反推', () => {
        expect(buildNeteaseShareUrl(123456)).toBe('https://music.163.com/song?id=123456');
    });
});

describe('extractUrlFromShareText（网易云 App 分享文案）', () => {
    it('真实手机分享文案 → 提取 163cn.tv 短链', () => {
        expect(extractUrlFromShareText('分享陈绮贞的单曲《天天想你》https://163cn.tv/bgi1Tu0V (@网易云音乐)'))
            .toBe('https://163cn.tv/bgi1Tu0V');
    });
    it('文案里夹完整链接 → 提取完整链接', () => {
        expect(extractUrlFromShareText('听听这首 https://music.163.com/song?id=186016 好吗'))
            .toBe('https://music.163.com/song?id=186016');
    });
    it('纯链接原样返回 / 无 URL 返回 null / 尾部标点剥掉', () => {
        expect(extractUrlFromShareText('https://163cn.tv/abc')).toBe('https://163cn.tv/abc');
        expect(extractUrlFromShareText('没有任何链接的文案')).toBeNull();
        expect(extractUrlFromShareText('')).toBeNull();
        expect(extractUrlFromShareText('看这个 https://163cn.tv/abc。')).toBe('https://163cn.tv/abc');
    });
});

describe('resolveNeteaseShareInput（短链展开 + 白名单 + songId）', () => {
    // expandShortUrl 走 sfworker /expand-url：{success, data:{finalUrl}}（res.text() 后 JSON.parse）
    const stubWorker = (finalUrl: string | null) => {
        const mock = vi.fn(async () => ({
            ok: true, status: 200,
            text: async () => JSON.stringify({ success: true, data: { finalUrl: finalUrl || '' } }),
        }));
        vi.stubGlobal('fetch', mock);
        return mock;
    };
    const stubNoNetwork = () => {
        const mock = vi.fn(async () => { throw new Error('不应有网络请求'); });
        vi.stubGlobal('fetch', mock);
        return mock;
    };
    beforeEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
    afterEach(() => { vi.unstubAllGlobals(); });

    it('真实手机分享文案（163cn.tv）→ Worker 展开到 music.163.com → songId', async () => {
        const fetchMock = stubWorker('https://music.163.com/song?id=123456&userid=1') as any;
        const r = await resolveNeteaseShareInput('分享陈绮贞的单曲《天天想你》https://163cn.tv/bgi1Tu0V (@网易云音乐)');
        expect(r).toEqual({ songId: 123456, viaShortLink: true });
        // 只发生了一次普通 HTTP（短链展开）；随后 song/detail 由上层另取
        expect(fetchMock.mock.calls.length).toBe(1);
        expect(fetchMock.mock.calls[0][0]).toContain('/expand-url');
    });
    it('展开到 y.music.163.com（手机端最终域）同样接受', async () => {
        stubWorker('https://y.music.163.com/m/song?id=65786');
        const r = await resolveNeteaseShareInput('https://163cn.tv/bgi1Tu0V');
        expect(r).toEqual({ songId: 65786, viaShortLink: true });
    });
    it('完整链接 / 纯数字 / 文案夹完整链接：不触发任何网络请求', async () => {
        const fetchMock = stubNoNetwork();
        expect(await resolveNeteaseShareInput('https://music.163.com/song?id=123456')).toEqual({ songId: 123456, viaShortLink: false });
        expect(await resolveNeteaseShareInput('https://music.163.com/#/song?id=123456')).toEqual({ songId: 123456, viaShortLink: false });
        expect(await resolveNeteaseShareInput(' 123456 ')).toEqual({ songId: 123456, viaShortLink: false });
        expect(await resolveNeteaseShareInput('分享单曲 https://y.music.163.com/m/song?id=65786&userid=1')).toEqual({ songId: 65786, viaShortLink: false });
        expect(fetchMock.mock.calls.length).toBe(0);
    });
    it('展开到非网易云域名 → 拒绝（null），不做开放代理', async () => {
        stubWorker('https://evil.example.com/song?id=123456');
        expect(await resolveNeteaseShareInput('https://163cn.tv/xxx')).toBeNull();
    });
    it('展开后没有 songId（如跳到网易云首页）→ null', async () => {
        stubWorker('https://music.163.com/#/discover/toplist');
        expect(await resolveNeteaseShareInput('https://163cn.tv/yyy')).toBeNull();
    });
    it('非网易云短链 / 纯文案没有 URL → null 且不发请求', async () => {
        const fetchMock = stubNoNetwork();
        expect(await resolveNeteaseShareInput('https://bitly.com/abc123')).toBeNull();
        expect(await resolveNeteaseShareInput('就是随便一句话')).toBeNull();
        expect(fetchMock.mock.calls.length).toBe(0);
    });
    it('短链展开网络失败 → 抛错（UI 给"暂时无法获取"网络提示，不落卡）', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
        await expect(resolveNeteaseShareInput('https://163cn.tv/dead')).rejects.toThrow();
    });
    it('短链解析全程 0 LLM：源码不含任何模型客户端', () => {
        const src = readFileSync(fileURLToPath(new URL('./musicShare.ts', import.meta.url)), 'utf-8');
        for (const banned of ['chatCompletionClient', 'useChatAI', 'safeApi', 'gemini', 'openai', 'triggerAI', 'chat/completions']) {
            expect(src).not.toContain(banned);
        }
    });
});

describe('buildSharedMusicCardMessage', () => {
    it('产出 role=user / type=music_card，metadata.song 字段齐全', () => {
        const msg: any = buildSharedMusicCardMessage({ charId: 'c1', song: SONG, shareUrl: 'https://music.163.com/song?id=186016' });
        expect(msg.charId).toBe('c1');
        expect(msg.role).toBe('user');
        expect(msg.type).toBe('music_card');
        expect(msg.content).toBe('[分享音乐] 《晴天》 — 周杰伦');
        expect(msg.metadata.intent).toBe('share');
        expect(msg.metadata.source).toBe('netease');
        expect(msg.metadata.shareUrl).toBe('https://music.163.com/song?id=186016');
        expect(msg.metadata.song).toEqual(SONG);
        expect(msg.metadata.song.songId).toBe(186016);
    });
    it('不传 shareUrl 时按 songId 兜底', () => {
        const msg: any = buildSharedMusicCardMessage({ charId: 'c1', song: SONG });
        expect(msg.metadata.shareUrl).toBe(buildNeteaseShareUrl(SONG.songId));
    });
});

describe('上下文/归档投影（normalizeMessageContent）', () => {
    it('user 分享卡 → 用户视角文案，不冒充角色动作', () => {
        const msg: any = {
            charId: 'c1', role: 'user', type: 'music_card',
            content: '[分享音乐] 《晴天》 — 周杰伦', timestamp: 1,
            metadata: { intent: 'share', source: 'netease', song: SONG },
        };
        const out = normalizeMessageContent(msg, '祁煜', '阿明');
        expect(out).toContain('阿明分享了一首歌');
        expect(out).toContain('《晴天》');
        expect(out).not.toContain('祁煜决定');
    });
    it('assistant 音乐卡文案不受影响（回归）', () => {
        const msg: any = {
            charId: 'c1', role: 'assistant', type: 'music_card',
            content: '[音乐卡片]', timestamp: 1,
            metadata: { intent: 'join', song: SONG },
        };
        const out = normalizeMessageContent(msg, '祁煜', '阿明');
        expect(out).toContain('祁煜决定和阿明一起听这首');
        expect(out).toContain('《晴天》');
    });
});

describe('0 token 分享链路（源码约束）', () => {
    const shareFn = () => {
        const i = chatSource.indexOf('const shareMusicMessage');
        expect(i).toBeGreaterThan(-1);
        return chatSource.slice(i, i + 1200);
    };
    it('shareMusicMessage 只落库 + 刷新，不调用任何模型', () => {
        const slice = shareFn();
        expect(slice).toContain('shareSongToCharacter(');
        expect(slice).toContain('reloadMessages');
        expect(slice).not.toContain('triggerAI(');
        expect(slice).not.toContain('completeChat(');
        expect(slice).not.toContain('safeFetchJson(');
    });
    it('+ 面板入口派发 share-music，弹窗只经 MusicShareModal 落卡', () => {
        expect(inputAreaSource).toContain(`onPanelAction('share-music')`);
        expect(chatSource).toContain(`case 'share-music': setShowPanel('none'); setShowMusicShareModal(true);`);
        expect(chatSource).toContain('<MusicShareModal');
    });
    it('musicShare.ts 不 import 任何 LLM 客户端', () => {
        const src = readFileSync(fileURLToPath(new URL('./musicShare.ts', import.meta.url)), 'utf-8');
        for (const banned of ['chatCompletionClient', 'useChatAI', 'safeApi', 'gemini', 'openai', 'triggerAI', 'chat/completions']) {
            expect(src).not.toContain(banned);
        }
    });
});

describe('音乐 App 直接分享（songToSharedSnapshot + shareSongToCharacter）', () => {
    const NeteaseSong = {
        id: 186016, name: '晴天', artists: '周杰伦', album: '叶惠美',
        albumPic: 'http://p1.music.126.net/x.jpg', duration: 269, fee: 8,
    };

    beforeEach(async () => { await DB.deleteDB(); });

    it('已有 Song → 快照：字段对齐且封面升 https', () => {
        const snap = songToSharedSnapshot(NeteaseSong);
        expect(snap).toEqual({
            songId: 186016, name: '晴天', artists: '周杰伦', album: '叶惠美',
            albumPic: 'https://p1.music.126.net/x.jpg', duration: 269, fee: 8,
        });
    });
    it('本地/合成歌曲 → null（不伪造网易云 songId）', () => {
        expect(songToSharedSnapshot({ ...NeteaseSong, local: true })).toBeNull();          // 写歌 App 本地曲
        expect(songToSharedSnapshot({ ...NeteaseSong, id: -12345 })).toBeNull();           // SongwritingApp 合成 id
        expect(songToSharedSnapshot({ ...NeteaseSong, id: 0 })).toBeNull();
        expect(songToSharedSnapshot(null)).toBeNull();
    });
    it('落库：role=user / type=music_card / metadata.song 正确，且带 shareOrigin 埋点', async () => {
        const snap = songToSharedSnapshot(NeteaseSong)!;
        const id = await shareSongToCharacter({ song: snap, charId: 'charA', shareOrigin: 'music_app' });
        expect(id).not.toBeNull();
        const msgs = await DB.getRecentMessagesByCharId('charA', 10);
        const saved: any = msgs.find(m => m.id === id);
        expect(saved.role).toBe('user');
        expect(saved.type).toBe('music_card');
        expect(saved.metadata.intent).toBe('share');
        expect(saved.metadata.source).toBe('netease');      // 入口是 music_app，歌曲 provider 仍是 netease
        expect(saved.metadata.shareOrigin).toBe('music_app');
        expect(saved.metadata.song).toEqual(snap);
        expect(saved.metadata.shareUrl).toBe('https://music.163.com/song?id=186016');
    });
    it('目标隔离：分享给 A 只出现在 A 的聊天，不污染 B', async () => {
        const snap = songToSharedSnapshot(NeteaseSong)!;
        await shareSongToCharacter({ song: snap, charId: 'charA' });
        const aMsgs = await DB.getRecentMessagesByCharId('charA', 10);
        const bMsgs = await DB.getRecentMessagesByCharId('charB', 10);
        expect(aMsgs.some(m => m.type === 'music_card')).toBe(true);
        expect(bMsgs.length).toBe(0);
    });
    it('内部分享 0 网络：歌曲数据已持有，不触发 /song/detail / 短链展开（fetch 直接抛错仍成功）', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('内部分享不应有任何网络请求'); }));
        try {
            const snap = songToSharedSnapshot(NeteaseSong)!;
            const id = await shareSongToCharacter({ song: snap, charId: 'charA', shareOrigin: 'music_app' });
            expect(id).not.toBeNull();
            expect((globalThis.fetch as any).mock.calls.length).toBe(0);
        } finally {
            vi.unstubAllGlobals();
        }
    });
    it('Phase 3 理解回归：内部分享的卡能被 findPendingSharedSong 识别', async () => {
        const snap = songToSharedSnapshot(NeteaseSong)!;
        await shareSongToCharacter({ song: snap, charId: 'charA', shareOrigin: 'music_app' });
        const msgs = await DB.getRecentMessagesByCharId('charA', 10);
        const pending = findPendingSharedSong(msgs);
        expect(pending?.song.songId).toBe(186016);
        expect(pending?.song.name).toBe('晴天');
    });
});
