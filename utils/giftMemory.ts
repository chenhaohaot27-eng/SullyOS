/**
 * giftMemory — GiftRecord → 长期记忆的极薄桥（Phase 5）。
 *
 * 职责仅：eligibility 判断 → summary 来源（GIFT_REACT 产出的 memory.summary，空则
 * deterministic fallback，绝不为此再调 LLM）→ 调 Memory 侧公共入口
 * submitCuratedMemoryCandidate → 回写 GiftRecord.memory.status / memoryId。
 *
 * 不复制 Memory Palace 逻辑；不直接写 memory_nodes/vectors/links/event_boxes；
 * 不做记忆重试 UI / 后台队列（失败交由未来聊天 memory pipeline 自然重新捕获）。
 *
 * 边界：
 *  - 只有 importance ∈ {meaningful, highly_meaningful} 且 status === 'candidate' 才提交；
 *    trivial/normal 永远留在 Gift App + Chat history（近期上下文已足够）。
 *  - 角色 → 玩家礼物（Phase 4 GIFT_SEND）没有 GIFT_REACT，永远不会走到这里，
 *    默认不写长期记忆（后续对话若重要，正常 pipeline 会捕获）。
 *  - 提交失败只置 memory.status='failed'，绝不触碰 status / reaction.acceptance。
 *  - 未来召回零特殊处理：节点进 Memory Palace 后由既有召回链自然工作，
 *    不做 giftMemoryPromptInjector。
 */

import { getGiftRecord, updateGiftRecord } from './giftStore';
import type { GiftRecord } from './giftTypes';
import { submitCuratedMemoryCandidate } from './memoryPalace/curatedIngestion';

export type GiftMemoryCommitStatus = 'committed' | 'skipped_not_eligible' | 'skipped_already' | 'failed';

export interface GiftMemoryCommitResult {
    status: GiftMemoryCommitStatus;
    memoryId?: string;
}

export function isGiftMemoryEligible(gift: GiftRecord): boolean {
    return gift.memory?.status === 'candidate'
        && (gift.memory.importance === 'meaningful' || gift.memory.importance === 'highly_meaningful');
}

/**
 * 记忆正文（角色视角事实）：优先 GIFT_REACT 已产出的 memory.summary；
 * 空则 deterministic fallback（描述 + reaction 评价的精简组合）——不调任何模型。
 */
export function buildGiftMemorySummary(gift: GiftRecord, charName: string): string {
    const existing = gift.memory?.summary?.trim();
    if (existing) return existing;
    const parts: string[] = [`用户曾送给${charName || '我'}「${gift.gift.name}」`];
    if (gift.gift.description) parts.push(gift.gift.description.trim());
    const review = gift.reaction?.review?.trim();
    const acceptance = gift.reaction?.acceptance;
    if (review) parts.push(`我当时${review}`);
    else if (acceptance === 'rejected') parts.push('我拒绝了这份礼物');
    else if (acceptance === 'returned') parts.push('我把这份礼物退了回去');
    return `${parts.join('。')}。`.replace(/。。+$/, '。');
}

/**
 * 提交一份礼物的长期记忆候选（幂等：committed 跳过；adapter 侧还有 source:sourceId 查重）。
 * 只改 memory.* 字段；任何失败都不影响礼物本体与 reaction。
 */
export async function commitGiftMemoryCandidate(
    giftId: string,
    charName = '',
): Promise<GiftMemoryCommitResult> {
    const gift = await getGiftRecord(giftId);
    if (!gift) return { status: 'failed' };
    if (gift.memory?.status === 'committed') {
        return { status: 'skipped_already', memoryId: gift.memory.memoryId };
    }
    if (!isGiftMemoryEligible(gift)) return { status: 'skipped_not_eligible' };

    try {
        const outcome = await submitCuratedMemoryCandidate({
            charId: gift.charId,
            source: 'gift',
            sourceId: gift.id,
            summary: buildGiftMemorySummary(gift, charName),
            importance: gift.memory!.importance === 'highly_meaningful' ? 9 : 7,
            tags: ['礼物'],
            mood: gift.reaction?.acceptance === 'rejected' ? 'sad' : 'moved',
            occurredAt: gift.createdAt,
        });
        // 只更新 memory 字段；reaction / status 绝不动。
        await updateGiftRecord(gift.id, {
            memory: {
                ...gift.memory!,
                status: 'committed',
                memoryId: outcome.memoryId,
            },
        });
        return { status: 'committed', memoryId: outcome.memoryId };
    } catch (e) {
        console.warn('[Gift] 长期记忆提交失败，礼物不受影响:', e instanceof Error ? e.message : e);
        await updateGiftRecord(gift.id, {
            memory: { ...gift.memory!, status: 'failed' },
        }).catch(() => { /* 状态回写失败也不升级 */ });
        return { status: 'failed' };
    }
}
