/**
 * musicProviders/types.ts
 * 流媒体音乐平台（网易云音乐 / QQ音乐）的 provider 模型基础。
 *
 * 设计（见 MUSIC DUAL PROVIDER 需求）：
 *  - `provider` 只表示「当前正在用的流媒体平台」；两个平台的登录态完全独立，
 *    各自的 credential 分别保存在 cfg.netease / cfg.qq 里，切换互不影响。
 *  - 旧配置 `sully_music_cfg_v1`（只有顶层 cookie = 网易云 cookie）自动迁移：
 *    provider 默认 'netease'，原 cookie 原样保留，一个字节都不丢。
 *  - Song 增加 `source` / `sourceId`：网易云 numeric id 与 QQ songmid 可能撞号，
 *    跨平台比较一律走 getSongIdentity()（'netease:123' / 'qq:003xxx' / 'local:456'）。
 *    旧数据 source undefined 视为 netease；legacy Song.id:number 全仓不动。
 *
 * 纯函数模块，不依赖 React —— 方便 vitest 直接测。
 */

/** 流媒体平台标识。注意与写歌 App 的 MusicProvider（AI 出歌引擎）不是一回事。 */
export type StreamingMusicProvider = 'netease' | 'qq';

export interface NeteaseProviderCfg {
    /** 网易云 MUSIC_U 等 cookie（与旧版顶层 MusicCfg.cookie 同源）。 */
    cookie?: string;
}

export interface QQMusicProviderCfg {
    /**
     * QQ音乐登录 cookie（uin + qm_keyst/qqmusic_key，用户从 y.qq.com 复制）。
     * 只存设备本地 localStorage，绝不上传服务器 / 不进日志。
     */
    cookie?: string;
}

/**
 * MusicCfg 的向后兼容扩展。旧字段（workerUrl / cookie / quality）全部保留：
 * 顶层 cookie 永远 = 网易云 cookie（旧代码继续读它），netease.cookie 是它的镜像。
 */
export interface MusicCfgV2 {
    provider: StreamingMusicProvider;
    workerUrl: string;
    quality: string;
    /** 旧版顶层网易云 cookie —— 保持原位，兼容未迁移的读取方。 */
    cookie: string;
    netease?: NeteaseProviderCfg;
    qq?: QQMusicProviderCfg;
}

/**
 * 旧版 MusicCfg（provider 概念引入之前）的形状。宽松类型，方便迁移测试。
 */
export interface LegacyMusicCfgV1 {
    workerUrl?: string;
    cookie?: string;
    quality?: string;
    provider?: StreamingMusicProvider;
    netease?: NeteaseProviderCfg;
    qq?: QQMusicProviderCfg;
    [k: string]: unknown;
}

export const MUSIC_PROVIDER_DEFAULT: MusicCfgV2 = {
    provider: 'netease',
    workerUrl: '',
    cookie: '',
    quality: 'exhigh',
    netease: {},
    qq: {},
};

/**
 * 任意存量配置（含旧 v1）→ MusicCfgV2。
 *  - 没写过配置的 → 默认 netease、两边都未登录；
 *  - 只有顶层 cookie 的老用户 → provider='netease'，cookie 迁进 netease.cookie（顶层同步保留）；
 *  - 已是 v2 → 原样通过（各 provider 登录态互相独立，互不覆盖）。
 */
export function migrateMusicCfg(raw: LegacyMusicCfgV1 | null | undefined): MusicCfgV2 {
    if (!raw || typeof raw !== 'object') return { ...MUSIC_PROVIDER_DEFAULT };
    const neteaseCookie = (raw.netease?.cookie ?? raw.cookie ?? '').toString();
    const qqCookie = (raw.qq?.cookie ?? '').toString();
    const provider: StreamingMusicProvider = raw.provider === 'qq' ? 'qq' : 'netease';
    return {
        provider,
        workerUrl: (raw.workerUrl ?? '').toString(),
        quality: (raw.quality ?? MUSIC_PROVIDER_DEFAULT.quality).toString(),
        // 顶层 cookie 永远镜像网易云 cookie：未迁移的旧读取方拿到的一直是网易云登录态。
        cookie: neteaseCookie,
        netease: { cookie: neteaseCookie },
        qq: { cookie: qqCookie },
    };
}

/** 切换 provider 时只动 provider 字段，两平台 credential 原样保留。 */
export function switchMusicProvider(
    cfg: MusicCfgV2,
    next: StreamingMusicProvider,
): MusicCfgV2 {
    if (cfg.provider === next) return cfg;
    return { ...cfg, provider: next };
}

/* ───────── Song identity（跨平台不撞 ID 的硬要求） ───────── */

/**
 * 身份判定的最小输入。宽松对待 source：
 *  - Song.source：'netease' | 'qq' | 'local'（流媒体平台）；
 *  - CharPlaylistSong.source：'user' | 'discovered'（收藏来源 provenance，另一回事），
 *    流媒体平台放在它的 streamingSource 字段里 —— getSongIdentity 会优先读 streamingSource。
 */
export interface SongLike {
    id: number;
    local?: boolean;
    source?: unknown;
    streamingSource?: 'netease' | 'qq' | 'local';
    /** 平台内 canonical id：QQ 用 songmid（string），网易云沿用 numeric id。 */
    sourceId?: string;
}

/**
 * 统一歌曲身份：'netease:347230' | 'qq:0039MnYB...' | 'local:456'。
 * 网易云与 QQ 即使 numeric id 相同也不会碰撞。
 */
export function getSongIdentity(song: SongLike): string {
    if (song.local) {
        // 本地生成的歌不属于任何流媒体平台；sourceId 有值时优先。
        return `local:${song.sourceId ?? song.id}`;
    }
    const raw = song.streamingSource ?? (song.source as any);
    const source = raw === 'qq' ? 'qq' : 'netease';
    return `${source}:${song.sourceId ?? song.id}`;
}

/** 身份比较：queue / 喜欢 / 角色歌单 dedupe / 分享 全部用它。 */
export function sameSongIdentity(a: SongLike | null | undefined, b: SongLike | null | undefined): boolean {
    if (!a || !b) return false;
    return getSongIdentity(a) === getSongIdentity(b);
}

/** 按身份去重（保留先出现的）。用于队列、角色歌单。 */
export function dedupeBySongIdentity<T extends SongLike>(songs: T[]): T[] {
    const seen = new Set<string>();
    const out: T[] = [];
    for (const s of songs) {
        const id = getSongIdentity(s);
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(s);
    }
    return out;
}

/**
 * musicCache 的 key 盐：必须同时包含 provider 与账号身份，
 * 保证「网易云搜晴天」和「QQ音乐搜晴天」/ 不同账号互不命中。
 */
export function providerCacheSalt(provider: StreamingMusicProvider, credential?: string): string {
    const c = (credential || '').trim();
    const tail = !c ? 'anon' : (c.length <= 8 ? c : c.slice(-8));
    return `${provider}|${tail}`;
}
