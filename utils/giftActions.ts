/**
 * giftActions — GIFT_REACT 结构化结果的执行器（Phase 3）。
 *
 * 职责单一：validate intent → 定位 GiftRecord → 安全校验（只允许本轮被回应的礼物）→
 * first-reaction-wins 去重 → 回写 reaction / effects / memory(candidate)。
 *
 * 安全边界：模型输出的 giftId 不可信。调用方（applyAssistantPostProcessing 经
 * ctx.giftReactionContext）传入本轮允许回应的 giftId；不匹配 → 静默不执行（仅脱敏 warn），
 * 绝不因为模型指名别的礼物就改写历史记录。
 *
 * 语义边界（Phase 3 约定）：
 *  - effects.appliedAt 保持 undefined —— 尚未写入任何统一关系系统；
 *  - memory 只写 candidate 标记，不写 memory_nodes / vectors / links / event_boxes。
 */

import { getGiftRecord, updateGiftRecord } from './giftStore';
import type { GiftAffinityImpact, GiftMemoryImportance, GiftRecord } from './giftTypes';
import type { GiftReactIntent } from './giftIntent';
import { commitGiftMemoryCandidate, isGiftMemoryEligible } from './giftMemory';

export type ApplyGiftReactionReason =
    | 'no_reaction_context'   // 本轮没有礼物上下文（不应该发生）
    | 'gift_id_mismatch'      // 模型给的 giftId 不是本轮允许回应的礼物
    | 'gift_not_found'        // giftId 对不上任何 GiftRecord
    | 'already_reacted';      // first-reaction-wins：已有正式 reaction，不覆盖

export interface ApplyGiftReactionResult {
    applied: boolean;
    reason?: ApplyGiftReactionReason;
    /** applied 或 already_reacted 时返回最新记录，方便调用方刷新 UI。 */
    record?: GiftRecord;
}

/** meaningful / highly_meaningful → candidate；trivial / normal → none。 */
export function giftMemoryStatusFor(importance?: GiftMemoryImportance): 'candidate' | 'none' {
    return importance === 'meaningful' || importance === 'highly_meaningful' ? 'candidate' : 'none';
}

const AFFINITY_VALUES: readonly GiftAffinityImpact[] = ['strong_positive', 'positive', 'neutral', 'negative', 'strong_negative'];

/** 执行器兜底：非法/缺失的 affinityImpact 一律归一成 neutral（parser 层已挡，这里防直调）。 */
const sanitizeAffinity = (value: unknown): GiftAffinityImpact =>
    typeof value === 'string' && (AFFINITY_VALUES as readonly string[]).includes(value)
        ? value as GiftAffinityImpact
        : 'neutral';

/**
 * 应用一次 GIFT_REACT。同一份礼物的第一条正式 reaction 生效（first valid reaction wins），
 * 之后的重复执行（post-processing 重放 / 流式 finalize 重跑 / StrictMode / 刷新）一律短路。
 */
export async function applyGiftReaction(
    intent: GiftReactIntent,
    allowedGiftId?: string,
): Promise<ApplyGiftReactionResult> {
    if (!allowedGiftId) {
        console.warn('[Gift] GIFT_REACT 出现在没有礼物上下文的轮次，已忽略');
        return { applied: false, reason: 'no_reaction_context' };
    }
    if (intent.giftId !== allowedGiftId) {
        // 只记 giftId（本身是本地生成 id，无敏感信息），不记 payload。
        console.warn('[Gift] GIFT_REACT 的 giftId 不属于本轮礼物，已忽略', { expected: allowedGiftId, got: intent.giftId });
        return { applied: false, reason: 'gift_id_mismatch' };
    }

    const record = await getGiftRecord(intent.giftId);
    if (!record) {
        console.warn('[Gift] GIFT_REACT 指向不存在的 GiftRecord，已忽略', { giftId: intent.giftId });
        return { applied: false, reason: 'gift_not_found' };
    }

    // first-reaction-wins：已有正式 acceptance 就不再覆盖，重复执行直接返回现有记录。
    if (record.reaction?.acceptance) {
        return { applied: false, reason: 'already_reacted', record };
    }

    const updated = await updateGiftRecord(record.id, {
        reaction: {
            review: intent.review || undefined,
            disposition: intent.disposition || undefined,
            acceptance: intent.acceptance,
        },
        effects: {
            affinityImpact: sanitizeAffinity(intent.affinityImpact),
            moodImpact: intent.moodImpact,
            // effects.reason：来自结构化意图的简短说明（review 截断），不是用户可见文案。
            reason: (intent.disposition || intent.review || '').trim().slice(0, 120) || undefined,
            // appliedAt 刻意不设置：语义影响已记录，但尚未应用到任何统一关系值/情绪系统。
        },
        memory: {
            importance: intent.memoryImportance,
            summary: intent.memoryImportance === 'meaningful' || intent.memoryImportance === 'highly_meaningful'
                ? intent.memorySummary
                : undefined,
            status: giftMemoryStatusFor(intent.memoryImportance),
            // memoryId 刻意不设置：尚未写入 Memory Palace。
        },
    });

    const finalRecord = updated || record;

    // Phase 5：reaction 落库成功后，meaningful/highly_meaningful 的礼物提交长期记忆。
    // await 发生在 Step 7.5（正文已渲染落库之后），不阻塞角色可见回复；内部全捕获，
    // 失败只置 memory.status='failed'，绝不回滚 reaction（见 utils/giftMemory.ts）。
    if (isGiftMemoryEligible(finalRecord)) {
        await commitGiftMemoryCandidate(finalRecord.id, record.sender.type === 'user'
            ? record.recipient.nameSnapshot
            : record.sender.nameSnapshot);
    }

    return { applied: true, record: finalRecord };
}
