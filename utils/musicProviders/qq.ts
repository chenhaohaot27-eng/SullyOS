/**
 * musicProviders/qq.ts
 * QQ音乐 provider adapter。前端只访问自己 Worker 的稳定 contract
 * （POST <proxy>/qqmusic/<action>，登录态走 X-QQmusic-Cookie 头），
 * 不接触腾讯 / 第三方 API 的原始 response shape —— normalize 全在这里。
 *
 * 登录：QQ音乐扫码通道依赖官方 MQTT 推送（浏览器页面内协议，无法在 Worker 侧
 * 稳定复刻），因此本版采用与 QQMusicApi 生态一致的 Cookie 登录（y.qq.com 复制），
 * 绝不要求 QQ 密码。credential 只存设备本地，不进日志。
 *
 * 纯 normalizer 可测：fetch 实现可注入（测试里传 stub）。
 */
import type { Song } from '../../context/MusicContext';
import { providerCacheSalt } from './types';
import { cachedCall } from '../musicCache';

export interface QQMusicProfile {
    uin: string;
    nickname: string;
    avatarUrl: string;
    playlists: Array<{ id: string; name: string; cover: string; count: number }>;
}

export interface QQMusicProviderDeps {
    /** 实际网络请求（默认 globalThis.fetch，测试可注入）。 */
    fetchImpl?: typeof fetch;
}

export interface QQMusicApiCfgLike {
    workerUrl: string;
    quality: string;
    qq?: { cookie?: string };
}

const toHttps = (u: string): string => (u || '').replace(/^http:\/\//i, 'https://');

export const qqAlbumPicUrl = (pmid: string): string =>
    pmid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${pmid}.jpg` : '';

/* ───────── normalizers（Worker 统一 contract → Song / 领域类型） ───────── */

/** Worker /qqmusic/search 的单曲 → Song（source='qq'，canonical identity = songmid）。 */
export function normalizeQQTrackToSong(t: any): Song {
    return {
        id: Number(t?.songid || 0),
        name: t?.songname || '',
        artists: t?.singerNames || '',
        album: t?.albumname || '',
        albumPic: qqAlbumPicUrl(t?.albumPmid || ''),
        duration: Number(t?.interval || 0),
        fee: t?.payPlay ? 1 : 0,
        source: 'qq',
        sourceId: t?.songmid || '',
        qqMediaMid: t?.mediaMid || '',
    } as Song;
}

/** Worker /qqmusic/songlist → { id, name, cover, songs }。 */
export function normalizeQQSonglist(d: any): { id: string; name: string; cover: string; songs: Song[] } {
    const songs: Song[] = (d?.songs || []).map(normalizeQQTrackToSong);
    return {
        id: String(d?.id || ''),
        name: d?.name || '歌单',
        cover: toHttps(d?.cover || ''),
        songs,
    };
}

/** Worker /qqmusic/user/detail → QQMusicProfile。 */
export function normalizeQQProfile(d: any): QQMusicProfile | null {
    if (!d || !d.uin) return null;
    return {
        uin: String(d.uin),
        nickname: d.nickname || '',
        avatarUrl: toHttps(d.avatarUrl || ''),
        playlists: (d.playlists || []).map((p: any) => ({
            id: String(p.id || ''),
            name: p.name || '',
            cover: toHttps(p.cover || ''),
            count: Number(p.count || 0),
        })),
    };
}

/** Worker /qqmusic/login/status → 简版状态。 */
export function normalizeQQLoginStatus(d: any): { loggedIn: boolean; nickname?: string; avatarUrl?: string; uin?: string } {
    if (!d?.loggedIn) return { loggedIn: false };
    return {
        loggedIn: true,
        nickname: d.nickname || '',
        avatarUrl: toHttps(d.avatarUrl || ''),
        uin: String(d.uin || ''),
    };
}

/** 统一音质 → QQ 档位尝试顺序（与 Worker 侧一致，前端测试用）。 */
export function qqQualityAttemptOrder(quality: string): string[] {
    switch (quality) {
        case 'lossless':
        case 'hires': return ['flac', '320', '128', 'm4a'];
        case 'higher':
        case 'exhigh': return ['320', '128', 'm4a'];
        default: return ['128', 'm4a'];
    }
}

/* ───────── qqApi：统一能力入口（MusicContext / MusicApp 只面对这些） ───────── */

export function createQQMusicApi(deps: QQMusicProviderDeps = {}) {
    const doFetch = deps.fetchImpl || (globalThis.fetch.bind(globalThis) as typeof fetch);

    const raw = async (cfg: QQMusicApiCfgLike, resolveBase: () => string, action: string, body: any = {}) => {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        const cookie = (cfg.qq?.cookie || '').trim();
        if (cookie) headers['X-QQmusic-Cookie'] = cookie;
        const url = `${resolveBase()}/qqmusic/${action}`;
        const res = await doFetch(url, { method: 'POST', headers, body: JSON.stringify(body || {}) });
        const j = await res.json().catch(() => ({}));
        if (!res.ok && j?.result === undefined) throw new Error(j?.error || j?.errMsg || `HTTP ${res.status}`);
        return j;
    };

    /** 带 provider 隔离缓存的调用：key 盐 = 'qq|<cookie尾>'，与网易云完全隔离。 */
    const cached = async (cfg: QQMusicApiCfgLike, resolveBase: () => string, action: string, body: any = {}) =>
        cachedCall(`/qq/${action}`, body, providerCacheSalt('qq', cfg.qq?.cookie), () =>
            raw(cfg, resolveBase, action, body));

    const assertOk = (j: any) => {
        if (j?.result !== 100) throw new Error(j?.errMsg || `QQ音乐接口错误 (${j?.result ?? 'unknown'})`);
        return j;
    };

    return {
        /** 搜索单曲 → Song[]（source='qq'）。 */
        async search(cfg: QQMusicApiCfgLike, resolveBase: () => string, keyword: string, pageNo = 1, pageSize = 30): Promise<Song[]> {
            const j = assertOk(await cached(cfg, resolveBase, 'search', { keyword, pageNo, pageSize }));
            return (j?.data?.list || []).map(normalizeQQTrackToSong);
        },
        /** 播放地址（Worker 侧逐级音质回落，绝不让整首失败）。 */
        async songUrl(cfg: QQMusicApiCfgLike, resolveBase: () => string, song: { sourceId?: string; qqMediaMid?: string }): Promise<{ url: string; quality: string }> {
            const j = assertOk(await cached(cfg, resolveBase, 'song/url', {
                songmid: song.sourceId,
                mediaMid: song.qqMediaMid || '',
                quality: cfg.quality,
            }));
            return { url: String(j.data), quality: String(j.quality || '') };
        },
        /** 歌词（LRC 字符串 + 翻译 LRC）。 */
        async lyric(cfg: QQMusicApiCfgLike, resolveBase: () => string, songmid: string): Promise<{ lrc: string; trans: string }> {
            const j = assertOk(await cached(cfg, resolveBase, 'lyric', { songmid }));
            return { lrc: j?.data?.lrc || '', trans: j?.data?.trans || '' };
        },
        /** 登录状态。 */
        async loginStatus(cfg: QQMusicApiCfgLike, resolveBase: () => string) {
            const j = await cached(cfg, resolveBase, 'login/status', {});
            return normalizeQQLoginStatus(j?.data);
        },
        /** 用户资料 + 我的歌单。 */
        async profile(cfg: QQMusicApiCfgLike, resolveBase: () => string): Promise<QQMusicProfile | null> {
            const j = await cached(cfg, resolveBase, 'user/detail', {});
            if (j?.result === 301) return null;
            return normalizeQQProfile(j?.data);
        },
        /** 歌单详情 → 歌曲列表。 */
        async playlistTracks(cfg: QQMusicApiCfgLike, resolveBase: () => string, dissid: string) {
            const j = assertOk(await cached(cfg, resolveBase, 'songlist', { id: dissid }));
            return normalizeQQSonglist(j?.data);
        },
        /** 我喜欢的歌 songmid 列表。 */
        async likedMids(cfg: QQMusicApiCfgLike, resolveBase: () => string): Promise<string[]> {
            const j = await cached(cfg, resolveBase, 'likelist', {});
            if (j?.result === 301) return [];
            return (j?.data?.mids || []).map(String);
        },
        /** 加进「我喜欢」（QQ 侧只支持添加；取消仅本地）。 */
        async like(cfg: QQMusicApiCfgLike, resolveBase: () => string, songmid: string, like: boolean) {
            const j = assertOk(await raw(cfg, resolveBase, 'like', { songmid, like }));
            return j?.data || { ok: true };
        },
        /** 登出：清本地 credential 即可（服务端无会话）。 */
        async logout() { return true; },
    };
}

/** 默认实例（浏览器）。 */
export const qqApi = createQQMusicApi();
