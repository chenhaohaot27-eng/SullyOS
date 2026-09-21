import React from 'react';
import { CharacterProfile, CharacterGroup, StoryTheaterEntry } from '../../types';

/**
 * 角色分组的公共工具 + 选角入口的分组筛选胶囊条。
 *
 * 背景：角色一多，「神经链接 / 打电话 / 见面 / 查手机 / 转发」这些选角列表就会太长。
 * 各入口的列表 UI 千差万别（竖列 / grid / 横滑分页），所以这里不做统一的"角色选择器"，
 * 而是提供最小公共件：一条按分组筛选的胶囊条 + 纯函数筛选逻辑，各入口把筛选结果
 * 喂给自己原有的列表/分页渲染即可。没建过分组的用户，胶囊条整体不渲染，各入口零变化。
 */

/** 「全部」虚拟分组 id */
export const GROUP_FILTER_ALL = 'all';
/** 「未分组」虚拟分组 id（groupId 为空、或指向已删分组的角色都算） */
export const GROUP_FILTER_UNGROUPED = '__ungrouped__';

/** 分组显示顺序：order 优先，缺省按创建时间先后 */
export const sortCharacterGroups = (groups: CharacterGroup[]): CharacterGroup[] =>
    [...groups].sort((a, b) => (a.order ?? a.createdAt ?? 0) - (b.order ?? b.createdAt ?? 0));

/** 按分组筛选角色。groupId 传 GROUP_FILTER_ALL / GROUP_FILTER_UNGROUPED / 具体分组 id */
export const filterCharactersByGroup = (
    characters: CharacterProfile[],
    groups: CharacterGroup[],
    groupId: string,
): CharacterProfile[] => {
    if (groupId === GROUP_FILTER_ALL) return characters;
    if (groupId === GROUP_FILTER_UNGROUPED) {
        const known = new Set(groups.map(g => g.id));
        return characters.filter(c => !c.groupId || !known.has(c.groupId));
    }
    return characters.filter(c => c.groupId === groupId);
};

interface FilterBarProps {
    /** 该入口的完整候选列表（未筛选），用于计算各组数量与是否显示「未分组」 */
    characters: CharacterProfile[];
    groups: CharacterGroup[];
    value: string;
    onChange: (groupId: string) => void;
    /** 深色底的 App（打电话 / 见面 / 查手机）传 true，胶囊换白字配色 */
    dark?: boolean;
    className?: string;
}

interface GroupChipsProps {
    /** 胶囊条数据：全部 / 各分组 / 未分组（由调用方按自己的一等公民计数） */
    chips: { id: string; label: string; count: number }[];
    value: string;
    onChange: (groupId: string) => void;
    dark?: boolean;
    className?: string;
}

/**
 * 通用分组筛选胶囊条：全部 / 各分组 / 未分组，横向可滚动。
 * 角色选角入口（CharacterGroupFilterBar）和剧情列表（StoryTheater）共用同一份视觉与交互。
 */
export const GroupFilterChips: React.FC<GroupChipsProps> = ({ chips, value, onChange, dark, className }) => {
    const base = 'shrink-0 px-3 py-1.5 rounded-full text-xs font-medium border transition-all active:scale-95 flex items-center gap-1';
    const idle = dark
        ? 'bg-white/[0.06] text-white/60 border-white/15'
        : 'bg-white/70 text-slate-500 border-slate-200';
    const active = dark
        ? 'bg-white/90 text-slate-900 border-white'
        : 'bg-slate-700 text-white border-slate-700';

    return (
        <div className={`flex gap-1.5 overflow-x-auto no-scrollbar ${className || ''}`}>
            {chips.map(chip => (
                <button
                    key={chip.id}
                    onClick={() => onChange(chip.id)}
                    className={`${base} ${value === chip.id ? active : idle}`}
                >
                    <span>{chip.label}</span>
                    <span className={value === chip.id ? 'opacity-70' : 'opacity-50'}>{chip.count}</span>
                </button>
            ))}
        </div>
    );
};

/**
 * 分组筛选胶囊条：全部 / 各分组 / 未分组，横向可滚动。
 * groups 为空时返回 null——没用分组的用户看不到任何变化。
 */
export const CharacterGroupFilterBar: React.FC<FilterBarProps> = ({ characters, groups, value, onChange, dark, className }) => {
    if (groups.length === 0) return null;

    const known = new Set(groups.map(g => g.id));
    const ungroupedCount = characters.filter(c => !c.groupId || !known.has(c.groupId)).length;
    const chips: { id: string; label: string; count: number }[] = [
        { id: GROUP_FILTER_ALL, label: '全部', count: characters.length },
        ...sortCharacterGroups(groups).map(g => ({
            id: g.id,
            label: g.name,
            count: characters.filter(c => c.groupId === g.id).length,
        })),
    ];
    if (ungroupedCount > 0) chips.push({ id: GROUP_FILTER_UNGROUPED, label: '未分组', count: ungroupedCount });

    return <GroupFilterChips chips={chips} value={value} onChange={onChange} dark={dark} className={className} />;
};

// ─── 剧情按角色/世界观分组 ────────────────────────────────────────────
// StoryTheaterEntry.characterGroupId 是保存时的快照：一旦写入，角色换组/分组被删都不改写。
// 旧剧情没快照时按当前 participants 推断（全部同组才归入该组）。

/** 剧情在分组筛选里所属的组 key：具体分组 id、GROUP_FILTER_UNGROUPED 或 GROUP_FILTER_ALL（不筛选）。 */
export const resolveStoryTheaterGroupKey = (
    entry: Pick<StoryTheaterEntry, 'characterGroupId' | 'characterIds'>,
    characters: CharacterProfile[],
    groups: CharacterGroup[],
): string => {
    // 已保存快照优先；分组已被删 → 按未分组处理（与角色 groupId 指向已删分组同样的规则）
    if (entry.characterGroupId) {
        return groups.some(g => g.id === entry.characterGroupId) ? entry.characterGroupId : GROUP_FILTER_UNGROUPED;
    }
    // 旧剧情 fallback：只有全部参与者当前都属于同一个已知分组才归入该组
    const cast = entry.characterIds
        .map(id => characters.find(c => c.id === id))
        .filter((c): c is CharacterProfile => !!c);
    if (cast.length === 0) return GROUP_FILTER_UNGROUPED;
    const firstGroupId = cast[0].groupId;
    const allSameKnownGroup = !!firstGroupId
        && groups.some(g => g.id === firstGroupId)
        && cast.every(c => c.groupId === firstGroupId);
    return allSameKnownGroup ? firstGroupId! : GROUP_FILTER_UNGROUPED;
};

/** 按分组筛选剧情。groupId 传 GROUP_FILTER_ALL / GROUP_FILTER_UNGROUPED / 具体分组 id */
export const filterStoryTheatersByGroup = (
    entries: StoryTheaterEntry[],
    characters: CharacterProfile[],
    groups: CharacterGroup[],
    groupId: string,
): StoryTheaterEntry[] => {
    if (groupId === GROUP_FILTER_ALL) return entries;
    return entries.filter(entry => resolveStoryTheaterGroupKey(entry, characters, groups) === groupId);
};

/**
 * 保存剧情时的分组快照：
 * - 已有 characterGroupId 原样保留（角色之后换组不改快照）；
 * - 没有时若参与角色全部属于同一个已知分组 → 写入该分组 id；
 * - 混合 / 未分组 / 参与者缺失 → 不写（视为未分组）。
 */
export const snapshotStoryCharacterGroupId = (
    entry: StoryTheaterEntry,
    characters: CharacterProfile[],
    groups: CharacterGroup[],
): StoryTheaterEntry => {
    if (entry.characterGroupId) return entry;
    const ids = Array.isArray(entry.characterIds) ? entry.characterIds.filter(Boolean) : [];
    if (ids.length === 0) return entry;
    const cast = ids.map(id => characters.find(c => c.id === id));
    if (cast.some(c => !c)) return entry; // 有参与者已不存在 → 不猜
    const firstGroupId = (cast[0] as CharacterProfile).groupId;
    const allSameKnownGroup = !!firstGroupId
        && groups.some(g => g.id === firstGroupId)
        && cast.every(c => (c as CharacterProfile).groupId === firstGroupId);
    return allSameKnownGroup ? { ...entry, characterGroupId: firstGroupId } : entry;
};
