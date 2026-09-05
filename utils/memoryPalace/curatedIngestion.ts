/**
 * curatedIngestion — 面向上层业务的「单条高价值 curated 记忆」公共提交入口（Phase 5 新增）。
 *
 * 背景：Memory Palace 此前只有两条写入路——聊天消息的 LLM 提取管线
 * （processNewMessagesWithAutoArchive）与内部模块（anticipation/digestion/migration）直接
 * 构造 MemoryNode。外部业务（如 Gift）想提交一条"已判定重要"的结构化事件时没有干净入口。
 *
 * 本文件就是那个入口：只做「构造合法 MemoryNode → MemoryNodeDB.save」，
 * 与 anticipation.fulfillAnticipation 同一 in-system 模式（embedded:false 等后续向量化，
 * 由既有 vectorization/consolidation 生命周期接管）。不建第二套存储、不碰 vectors/links/
 * event boxes，不自己 embedding。
 *
 * 幂等：按 tags 里的 `source:sourceId` 标记查重，同一来源事件只落一条节点。
 */

import type { MemoryNode } from './types';
import { MemoryNodeDB } from './db';

export interface CuratedMemoryCandidate {
    charId: string;
    /** 业务来源标识，如 'gift'。参与幂等标记 `source:sourceId`。 */
    source: string;
    /** 业务侧唯一 ID（如 gift.id）。参与幂等标记。 */
    sourceId: string;
    /** 角色视角的事实叙述（谁/什么/为何重要），不是内部枚举或 JSON。 */
    summary: string;
    /** 1–10，超出会被钳制。 */
    importance: number;
    tags?: string[];
    /** 情绪标签，如 'grateful' / 'moved' / 'sad'。 */
    mood?: string;
    /** 事件发生时间（默认现在）。 */
    occurredAt?: number;
}

export interface CuratedMemoryCommitResult {
    committed: boolean;
    /** 落库节点 ID；duplicate 时返回既有节点 ID。 */
    memoryId?: string;
    /** true = 该 source:sourceId 已有节点，本次未新建。 */
    duplicate?: boolean;
}

const sourceTag = (source: string, sourceId: string) => `${source}:${sourceId}`;

const genId = (): string => `mn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

/**
 * 提交一条 curated 记忆候选。同一 (source, sourceId) 只会真正写入一次；
 * 重复提交返回既有节点（duplicate: true），不抛错——调用方可以安全重放。
 */
export async function submitCuratedMemoryCandidate(
    candidate: CuratedMemoryCandidate,
): Promise<CuratedMemoryCommitResult> {
    const { charId, source, sourceId } = candidate;
    if (!charId?.trim() || !source?.trim() || !sourceId?.trim()) {
        throw new Error('curated memory requires charId / source / sourceId');
    }
    const summary = candidate.summary?.trim();
    if (!summary) throw new Error('curated memory requires a non-empty summary');

    const tag = sourceTag(source, sourceId);
    // 幂等：同 source:sourceId 已有节点 → 直接返回（Memory 系统自己的防重，业务侧状态之外的第二道闸）。
    const existing = await MemoryNodeDB.getByCharId(charId);
    const dup = existing.find(n => Array.isArray(n.tags) && n.tags.includes(tag));
    if (dup) return { committed: true, memoryId: dup.id, duplicate: true };

    const now = Date.now();
    const node: MemoryNode = {
        id: genId(),
        charId,
        content: summary.slice(0, 2000),
        // curated 高价值事件 → 卧室（亲密情感、深层羁绊），与期盼实现的温暖记忆同房。
        room: 'bedroom',
        tags: [...(candidate.tags || []), tag],
        importance: Math.min(10, Math.max(1, Math.round(candidate.importance) || 1)),
        mood: candidate.mood?.trim() || 'neutral',
        embedded: false, // 等后续向量化（既有生命周期接管）
        createdAt: candidate.occurredAt ?? now,
        lastAccessedAt: now,
        accessCount: 0,
        eventBoxId: null, // 独立记忆，不进事件盒
        origin: 'system',
    };
    await MemoryNodeDB.save(node);
    return { committed: true, memoryId: node.id };
}
