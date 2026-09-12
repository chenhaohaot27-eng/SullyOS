import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
    parseNeteaseSongId,
    isNeteaseShortLink,
    buildNeteaseShareUrl,
    buildSharedMusicCardMessage,
    type SharedMusicSong,
} from './musicShare';
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
    it('163cn.tv 短链识别（本阶段不展开，只给提示）', () => {
        expect(isNeteaseShortLink('https://163cn.tv/AbCdEf')).toBe(true);
        expect(isNeteaseShortLink('https://music.163.com/song?id=1')).toBe(false);
        // 短链不带 id 参数，解析必然返回 null —— 由 UI 层用 isNeteaseShortLink 给出定向提示
        expect(parseNeteaseSongId('https://163cn.tv/AbCdEf')).toBeNull();
    });
    it('shareUrl 可从 songId 反推', () => {
        expect(buildNeteaseShareUrl(123456)).toBe('https://music.163.com/song?id=123456');
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
        expect(slice).toContain('DB.saveMessage');
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
        for (const banned of ['chatCompletionClient', 'useChatAI', 'safeApi', 'gemini', 'openai']) {
            expect(src).not.toContain(banned);
        }
    });
});
