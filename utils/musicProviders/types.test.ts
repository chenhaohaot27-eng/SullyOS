import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    MUSIC_PROVIDER_DEFAULT,
    dedupeBySongIdentity,
    getSongIdentity,
    migrateMusicCfg,
    providerCacheSalt,
    sameSongIdentity,
    switchMusicProvider,
    type LegacyMusicCfgV1,
} from './types';

beforeEach(() => { localStorage.clear(); });
afterEach(() => { localStorage.clear(); });

describe('音乐配置：v1 → v2 迁移（老用户零损失）', () => {
    it('没有任何数据 → 默认 netease、两边都未登录', () => {
        expect(migrateMusicCfg(null)).toEqual(MUSIC_PROVIDER_DEFAULT);
        const empty = migrateMusicCfg({});
        expect(empty.provider).toBe('netease');
        expect(empty.cookie).toBe('');
        expect(empty.qq?.cookie).toBe('');
    });

    it('旧网易云配置迁移：cookie 原样保留，provider 默认 netease', () => {
        const old: LegacyMusicCfgV1 = { workerUrl: 'https://w.example.com', cookie: 'MUSIC_U=abc123', quality: 'lossless' };
        const m = migrateMusicCfg(old);
        expect(m.provider).toBe('netease');
        expect(m.cookie).toBe('MUSIC_U=abc123');
        expect(m.netease?.cookie).toBe('MUSIC_U=abc123');
        expect(m.quality).toBe('lossless');
        expect(m.workerUrl).toBe('https://w.example.com');
        expect(m.qq?.cookie).toBe('');
    });

    it('网易云登录 A + QQ登录 B：两平台登录态完全独立、互不覆盖', () => {
        const cfg = migrateMusicCfg({
            provider: 'netease',
            cookie: 'MUSIC_U=netease-A',
            netease: { cookie: 'MUSIC_U=netease-A' },
            qq: { cookie: 'uin=o111; qm_keyst=qq-B' },
        });
        expect(cfg.netease?.cookie).toBe('MUSIC_U=netease-A');
        expect(cfg.qq?.cookie).toBe('uin=o111; qm_keyst=qq-B');

        const switched = switchMusicProvider(cfg, 'qq');
        expect(switched.provider).toBe('qq');
        expect(switched.netease?.cookie).toBe('MUSIC_U=netease-A');
        expect(switched.qq?.cookie).toBe('uin=o111; qm_keyst=qq-B');
        expect(switched.cookie).toBe('MUSIC_U=netease-A');

        const back = switchMusicProvider(switched, 'netease');
        expect(back.provider).toBe('netease');
        expect(back.qq?.cookie).toBe('uin=o111; qm_keyst=qq-B');
        expect(switchMusicProvider(back, 'netease')).toBe(back);
    });

    it('非法 provider 值兜底为 netease', () => {
        expect(migrateMusicCfg({ provider: 'migu' as any, cookie: 'x' }).provider).toBe('netease');
    });
});

describe('Song identity：网易云数字 id 与 QQ songmid 不撞号', () => {
    const base = { name: '晴天', artists: '周杰伦', album: '', albumPic: '', duration: 0, fee: 0 };

    it('相同 numeric id 的网易云歌和 QQ 歌身份不同', () => {
        const netease = { id: 347230, ...base };
        const qq = { id: 347230, ...base, source: 'qq' as const, sourceId: '0039MnYb0qxYhV' };
        expect(getSongIdentity(netease)).toBe('netease:347230');
        expect(getSongIdentity(qq)).toBe('qq:0039MnYb0qxYhV');
        expect(sameSongIdentity(netease, qq)).toBe(false);
    });

    it('legacy 网易云数据（source undefined）视为 netease', () => {
        const legacy = { id: 123, ...base };
        expect(getSongIdentity(legacy)).toBe('netease:123');
        const modern = { id: 123, ...base, source: 'netease' as const, sourceId: '123' };
        expect(sameSongIdentity(legacy, modern)).toBe(true);
    });

    it('QQ songmid 为 canonical identity（id 只是展示用数字）', () => {
        const a = { id: 100, source: 'qq' as const, sourceId: '002bSWWb2t9Qbl' };
        const b = { id: 999, source: 'qq' as const, sourceId: '002bSWWb2t9Qbl' };
        expect(sameSongIdentity(a, b)).toBe(true);
    });

    it('本地生成的歌：local 前缀，与流媒体平台互不碰撞', () => {
        const localSong = { id: 347230, ...base, local: true };
        expect(getSongIdentity(localSong)).toBe('local:347230');
        expect(sameSongIdentity(localSong, { id: 347230, ...base })).toBe(false);
    });

    it('队列去重：跨平台同 id 不误伤，平台内重复被去掉', () => {
        const songs = [
            { id: 1, ...base },
            { id: 1, ...base, source: 'qq' as const, sourceId: 'm1' },
            { id: 1, ...base },
            { id: 5, ...base, source: 'qq' as const, sourceId: 'm1' },
            { id: 1, ...base, local: true },
        ];
        expect(dedupeBySongIdentity(songs)).toHaveLength(3);
    });

    it('角色歌单去重：QQ 歌按 songmid 判重，不与网易云同 id 混淆', () => {
        const playlist = [{ id: 1, ...base, source: 'qq' as const, sourceId: 'abc' }];
        const incomingQq = { id: 77, ...base, source: 'qq' as const, sourceId: 'abc' };
        expect(playlist.some(s => sameSongIdentity(s, incomingQq))).toBe(true);
        const incomingNetease = { id: 1, ...base };
        expect(playlist.some(s => sameSongIdentity(s, incomingNetease))).toBe(false);
    });
});

describe('缓存 key 隔离：provider + 账号', () => {
    it('不同 provider / 不同账号产生不同盐', () => {
        expect(providerCacheSalt('netease', 'MUSIC_U=xxxx8888')).not.toBe(providerCacheSalt('qq', 'MUSIC_U=xxxx8888'));
        expect(providerCacheSalt('qq', 'qm_keyst=AAAA')).not.toBe(providerCacheSalt('qq', 'qm_keyst=BBBB'));
        expect(providerCacheSalt('qq', '')).toBe('qq|anon');
        expect(providerCacheSalt('netease', '')).toBe('netease|anon');
    });
});
