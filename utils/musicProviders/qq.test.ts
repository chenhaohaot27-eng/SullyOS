import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createQQMusicApi,
    normalizeQQLoginStatus,
    normalizeQQProfile,
    normalizeQQSonglist,
    normalizeQQTrackToSong,
    qqAlbumPicUrl,
    qqQualityAttemptOrder,
} from './qq';
import { clearAll as clearMusicCache } from '../musicCache';

beforeEach(() => { localStorage.clear(); clearMusicCache(); });
afterEach(() => { localStorage.clear(); clearMusicCache(); });

const CFG = { workerUrl: '', quality: 'exhigh', qq: { cookie: 'uin=o42; qm_keyst=KEY123' } };
const BASE = () => 'https://proxy.example.com';

/** 记录每次请求 (url, body, headers) 并按队列回放响应。 */
const fetchStub = (responses: Array<{ status?: number; json: any }>) => {
    const calls: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
    const impl = (vi.fn(async (url: string, init: any) => {
        calls.push({ url, body: JSON.parse(init?.body || '{}'), headers: init?.headers || {} });
        const r = responses[Math.min(calls.length - 1, responses.length - 1)];
        return {
            ok: r.status === undefined || r.status < 400,
            status: r.status ?? 200,
            json: async () => r.json,
        } as any;
    }));
    return { impl, calls };
};

describe('QQ normalizer', () => {
    it('search 单曲 → Song（source=qq / canonical=songmid）', () => {
        const s = normalizeQQTrackToSong({
            songmid: '0039MnYb0qxYhV', songid: 97773, songname: '晴天',
            singerNames: '周杰伦', albumname: '叶惠美', albumPmid: '000MkMni19ClKG',
            mediaMid: '003Qui1q2u1Zho', interval: 269, payPlay: true,
        });
        expect(s.source).toBe('qq');
        expect(s.sourceId).toBe('0039MnYb0qxYhV');
        expect(s.id).toBe(97773);
        expect(s.fee).toBe(1);
        expect(s.albumPic).toBe(qqAlbumPicUrl('000MkMni19ClKG'));
        expect(s.duration).toBe(269);
        expect((s as any).qqMediaMid).toBe('003Qui1q2u1Zho');
    });

    it('歌单详情 normalize', () => {
        const pl = normalizeQQSonglist({
            id: '7256912512', name: '我的歌单', cover: 'http://img/example.jpg',
            songs: [{ songmid: 'a1', songid: 1, songname: 'A', singerNames: 'X', interval: 100 }],
        });
        expect(pl.name).toBe('我的歌单');
        expect(pl.cover.startsWith('https://')).toBe(true);
        expect(pl.songs[0].sourceId).toBe('a1');
    });

    it('用户资料 normalize（uin 缺失 → null）', () => {
        const p = normalizeQQProfile({ uin: '123456', nickname: '小明', avatarUrl: 'http://q.cn/a.jpg', playlists: [{ id: '1', name: 'p1', cover: '', count: 3 }] });
        expect(p?.nickname).toBe('小明');
        expect(p?.avatarUrl.startsWith('https://')).toBe(true);
        expect(p?.playlists).toHaveLength(1);
        expect(normalizeQQProfile({ nickname: '没uin' })).toBeNull();
    });

    it('login status normalize', () => {
        expect(normalizeQQLoginStatus({ loggedIn: false }).loggedIn).toBe(false);
        expect(normalizeQQLoginStatus({ loggedIn: true, nickname: 'n', avatarUrl: '', uin: '1' }).loggedIn).toBe(true);
    });

    it('音质映射与回落顺序', () => {
        expect(qqQualityAttemptOrder('standard')).toEqual(['128', 'm4a']);
        expect(qqQualityAttemptOrder('exhigh')).toEqual(['320', '128', 'm4a']);
        expect(qqQualityAttemptOrder('higher')).toEqual(['320', '128', 'm4a']);
        expect(qqQualityAttemptOrder('lossless')).toEqual(['flac', '320', '128', 'm4a']);
        expect(qqQualityAttemptOrder('hires')).toEqual(['flac', '320', '128', 'm4a']);
    });
});

describe('qqApi（注入 fetch stub）', () => {
    it('search：请求 /qqmusic/search、带 X-QQmusic-Cookie、normalize 成 Song[]', async () => {
        const { impl, calls } = fetchStub([{ json: { result: 100, data: { list: [{ songmid: 'm1', songid: 1, songname: '晴天', singerNames: '周杰伦', interval: 269 }], total: 1 } } }]);
        const api = createQQMusicApi({ fetchImpl: impl as any });
        const songs = await api.search(CFG as any, BASE, '晴天');
        expect(calls[0].url).toBe('https://proxy.example.com/qqmusic/search');
        expect(calls[0].headers['X-QQmusic-Cookie']).toBe('uin=o42; qm_keyst=KEY123');
        expect(calls[0].body).toEqual({ keyword: '晴天', pageNo: 1, pageSize: 30 });
        expect(songs[0].source).toBe('qq');
        expect(songs[0].sourceId).toBe('m1');
    });

    it('song/url：请求带 songmid / mediaMid / quality，返回 url', async () => {
        const { impl, calls } = fetchStub([{ json: { result: 100, data: 'https://aqqmusic.tc.qq.com/M500xx.mp3?vkey=1', quality: '320' } }]);
        const api = createQQMusicApi({ fetchImpl: impl as any });
        const r = await api.songUrl(CFG as any, BASE, { sourceId: 'm1', qqMediaMid: 'mm' });
        expect(r.url).toContain('https://');
        expect(r.quality).toBe('320');
        expect(calls[0].body).toEqual({ songmid: 'm1', mediaMid: 'mm', quality: 'exhigh' });
    });

    it('lyric：返回 lrc + trans', async () => {
        const { impl } = fetchStub([{ json: { result: 100, data: { lrc: '[00:01.00]晴天', trans: '[00:01.00]Sunny' } } }]);
        const api = createQQMusicApi({ fetchImpl: impl as any });
        const r = await api.lyric(CFG as any, BASE, 'm1');
        expect(r.lrc).toContain('晴天');
        expect(r.trans).toContain('Sunny');
    });

    it('login status / profile / likelist / like / logout', async () => {
        const { impl } = fetchStub([
            { json: { result: 100, data: { loggedIn: true, nickname: '小明', uin: '1' } } },
            { json: { result: 100, data: { uin: '1', nickname: '小明', avatarUrl: '', playlists: [] } } },
            { json: { result: 100, data: { mids: ['a', 'b'] } } },
            { json: { result: 100, data: { ok: true, remote: true } } },
        ]);
        const api = createQQMusicApi({ fetchImpl: impl as any });
        expect((await api.loginStatus(CFG as any, BASE)).loggedIn).toBe(true);
        expect((await api.profile(CFG as any, BASE))?.nickname).toBe('小明');
        expect(await api.likedMids(CFG as any, BASE)).toEqual(['a', 'b']);
        expect(await api.like(CFG as any, BASE, 'a', true)).toEqual({ ok: true, remote: true });
        expect(await api.logout()).toBe(true);
    });

    it('profile：301 未登录 → null（不抛）', async () => {
        const { impl } = fetchStub([{ json: { result: 301, errMsg: '未登录' } }]);
        const api = createQQMusicApi({ fetchImpl: impl as any });
        expect(await api.profile(CFG as any, BASE)).toBeNull();
    });

    it('缓存隔离：同账号同 songmid 命中缓存；换账号（换盐）必须重新请求', async () => {
        const lyricJson = { result: 100, data: { lrc: '[00:01.00]晴天', trans: '' } };
        const { impl, calls } = fetchStub([
            { json: lyricJson },
            { json: lyricJson },
        ]);
        const api = createQQMusicApi({ fetchImpl: impl as any });
        await api.lyric(CFG as any, BASE, 'm1');
        await api.lyric(CFG as any, BASE, 'm1'); // 同账号同 songmid → 缓存命中
        expect(calls).toHaveLength(1);
        await api.lyric({ ...CFG, qq: { cookie: 'uin=o99; qm_keyst=OTHER' } } as any, BASE, 'm1'); // 换账号 → 新盐
        expect(calls).toHaveLength(2);
        expect(calls[1].headers['X-QQmusic-Cookie']).toBe('uin=o99; qm_keyst=OTHER');
    });

    it('搜索失败（result!=100）时抛出 errMsg', async () => {
        const { impl } = fetchStub([{ json: { result: 400, errMsg: '获取播放链接失败' } }]);
        const api = createQQMusicApi({ fetchImpl: impl as any });
        await expect(api.search(CFG as any, BASE, 'x')).rejects.toThrow('获取播放链接失败');
    });
});
