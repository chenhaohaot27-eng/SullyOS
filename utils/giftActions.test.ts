import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DB } from './db';
import { createGiftRecord, getGiftRecord } from './giftStore';
import { applyGiftReaction } from './giftActions';
import type { GiftReactIntent } from './giftIntent';

beforeEach(async () => {
    await DB.deleteDB();
    vi.restoreAllMocks();
});

const warnSpy = () => vi.spyOn(console, 'warn').mockImplementation(() => {});

async function seedGift(over: Record<string, unknown> = {}) {
    const { record } = await createGiftRecord({
        eventKey: 'gift:user:c1:s1',
        charId: 'c1',
        sender: { type: 'user', id: 'user', nameSnapshot: '玩家' },
        recipient: { type: 'character', id: 'c1', nameSnapshot: '小星' },
        source: 'gift_app',
        gift: { name: '深蓝色围巾' },
        status: 'delivered',
        ...over,
    } as any);
    return record;
}

const intent = (over: Partial<GiftReactIntent> = {}): GiftReactIntent => ({
    giftId: 'gift_target',
    review: '亲手织的，意外但不喜欢围巾',
    disposition: '退还',
    acceptance: 'returned',
    affinityImpact: 'neutral',
    moodImpact: ['为难'],
    memoryImportance: 'normal',
    ...over,
});

async function seedTarget() {
    const { record } = await createGiftRecord({
        eventKey: 'gift:user:c1:target',
        id: undefined,
        charId: 'c1',
        sender: { type: 'user', id: 'user', nameSnapshot: '玩家' },
        recipient: { type: 'character', id: 'c1', nameSnapshot: '小星' },
        source: 'gift_app',
        gift: { name: '目标礼物' },
        status: 'delivered',
    } as any);
    return record;
}

describe('applyGiftReaction — GIFT_REACT 执行器', () => {
    it('正确礼物：成功写 reaction/effects/memory', async () => {
        const target = await seedTarget();
        const res = await applyGiftReaction({ ...intent(), giftId: target.id }, target.id);
        expect(res.applied).toBe(true);
        const loaded = await getGiftRecord(target.id);
        expect(loaded?.reaction?.acceptance).toBe('returned');
        expect(loaded?.reaction?.disposition).toBe('退还');
        expect(loaded?.effects?.affinityImpact).toBe('neutral');
        expect(loaded?.effects?.moodImpact).toEqual(['为难']);
        // appliedAt 刻意不设置：尚未写入统一关系系统
        expect(loaded?.effects?.appliedAt).toBeUndefined();
    });

    it('wrong allowedGiftId：不修改任何记录', async () => {
        const warn = warnSpy();
        const target = await seedTarget();
        const other = await seedGift();
        const res = await applyGiftReaction({ ...intent(), giftId: other.id }, target.id);
        expect(res.applied).toBe(false);
        expect(res.reason).toBe('gift_id_mismatch');
        expect((await getGiftRecord(other.id))?.reaction).toBeUndefined();
        expect((await getGiftRecord(target.id))?.reaction).toBeUndefined();
        expect(warn).toHaveBeenCalled();
    });

    it('无 allowedGiftId（普通聊天轮次）：不执行', async () => {
        const warn = warnSpy();
        const target = await seedTarget();
        const res = await applyGiftReaction({ ...intent(), giftId: target.id }, undefined);
        expect(res.applied).toBe(false);
        expect(res.reason).toBe('no_reaction_context');
        expect((await getGiftRecord(target.id))?.reaction).toBeUndefined();
        expect(warn).toHaveBeenCalled();
    });

    it('不存在的 giftId：不修改', async () => {
        const warn = warnSpy();
        const res = await applyGiftReaction({ ...intent(), giftId: 'gift_ghost' }, 'gift_ghost');
        expect(res.applied).toBe(false);
        expect(res.reason).toBe('gift_not_found');
        expect(warn).toHaveBeenCalled();
    });

    it('duplicate reaction：第二次不覆盖第一次（first-reaction-wins）', async () => {
        const target = await seedTarget();
        const first = await applyGiftReaction({ ...intent(), giftId: target.id }, target.id);
        expect(first.applied).toBe(true);
        const second = await applyGiftReaction(
            { ...intent(), giftId: target.id, acceptance: 'accepted', review: '后来改主意了' },
            target.id,
        );
        expect(second.applied).toBe(false);
        expect(second.reason).toBe('already_reacted');
        expect(second.record?.id).toBe(target.id);
        const loaded = await getGiftRecord(target.id);
        expect(loaded?.reaction?.acceptance).toBe('returned'); // 第一条生效
        expect(loaded?.reaction?.review).toBe('亲手织的，意外但不喜欢围巾');
    });

    it('数值好感字段（affinityDelta 等）绝不进入 GiftRecord', async () => {
        const target = await seedTarget();
        // parser 层已丢弃未知字段；这里直接构造带不合法 affinityImpact 的意图验证兜底
        const res = await applyGiftReaction(
            { ...intent(), giftId: target.id, affinityImpact: '+++5' as any },
            target.id,
        );
        expect(res.applied).toBe(true);
        const loaded = await getGiftRecord(target.id);
        expect(JSON.stringify(loaded)).not.toContain('affinityDelta');
        expect(['strong_positive', 'positive', 'neutral', 'negative', 'strong_negative'])
            .toContain(loaded?.effects?.affinityImpact);
    });

    it('meaningful → memory candidate→committed（Phase 5 接线后自动提交）；normal → none（不写 memoryId）', async () => {
        const target = await seedTarget();
        await applyGiftReaction(
            { ...intent(), giftId: target.id, memoryImportance: 'meaningful', memorySummary: '她第一次织东西给我。' },
            target.id,
        );
        let loaded = await getGiftRecord(target.id);
        // Phase 5：applyGiftReaction 落库后自动提交长期记忆 → 最终 committed + memoryId
        expect(loaded?.memory?.status).toBe('committed');
        expect(loaded?.memory?.summary).toBe('她第一次织东西给我。');
        expect(loaded?.memory?.memoryId).toBeTruthy();

        const other = await seedGift({ eventKey: 'gift:user:c1:s2' });
        await applyGiftReaction(
            { ...intent(), giftId: other.id, memoryImportance: 'normal' },
            other.id,
        );
        loaded = await getGiftRecord(other.id);
        expect(loaded?.memory?.status).toBe('none');
        expect(loaded?.memory?.summary).toBeUndefined();
        expect(loaded?.memory?.memoryId).toBeUndefined();
    });
});
