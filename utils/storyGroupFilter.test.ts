import { describe, it, expect } from 'vitest';
import {
    GROUP_FILTER_ALL,
    GROUP_FILTER_UNGROUPED,
    filterStoryTheatersByGroup,
    resolveStoryTheaterGroupKey,
    snapshotStoryCharacterGroupId,
} from '../components/character/CharacterGroupFilter';
import type { CharacterProfile, CharacterGroup, StoryTheaterEntry } from '../types';
import { createStoryTheaterDraft } from './storyTheater';

const mkChar = (id: string, groupId?: string): CharacterProfile => ({ id, name: id, avatar: '', groupId } as any as CharacterProfile);
const mkGroup = (id: string): CharacterGroup => ({ id, name: `分组${id}`, createdAt: 1 });

const g1 = mkGroup('g1');
const g2 = mkGroup('g2');
const chars = [mkChar('a', 'g1'), mkChar('b', 'g1'), mkChar('c', 'g2'), mkChar('d')];
const groups = [g1, g2];

const mkEntry = (id: string, characterIds: string[], characterGroupId?: string): StoryTheaterEntry => ({
    ...createStoryTheaterDraft(),
    id,
    title: id,
    characterIds,
    ...(characterGroupId ? { characterGroupId } : {}),
});

describe('剧情按角色分组：列表筛选', () => {
    const entries = [
        mkEntry('s1', ['a', 'b']),            // 参与者全在 g1 → g1（旧剧情推断）
        mkEntry('s2', ['a', 'c']),            // 混合 → 未分组
        mkEntry('s3', ['d']),                 // 未分组角色 → 未分组
        mkEntry('s4', ['c'], 'g2'),           // 已有快照 → g2
        mkEntry('s5', ['a', 'b'], 'g1'),      // 已有快照 → g1
    ];

    it('参与者全部同组 → 正确归入该组', () => {
        const inG1 = filterStoryTheatersByGroup(entries, chars, groups, 'g1');
        expect(inG1.map(e => e.id).sort()).toEqual(['s1', 's5']);
    });

    it('混合 / 未分组剧情不误归类', () => {
        const ungrouped = filterStoryTheatersByGroup(entries, chars, groups, GROUP_FILTER_UNGROUPED);
        expect(ungrouped.map(e => e.id).sort()).toEqual(['s2', 's3']);
    });

    it('全部 返回所有剧情', () => {
        expect(filterStoryTheatersByGroup(entries, chars, groups, GROUP_FILTER_ALL).length).toBe(5);
    });

    it('旧剧情 fallback：没 characterGroupId 时按当前 participants 推断', () => {
        expect(resolveStoryTheaterGroupKey(mkEntry('x', ['a', 'b']), chars, groups)).toBe('g1');
        expect(resolveStoryTheaterGroupKey(mkEntry('x', ['a', 'c']), chars, groups)).toBe(GROUP_FILTER_UNGROUPED);
        expect(resolveStoryTheaterGroupKey(mkEntry('x', []), chars, groups)).toBe(GROUP_FILTER_UNGROUPED);
        // 指向不存在角色 / 已删分组的 groupId → 未分组
        expect(resolveStoryTheaterGroupKey(mkEntry('x', ['ghost']), chars, groups)).toBe(GROUP_FILTER_UNGROUPED);
    });

    it('角色后来换组不改变已保存的 snapshot', () => {
        const snapshot = mkEntry('s5', ['a', 'b'], 'g1');
        // a 换到 g2：有快照的剧情仍按快照分组
        const charsAfter = [mkChar('a', 'g2'), mkChar('b', 'g1')];
        expect(resolveStoryTheaterGroupKey(snapshot, charsAfter, groups)).toBe('g1');
        // 没快照的旧剧情才跟着当前 participants 走
        expect(resolveStoryTheaterGroupKey(mkEntry('s1', ['a', 'b']), charsAfter, groups)).toBe(GROUP_FILTER_UNGROUPED);
    });

    it('分组被删 → 快照剧情按未分组处理，不炸', () => {
        expect(resolveStoryTheaterGroupKey(mkEntry('s', ['c'], 'gone'), chars, groups)).toBe(GROUP_FILTER_UNGROUPED);
    });
});

describe('剧情按角色分组：保存时快照', () => {
    it('参与者全部同组 → 写入该组 id', () => {
        const out = snapshotStoryCharacterGroupId(mkEntry('s', ['a', 'b']), chars, groups);
        expect(out.characterGroupId).toBe('g1');
    });

    it('混合 / 未分组 / 空参与者 → 不写', () => {
        expect(snapshotStoryCharacterGroupId(mkEntry('s', ['a', 'c']), chars, groups).characterGroupId).toBeUndefined();
        expect(snapshotStoryCharacterGroupId(mkEntry('s', ['d']), chars, groups).characterGroupId).toBeUndefined();
        expect(snapshotStoryCharacterGroupId(mkEntry('s', []), chars, groups).characterGroupId).toBeUndefined();
    });

    it('已有快照 → 角色换组也不改写', () => {
        const entry = mkEntry('s', ['a', 'b'], 'g1');
        const charsAfter = [mkChar('a', 'g2'), mkChar('b', 'g1')];
        expect(snapshotStoryCharacterGroupId(entry, charsAfter, groups).characterGroupId).toBe('g1');
    });

    it('groupId 指向已删分组 → 不写快照（按未分组处理）', () => {
        const ghostChar = mkChar('z', 'gone');
        const out = snapshotStoryCharacterGroupId(mkEntry('s', ['z']), [ghostChar], groups);
        expect(out.characterGroupId).toBeUndefined();
    });
});
