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

/** 163cn.tv 短链本阶段不展开（避免新造解析链路），调用方据此给出「请粘贴完整链接」提示。 */
export function isNeteaseShortLink(input: string): boolean {
    return NETEASE_SHORT_LINK_RE.test((input || '').trim());
}

/**
 * 解析网易云 songId。支持：
 *   - 纯数字 songId
 *   - https://music.163.com/song?id=123
 *   - https://music.163.com/#/song?id=123（hash 路由）
 *   - 分享文案里任意带 id=123 的网易云链接
 * 认不出返回 null（含 163cn.tv 短链——它们不带 id 参数）。
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
 * 落库（DB.saveMessage + reloadMessages）由 Chat.tsx 的 shareMusicMessage 做，
 * 那条链路上没有任何模型调用。
 */
export function buildSharedMusicCardMessage(input: {
    charId: string;
    song: SharedMusicSong;
    shareUrl?: string;
    timestamp?: number;
}): Omit<Message, 'id' | 'timestamp'> & { timestamp?: number } {
    const { charId, song, shareUrl, timestamp } = input;
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
            song,
        },
    };
}
