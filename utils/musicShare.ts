/**
 * 聊天页「分享音乐」—— 用户把一首网易云歌曲作为 music_card 发给角色。
 *
 * 本文件只做三件事：
 *   1. 从用户粘贴的内容里解析网易云 songId；
 *   2. 复用现有 musicApi（Cloudflare Worker /netease/* 代理）拉 song detail 做预览；
 *   3. 组装 user 方向的 music_card 消息负载（纯函数，不落库）。
 *
 * 明确不做（Phase 3 再说）：歌词注入、模型理解、insight cache。
 * 本文件禁止 import 任何 LLM client —— 分享动作必须是 0 token 的。
 */
import { musicApi, toHttps, type MusicCfg } from '../context/MusicContext';
import { expandShortUrl } from './webpageExtractor';
import { DB } from './db';
import type { Message } from '../types';

/**
 * 用户分享出去的歌曲快照。字段与角色侧 music_card 的 MusicActionSnapshot
 * （见 utils/chatParser.ts resolveFrozenSongSnapshot 的返回）完全对齐，
 * 这样聊天卡片 / 上下文投影 / 备份恢复走的是同一副 schema。
 */
export interface SharedMusicSong {
    songId: number;
    name: string;
    artists: string;
    album: string;
    albumPic: string;
    duration: number; // 秒，与 MusicContext.Song / CharPlaylistSong 同单位
    fee: number;
}

const NETEASE_SHORT_LINK_RE = /163cn\.tv/i;

/** 163cn.tv 短链检测（网易云 App「分享 → 复制链接」产物）。展开走 resolveNeteaseShareInput。 */
export function isNeteaseShortLink(input: string): boolean {
    return NETEASE_SHORT_LINK_RE.test((input || '').trim());
}

/**
 * 从任意分享文案里提取第一个 http(s) URL（网易云 App 的分享文本形如
 * 「分享陈绮贞的单曲《天天想你》https://163cn.tv/xxx (@网易云音乐)」）。
 * 纯函数，不做任何网络请求。
 */
export function extractUrlFromShareText(raw: string): string | null {
    const text = (raw || '').trim();
    if (!text) return null;
    const m = text.match(/https?:\/\/[^\s，。！？；、"'《》【】（）]+/i);
    if (!m) return null;
    // 去掉蹭在链接尾部的英文标点（中文标点已被上面的字符集挡在外面）
    return m[0].replace(/[.,;:!?'"）)\]】]+$/, '') || null;
}

/** 是否网易云手机短域名（只有这个域名允许送进短链展开）。 */
export function isNeteaseCnShortUrl(url: string): boolean {
    try {
        const host = new URL(url).hostname.toLowerCase();
        return host === '163cn.tv' || host === 'www.163cn.tv';
    } catch { return false; }
}

/** 短链展开后允许落地的网易云域名白名单——绝不做成任意 URL 代理。 */
const NETEASE_ALLOWED_FINAL_HOSTS = ['music.163.com', 'y.music.163.com'];

function isAllowedNeteaseFinalUrl(url: string): boolean {
    try {
        const host = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
        return NETEASE_ALLOWED_FINAL_HOSTS.some(d => host === d || host.endsWith(`.${d}`));
    } catch { return false; }
}

/**
 * 解析用户输入 → songId。支持的输入：
 *   纯数字 songId / 完整 music.163.com 链接（含 #/ hash 路由）/ 夹在分享文案里的完整链接 /
 *   夹在分享文案里的 163cn.tv 短链（经现有 Worker /expand-url 展开后再解析）。
 *
 * 网络行为：只有 163cn.tv 短链会触发一次普通 HTTP 展开（复用 expandShortUrl，非 LLM）；
 * 展开失败/超时抛错（UI 给网络提示），展开结果不是网易云域名 / 无 songId 返回 null（UI 给
 * 「没识别到」提示）。安全边界：只主动展开 163cn.tv，展开结果必须落在网易云白名单域名。
 */
export async function resolveNeteaseShareInput(raw: string): Promise<{ songId: number; viaShortLink: boolean } | null> {
    const text = (raw || '').trim();
    if (!text) return null;
    // ① 纯数字 / 文案里带 id= 的完整链接：纯同步解析就够了
    const direct = parseNeteaseSongId(text);
    if (direct != null) return { songId: direct, viaShortLink: false };
    // ② 从分享文案提取第一个 URL 再试一次（文案形态五花八门，先抽链接再判断）
    const url = extractUrlFromShareText(text);
    if (!url) return null;
    const directFromUrl = parseNeteaseSongId(url);
    if (directFromUrl != null) return { songId: directFromUrl, viaShortLink: false };
    // ③ 163cn.tv 短链：Worker 展开（普通 HTTP，0 LLM）→ 域名白名单 → 复用同一个纯解析器
    if (!isNeteaseCnShortUrl(url)) return null;
    const finalUrl = await expandShortUrl(url);
    if (!isAllowedNeteaseFinalUrl(finalUrl)) return null;
    const songId = parseNeteaseSongId(finalUrl);
    return songId != null ? { songId, viaShortLink: true } : null;
}

/**
 * 解析网易云 songId。支持：
 *   - 纯数字 songId
 *   - https://music.163.com/song?id=123
 *   - https://music.163.com/#/song?id=123（hash 路由）
 *   - 分享文案里任意带 id=123 的网易云链接
 * 认不出返回 null（含 163cn.tv 短链——短链不带 id，展开由 resolveNeteaseShareInput 负责）。
 */
export function parseNeteaseSongId(input: string): number | null {
    const raw = (input || '').trim();
    if (!raw) return null;
    if (/^\d{1,20}$/.test(raw)) return Number(raw);
    // query 参数 id=（普通路由和 #/ hash 路由的 songId 都挂在 query 上）
    const idMatch = raw.match(/[?&]id=(\d{1,20})/);
    if (idMatch) return Number(idMatch[1]);
    return null;
}

export function buildNeteaseShareUrl(songId: number): string {
    return `https://music.163.com/song?id=${songId}`;
}

/**
 * 音乐 App 里已有的 Song → 分享快照。
 * 只接受网易云歌曲（id > 0 且非 local 本地生成曲——SongwritingApp 的合成曲用负数 id）。
 * 本地歌曲没有稳定网易云 songId / 歌词 provider，硬造 songId 会污染后续歌词理解与
 * insight 缓存（key 是 netease:<songId>:v1），所以直接返回 null 由 UI 提示不支持。
 */
export function songToSharedSnapshot(song: {
    id: number; name: string; artists: string; album: string;
    albumPic: string; duration: number; fee: number; local?: boolean;
} | null | undefined): SharedMusicSong | null {
    if (!song) return null;
    if (song.local) return null;
    if (typeof song.id !== 'number' || !Number.isInteger(song.id) || song.id <= 0) return null;
    if (!song.name) return null;
    return {
        songId: song.id,
        name: song.name,
        artists: song.artists || '',
        album: song.album || '',
        albumPic: toHttps(song.albumPic || ''),
        duration: typeof song.duration === 'number' && song.duration > 0 ? song.duration : 0,
        fee: typeof song.fee === 'number' ? song.fee : 0,
    };
}

/** song/detail 的 ar/al/dt 原始字段 → 统一快照（与 MusicApp 搜索结果同一套归一化口径）。 */
function normalizeDetailSong(s: any): SharedMusicSong | null {
    if (!s || typeof s.id !== 'number' || !s.name) return null;
    return {
        songId: s.id,
        name: String(s.name),
        artists: (s.ar || s.artists || []).map((a: any) => a?.name).filter(Boolean).join(' / '),
        album: s.al?.name || s.album?.name || '',
        albumPic: toHttps(s.al?.picUrl || s.album?.picUrl || ''),
        duration: Math.round(((s.dt || s.duration || 0) / 1000) * 10) / 10,
        fee: typeof s.fee === 'number' ? s.fee : 0,
    };
}

/**
 * songId → 预览快照。复用现有 musicApi（Worker /netease/song/detail），
 * 不新建任何网易云 client。失败抛错，由 UI 层提示，绝不落半空卡片。
 */
export async function resolveSharedSong(cfg: MusicCfg, songId: number): Promise<SharedMusicSong> {
    const res = await musicApi.call(cfg, '/song/detail', { ids: [songId] });
    const song = normalizeDetailSong(res?.songs?.[0]);
    if (!song) throw new Error('netease song/detail empty');
    return song;
}

/**
 * 组装 user 方向的 music_card 负载。纯函数、不落库 ——
 * 落库统一走 shareSongToCharacter（聊天页 / 音乐 App 共用同一入口），
 * 那条链路上没有任何模型调用。
 */
export function buildSharedMusicCardMessage(input: {
    charId: string;
    song: SharedMusicSong;
    shareUrl?: string;
    timestamp?: number;
    /** 可选：入口来源标记（如 'music_app'）。仅埋点用，不影响歌曲 provider——歌曲本体来自网易云，source 恒为 netease。 */
    shareOrigin?: string;
}): Omit<Message, 'id' | 'timestamp'> & { timestamp?: number } {
    const { charId, song, shareUrl, timestamp, shareOrigin } = input;
    const songDesc = song.artists ? `《${song.name}》 — ${song.artists}` : `《${song.name}》`;
    return {
        charId,
        role: 'user',
        type: 'music_card',
        content: `[分享音乐] ${songDesc}`,
        ...(timestamp != null ? { timestamp } : {}),
        metadata: {
            intent: 'share',
            source: 'netease',
            shareUrl: shareUrl || buildNeteaseShareUrl(song.songId),
            ...(shareOrigin ? { shareOrigin } : {}),
            song,
        },
    };
}

/**
 * 统一分享落库入口（聊天页粘贴链接 / 音乐 App 直接分享都走这里）：
 * 快照 → music_card → DB.saveMessage → 返回新消息 id。
 *
 * 铁律与 Phase 2 相同：0 次 LLM、0 次歌曲信息网络请求（歌曲数据调用方已经持有）。
 * 不刷新任何 React 状态 —— UI 层各自负责 reload / toast / 留在当前页面。
 */
export async function shareSongToCharacter(input: {
    song: SharedMusicSong;
    charId: string;
    shareUrl?: string;
    shareOrigin?: string;
}): Promise<number | null> {
    const { song, charId, shareUrl, shareOrigin } = input;
    if (!song || typeof song.songId !== 'number' || !song.name || !charId) return null;
    return DB.saveMessage(buildSharedMusicCardMessage({ charId, song, shareUrl, shareOrigin }));
}
