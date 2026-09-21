/**
 * 分组共享世界书 —— effective worldbooks 的唯一 canonical 合并点。
 *
 * CharacterGroup.worldbookIds 只存全局 Worldbook.id 引用（不复制正文）。
 * 角色进行 Chat / Meet / Story 生成时，所有读取「角色挂载世界书」构造上下文的地方
 * （ContextBuilder.buildCoreContext / chatRequestPayload / datePrompts / 剧场 dedupeTheaterWorldbooks）
 * 一律通过 getEffectiveMountedWorldbooks(char) 取数：
 *
 *   effective = 个人 mountedWorldbooks + 所属分组引用的全局世界书（按 id 去重，个人版本优先）
 *
 * 分组被删 / 世界书 id 不存在 / 未提供 snapshot → 安全忽略，退化为纯个人挂载。
 * 不产生任何额外 AI 调用；snapshot 由 OSContext 每次渲染时刷新（getter 闭包，值恒新）。
 */

import type { CharacterProfile, CharacterGroup, Worldbook, MountedWorldbook } from '../types';
import { toMountedWorldbook } from './worldbook';

interface GroupWorldbookSnapshot {
    characterGroups: CharacterGroup[];
    worldbooks: Worldbook[];
}

let snapshotProvider: (() => GroupWorldbookSnapshot) | null = null;

/** OSContext 启动后注入；getter 每次调用取最新 state，避免闭包里的旧列表。 */
export const setGroupWorldbookSnapshotProvider = (provider: (() => GroupWorldbookSnapshot) | null): void => {
    snapshotProvider = provider;
};

const getSnapshot = (): GroupWorldbookSnapshot => {
    try {
        return snapshotProvider?.() ?? { characterGroups: [], worldbooks: [] };
    } catch {
        return { characterGroups: [], worldbooks: [] };
    }
};

/** 角色所属分组引用的全局世界书（转成 MountedWorldbook 投影；分组/世界书缺失时安全返回空）。 */
export const resolveGroupWorldbooks = (
    char: Pick<CharacterProfile, 'groupId'>,
    characterGroups: CharacterGroup[],
    worldbooks: Worldbook[],
): MountedWorldbook[] => {
    if (!char.groupId) return [];
    const group = characterGroups.find(g => g.id === char.groupId);
    const ids = group?.worldbookIds;
    if (!group || !Array.isArray(ids) || ids.length === 0) return [];
    const out: MountedWorldbook[] = [];
    for (const id of ids) {
        // 只引用不复制；worldbook 不存在 → 安全跳过
        const book = worldbooks.find(wb => wb.id === id);
        if (book) out.push(toMountedWorldbook(book));
    }
    return out;
};

/**
 * canonical 合并点：个人挂载 + 分组共享，按世界书 id 去重（个人版本优先）。
 * 没有 snapshot / 没有分组配置时返回值与 char.mountedWorldbooks 完全一致。
 */
export const getEffectiveMountedWorldbooks = (char: CharacterProfile): MountedWorldbook[] => {
    const personal = char.mountedWorldbooks || [];
    const { characterGroups, worldbooks } = getSnapshot();
    const groupBooks = resolveGroupWorldbooks(char, characterGroups, worldbooks);
    if (groupBooks.length === 0) return personal;
    const seen = new Set(personal.map(book => book.id).filter(Boolean));
    const merged = [...personal];
    for (const book of groupBooks) {
        if (!book.id || seen.has(book.id)) continue;
        seen.add(book.id);
        merged.push(book);
    }
    return merged;
};
