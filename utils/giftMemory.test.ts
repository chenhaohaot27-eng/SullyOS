import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DB } from './db';
import { createGiftRecord, getGiftRecord, updateGiftRecord } from './giftStore';
import type { GiftRecord } from './giftTypes';
import {
    buildGiftMemorySummary,
    commitGiftMemoryCandidate,
    isGiftMemoryEligible,
} from './giftMemory';
import { applyGiftReaction } from './giftActions';
import type { GiftReactIntent } from './giftIntent';

// 失败注入包装：默认透传 Memory 侧真实入口，需要时置 failNext 模拟 Memory 写入失败。
let failNext = false;
let submitCalls = 0;
vi.mock('./memoryPalace/curatedIngestion', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./memoryPalace/curatedIngestion')>();
    return {
        submitCuratedMemoryCandidate: (candidate: Parameters<typeof actual.submitCuratedMemoryCandidate>[0]) => {
            submitCalls++;
            if (failNext) {
                failNext = false;
                return Promise.reject(new Error('memory pipeline down'));
            }
            return actual.submitCuratedMemoryCandidate(candidate);
        },
    };
});

const { MemoryNodeDB } = await import('./memoryPalace/db');

async function seedGift(over: Record<string, unknown> = {}): Promise<GiftRecord> {
    const { record } = await createGiftRecord({
        eventKey: `gift:user:c1:${Math.random().toString(36).slice(2, 8)}`,
        charId: 'c1',
        sender: { type: 'user', id: 'user', nameSnapshot: '玩家' },
        recipient: { type: 'character', id: 'c1', nameSnapshot: '小星' },
        source: 'gift_app',
        gift: { name: '手织围巾', description: '她第一次亲手织的东西' },
        status: 'delivered',
        ...over,
    } as any);
    return record;
}

const nodesOf = async () => MemoryNodeDB.getByCharId('c1');

beforeEach(async () => {
    await DB.deleteDB();
    failNext = false;
    submitCalls = 0;
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('isGiftMemoryEligible — 触发条件', () => {
    it('trivial / normal 不进长期记忆', async () => {
        const trivial = await seedGift({ memory: { importance: 'trivial', status: 'none' } });
        const normal = await seedGift({ memory: { importance: 'normal', status: 'none' } });
        expect(isGiftMemoryEligible(trivial)).toBe(false);
        expect(isGiftMemoryEligible(normal)).toBe(false);
        expect((await commitGiftMemoryCandidate(trivial.id)).status).toBe('skipped_not_eligible');
        expect((await commitGiftMemoryCandidate(normal.id)).status).toBe('skipped_not_eligible');
        expect(await nodesOf()).toHaveLength(0);
        expect(submitCalls).toBe(0);
    });

    it('candidate 但 importance 非 meaningful 也不提交', async () => {
        const weird = await seedGift({ memory: { importance: 'normal', status: 'candidate' } });
        expect((await commitGiftMemoryCandidate(weird.id)).status).toBe('skipped_not_eligible');
        expect(await nodesOf()).toHaveLength(0);
    });
});

describe('commitGiftMemoryCandidate — 提交与状态', () => {
    it('meaningful：committed + memoryId，节点为角色视角事实、卧室、source:giftId 幂等标记', async () => {
        const gift = await seedGift({
            memory: {
                importance: 'meaningful',
                status: 'candidate',
                summary: '她第一次亲手织东西送给我，我嘴上嫌她熬夜，但还是把围巾收下了。',
            },
        });
        const res = await commitGiftMemoryCandidate(gift.id, '小星');
        expect(res.status).toBe('committed');
        expect(res.memoryId).toBeTruthy();
        const loaded = await getGiftRecord(gift.id);
        expect(loaded?.memory?.status).toBe('committed');
        expect(loaded?.memory?.memoryId).toBe(res.memoryId);

        const nodes = await nodesOf();
        expect(nodes).toHaveLength(1);
        const node = nodes[0];
        expect(node.room).toBe('bedroom');
        expect(node.content).toContain('她第一次亲手织东西送给我');
        expect(node.tags).toContain(`gift:${gift.id}`);
        // 记忆正文是角色视角事实，不含内部枚举/ID 字段
        expect(node.content).not.toContain('affinityImpact');
        expect(node.content).not.toContain('memoryImportance');
        expect(node.content).not.toContain(gift.id);
        expect(node.embedded).toBe(false); // 向量化交由既有生命周期
    });

    it('highly_meaningful：importance 9（meaningful 为 7）', async () => {
        const high = await seedGift({ memory: { importance: 'highly_meaningful', status: 'candidate', summary: '重要' } });
        const mid = await seedGift({ memory: { importance: 'meaningful', status: 'candidate', summary: '一般重要' } });
        await commitGiftMemoryCandidate(high.id);
        await commitGiftMemoryCandidate(mid.id);
        const nodes = await nodesOf();
        expect(nodes.find(n => n.content === '重要')?.importance).toBe(9);
        expect(nodes.find(n => n.content === '一般重要')?.importance).toBe(7);
    });

    it('rejected 的重要礼物仍进记忆（拒绝本身就是长期事件）', async () => {
        const gift = await seedGift({
            memory: { importance: 'meaningful', status: 'candidate', summary: '我拒绝了她准备很久的礼物。' },
            reaction: { acceptance: 'rejected', review: '太贵重了，我受不起' },
        });
        expect((await commitGiftMemoryCandidate(gift.id)).status).toBe('committed');
    });

    it('失败：memory.status=failed，reaction/delivered 原样，无 unhandled rejection', async () => {
        const gift = await seedGift({
            memory: { importance: 'meaningful', status: 'candidate', summary: '重要记忆' },
            reaction: { acceptance: 'accepted', review: '收下了' },
        });
        failNext = true;
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const res = await commitGiftMemoryCandidate(gift.id);
        expect(res.status).toBe('failed');
        const loaded = await getGiftRecord(gift.id);
        expect(loaded?.memory?.status).toBe('failed');
        expect(loaded?.reaction?.acceptance).toBe('accepted'); // reaction 不回滚
        expect(loaded?.status).toBe('delivered'); // 礼物状态不动
        expect(await nodesOf()).toHaveLength(0);
        expect(warnSpy).toHaveBeenCalled();
        warnSpy.mockRestore();
    });

    it('重放幂等：committed 后再调用跳过；adapter 侧 source:giftId 查重兜底', async () => {
        const gift = await seedGift({ memory: { importance: 'meaningful', status: 'candidate', summary: '一次就好' } });
        await commitGiftMemoryCandidate(gift.id);
        // 已 committed → skipped_already，不触 adapter
        const again = await commitGiftMemoryCandidate(gift.id);
        expect(again.status).toBe('skipped_already');
        // 状态被外部重置回 candidate（模拟重放）→ adapter 幂等标记兜底，仍只有 1 个节点
        await updateGiftRecord(gift.id, { memory: { importance: 'meaningful', status: 'candidate', summary: '一次就好' } });
        const replay = await commitGiftMemoryCandidate(gift.id);
        expect(replay.status).toBe('committed');
        expect(await nodesOf()).toHaveLength(1);
        expect(submitCalls).toBe(2); // 两次真实进入 adapter，但只落 1 个节点
    });

    it('fallback summary：summary 空时用确定性文案，不调任何模型', async () => {
        const gift = await seedGift({
            memory: { importance: 'meaningful', status: 'candidate' },
            reaction: { acceptance: 'accepted', review: '嘴上嫌她熬夜' },
        });
        const expected = buildGiftMemorySummary(gift, '小星');
        expect(expected).toContain('用户曾送给小星「手织围巾」');
        expect(expected).toContain('嘴上嫌她熬夜');
        const res = await commitGiftMemoryCandidate(gift.id, '小星');
        expect(res.status).toBe('committed');
        expect((await nodesOf())[0].content).toBe(expected);
    });
});

describe('角色 → 玩家礼物不自动写长期记忆', () => {
    it('char 送礼不提交；giftCharacterSend 源码不接 giftMemory', async () => {
        const { record } = await createGiftRecord({
            eventKey: 'gift:char:c1:send:x',
            charId: 'c1',
            sender: { type: 'character', id: 'c1', nameSnapshot: '小星' },
            recipient: { type: 'user', id: 'user', nameSnapshot: '玩家' },
            source: 'chat_action',
            gift: { name: '项链' },
            image: { origin: 'ai_generated', status: 'ready', imageRef: 'blobref:x' },
            status: 'delivered',
        } as any);
        expect((await commitGiftMemoryCandidate(record.id)).status).toBe('skipped_not_eligible');
        expect(await nodesOf()).toHaveLength(0);
        // 源码级确认：角色送礼链路没有 import giftMemory（只被 applyGiftReaction 消费）
        const src = readFileSync(resolve(__dirname, 'giftCharacterSend.ts'), 'utf-8');
        expect(src).not.toContain('giftMemory');
    });
});

describe('applyGiftReaction 端到端（Phase 5 接线）', () => {
    const reactIntent = (over: Partial<GiftReactIntent> = {}): GiftReactIntent => ({
        giftId: '',
        review: '嘴上嫌她熬夜，但还是收下了',
        disposition: '戴上了',
        acceptance: 'accepted',
        affinityImpact: 'positive',
        moodImpact: ['温暖'],
        memoryImportance: 'meaningful',
        memorySummary: '她第一次亲手织东西送给我。',
        ...over,
    });

    it('meaningful reaction：落库后自动提交长期记忆，最终 committed', async () => {
        const gift = await seedGift();
        const res = await applyGiftReaction({ ...reactIntent(), giftId: gift.id }, gift.id);
        expect(res.applied).toBe(true);
        const loaded = await getGiftRecord(gift.id);
        expect(loaded?.memory?.status).toBe('committed');
        expect(loaded?.memory?.memoryId).toBeTruthy();
        expect(await nodesOf()).toHaveLength(1);
        // appliedAt 仍不设置：mood 未写入任何统一情绪系统
        expect(loaded?.effects?.appliedAt).toBeUndefined();
    });

    it('normal reaction：不提交记忆', async () => {
        const gift = await seedGift();
        await applyGiftReaction({ ...reactIntent(), giftId: gift.id, memoryImportance: 'normal' }, gift.id);
        expect((await getGiftRecord(gift.id))?.memory?.status).toBe('none');
        expect(await nodesOf()).toHaveLength(0);
    });

    it('记忆失败不影响 reaction 落库（applyGiftReaction 仍 applied）', async () => {
        const gift = await seedGift();
        failNext = true;
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const res = await applyGiftReaction({ ...reactIntent(), giftId: gift.id }, gift.id);
        expect(res.applied).toBe(true);
        const loaded = await getGiftRecord(gift.id);
        expect(loaded?.reaction?.acceptance).toBe('accepted');
        expect(loaded?.memory?.status).toBe('failed');
    });

    it('无数值好感污染：全流程后记录不含任何数值关系字段', async () => {
        const gift = await seedGift();
        await applyGiftReaction({ ...reactIntent(), giftId: gift.id }, gift.id);
        const json = JSON.stringify(await getGiftRecord(gift.id));
        for (const banned of ['affinityDelta', 'relationshipScore', 'lovePoints', 'favorability', 'appliedAt']) {
            expect(json).not.toContain(banned);
        }
    });
});
