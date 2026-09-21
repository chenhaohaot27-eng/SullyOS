import { describe, it, expect, afterEach } from 'vitest';
import {
    setGroupWorldbookSnapshotProvider,
    resolveGroupWorldbooks,
    getEffectiveMountedWorldbooks,
} from './groupWorldbooks';
import type { CharacterProfile, CharacterGroup, Worldbook, MountedWorldbook } from '../types';

const mkBook = (id: string, title: string): Worldbook => ({
    id, title, content: `${title} 正文`, category: '测试', createdAt: 1, updatedAt: 1,
} as any as Worldbook);

const mkMounted = (id: string, title: string): MountedWorldbook => ({ ...mkBook(id, title) } as any as MountedWorldbook);

const mkChar = (id: string, groupId?: string, mounted?: MountedWorldbook[]): CharacterProfile =>
    ({ id, name: id, avatar: '', groupId, mountedWorldbooks: mounted } as any as CharacterProfile);

afterEach(() => { setGroupWorldbookSnapshotProvider(null); });

describe('分组共享世界书', () => {
    it('个人 + 分组世界书合并，按 id 去重，个人版本优先', () => {
        const group: CharacterGroup = { id: 'g1', name: '组', worldbookIds: ['wb1', 'wb2', 'wb3'] };
        const worldbooks = [mkBook('wb1', '共享一'), mkBook('wb2', '共享二'), mkBook('wb3', '共享三')];
        setGroupWorldbookSnapshotProvider(() => ({ characterGroups: [group], worldbooks }));
        const char = mkChar('a', 'g1', [mkMounted('wb1', '个人版本一'), mkMounted('own', '私人书')]);
        const effective = getEffectiveMountedWorldbooks(char);
        expect(effective.map(b => b.id)).toEqual(['wb1', 'own', 'wb2', 'wb3']);
        // wb1 冲突时保留个人挂载的正文
        expect(effective[0].title).toBe('个人版本一');
    });

    it('没有分组世界书的用户零变化（返回原数组内容）', () => {
        const group: CharacterGroup = { id: 'g1', name: '组' };
        setGroupWorldbookSnapshotProvider(() => ({ characterGroups: [group], worldbooks: [mkBook('wb1', '书')] }));
        const personal = [mkMounted('own', '私人书')];
        const char = mkChar('a', 'g1', personal);
        expect(getEffectiveMountedWorldbooks(char)).toBe(personal);
        // 无 provider 时同样安全
        setGroupWorldbookSnapshotProvider(null);
        expect(getEffectiveMountedWorldbooks(char)).toBe(personal);
    });

    it('分组被删 / 世界书不存在 / 指向不存在的组 → 安全忽略', () => {
        // 分组不存在（角色 groupId 指向已删分组）
        expect(resolveGroupWorldbooks(mkChar('a', 'gone'), [], [mkBook('wb1', '书')])).toEqual([]);
        // worldbook id 不存在
        const group: CharacterGroup = { id: 'g1', name: '组', worldbookIds: ['wb-dead', 'wb-alive'] };
        const books = resolveGroupWorldbooks(mkChar('a', 'g1'), [group], [mkBook('wb-alive', '活书')]);
        expect(books.map(b => b.id)).toEqual(['wb-alive']);
        // 角色未分组
        expect(resolveGroupWorldbooks(mkChar('a'), [{ id: 'g1', name: '组', worldbookIds: ['wb-alive'] }], [mkBook('wb-alive', '活书')])).toEqual([]);
    });

    it('去重：分组挂了与个人相同的书只出现一次', () => {
        const group: CharacterGroup = { id: 'g1', name: '组', worldbookIds: ['same'] };
        const worldbooks = [mkBook('same', '全局书')];
        setGroupWorldbookSnapshotProvider(() => ({ characterGroups: [group], worldbooks }));
        const char = mkChar('a', 'g1', [mkMounted('same', '个人书')]);
        const effective = getEffectiveMountedWorldbooks(char);
        expect(effective.filter(b => b.id === 'same').length).toBe(1);
        expect(effective[0].title).toBe('个人书');
    });
});
