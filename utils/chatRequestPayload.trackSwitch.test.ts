import { describe, it, expect } from 'vitest';
import { deriveRecentTrackSwitchForChar } from './chatRequestPayload';
import type { RecentTrackChange } from '../context/MusicContext';

const record = (overrides: Partial<RecentTrackChange> = {}): RecentTrackChange => ({
    previousSong: { id: 1, name: '起风了', artists: '买辣椒也用券' },
    charIds: ['char-1'],
    at: Date.now(),
    ...overrides,
});

describe('deriveRecentTrackSwitchForChar 换歌察觉判定', () => {
    it('换歌那刻在一起听名单里、刚发生 → 命中，返回上一首信息', () => {
        expect(deriveRecentTrackSwitchForChar(record(), 'char-1')).toEqual({
            songName: '起风了',
            artists: '买辣椒也用券',
        });
    });

    it('没有换歌记录 → null', () => {
        expect(deriveRecentTrackSwitchForChar(null, 'char-1')).toBeNull();
        expect(deriveRecentTrackSwitchForChar(undefined, 'char-1')).toBeNull();
    });

    it('【Batch B】仍在一起听（active session 未结束）→ 也要察觉换歌（换歌 ≠ 结束一起听）', () => {
        // 语义变更：换歌不再把 char 踢出一起听；prompt 层用 isListeningTogether 区分措辞。
        expect(deriveRecentTrackSwitchForChar(record(), 'char-1')).toEqual({
            songName: '起风了',
            artists: '买辣椒也用券',
        });
    });

    it('换歌那刻 char 不在一起听名单里 → 与它无关，不提示', () => {
        expect(deriveRecentTrackSwitchForChar(record(), 'char-2')).toBeNull();
    });

    it('换歌已过去太久（超过新鲜窗口）→ 不再提示', () => {
        const stale = record({ at: Date.now() - 11 * 60 * 1000 });
        expect(deriveRecentTrackSwitchForChar(stale, 'char-1')).toBeNull();
    });
});
