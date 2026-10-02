import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DB } from './db';
import { createGiftRecord, getGiftRecord } from './giftStore';
import {
    projectGiftToChat,
    refreshGiftCardSnapshot,
    triggerGiftReaction,
} from './giftChatBridge';

// 网络层全部 mock：这里只验证桥接编排，不测真实 API。
const fetchMock = vi.hoisted(() => vi.fn(async (_url: string, _init: any) => ({
    choices: [{ message: { content: '你自己织的？\n行，我收了。' } }],
})));
vi.mock('./safeApi', () => ({ safeFetchJson: fetchMock }));

// 后处理是大链路（有自己的测试），这里断言桥把「原始内容 + giftReactionContext」交给它。
const postProcessMock = vi.hoisted(() => vi.fn(async (_raw: string, _ctx: any) => {}));
vi.mock('./applyAssistantPostProcessing', () => ({
    applyAssistantPostProcessing: postProcessMock,
}));

// payload 构造同样是重链路（记忆宫殿/世界书），mock 成最小形态。
vi.mock('./chatRequestPayload', () => ({
    buildChatRequestPayload: async () => ({
        systemPrompt: 'SYS',
        cleanedApiMessages: [],
        fullMessages: [{ role: 'system', content: 'SYS' }],
        flags: {},
    }),
}));

// reaction 流程绝不该再调 vision（Phase 2 已经识别并缓存过）。
const describeImageMock = vi.hoisted(() => vi.fn(async () => '不应被调用'));
vi.mock('./visionApi', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./visionApi')>();
    return { ...actual, describeImageWithVisionApi: describeImageMock };
});

const CHAR = { id: 'c1', name: '小星', avatar: '' } as any;
const USER = { name: '玩家', avatar: '' } as any;
const API = { baseUrl: 'https://api.test/v1', apiKey: 'k', model: 'm', temperature: 0.8 } as any;

async function seedGift(over: Record<string, unknown> = {}) {
    const { record } = await createGiftRecord({
        eventKey: 'gift:user:c1:s1',
        charId: 'c1',
        sender: { type: 'user', id: 'user', nameSnapshot: '玩家' },
        recipient: { type: 'character', id: 'c1', nameSnapshot: '小星' },
        source: 'gift_app',
        gift: { name: '深蓝色围巾', description: '自己织的', note: '记得戴' },
        status: 'delivered',
        ...over,
    } as any);
    return record;
}

beforeEach(async () => {
    await DB.deleteDB();
    fetchMock.mockClear();
    postProcessMock.mockClear();
    describeImageMock.mockClear();
    await DB.saveMessage({ charId: 'c1', role: 'user', type: 'text', content: '在吗', timestamp: Date.now() });
});

const cardsOf = async () =>
    (await DB.getMessagesByCharId('c1', true)).filter(m => m.type === 'gift_card');

describe('projectGiftToChat — 聊天投影幂等', () => {
    it('首次投影：创建一张 user 角色 gift_card，快照正确且不含内部字段', async () => {
        const gift = await seedGift();
        const res = await projectGiftToChat(gift);
        expect(res.created).toBe(true);
        const cards = await cardsOf();
        expect(cards).toHaveLength(1);
        expect(cards[0].role).toBe('user');
        expect(cards[0].content).toBe('');
        expect(cards[0].metadata.gift).toMatchObject({
            giftId: gift.id,
            direction: 'user_to_character',
            name: '深蓝色围巾',
        });
        expect(cards[0].metadata.gift.eventKey).toBeUndefined();
        expect(cards[0].metadata.gift.reaction).toBeUndefined();
    });

    it('GiftRecord.chat.cardMessageId 正确回写', async () => {
        const gift = await seedGift();
        const res = await projectGiftToChat(gift);
        const loaded = await getGiftRecord(gift.id);
        expect(loaded?.chat?.cardMessageId).toBe(res.cardMessageId);
        expect(Number(loaded?.chat?.cardMessageId)).toBe((await cardsOf())[0].id);
    });

    it('同一礼物投影两次：只有一张卡（双击/重跑/刷新）', async () => {
        const gift = await seedGift();
        const first = await projectGiftToChat(gift);
        const again = await projectGiftToChat((await getGiftRecord(gift.id))!);
        expect(first.created).toBe(true);
        expect(again.created).toBe(false);
        expect(again.cardMessageId).toBe(first.cardMessageId);
        expect(await cardsOf()).toHaveLength(1);
    });

    it('cardMessageId 缺失但聊天已有同 giftId 卡：恢复链接，不重复插入', async () => {
        const gift = await seedGift();
        await DB.saveMessage({
            charId: 'c1', role: 'user', type: 'gift_card', content: '',
            metadata: { gift: { giftId: gift.id, direction: 'user_to_character', name: '深蓝色围巾' } },
        });
        const res = await projectGiftToChat(gift);
        expect(res.created).toBe(false);
        expect(await cardsOf()).toHaveLength(1);
        const loaded = await getGiftRecord(gift.id);
        expect(loaded?.chat?.cardMessageId).toBe(res.cardMessageId);
    });
});

describe('triggerGiftReaction — 角色回应触发', () => {
    it('正常流：调一次聊天 API，把原始内容 + giftReactionContext 交给 post-processing', async () => {
        const gift = await seedGift();
        const res = await triggerGiftReaction(gift.id, {
            char: CHAR, userProfile: USER, groups: [], apiConfig: API,
        });
        expect(res.ok).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        expect(String(url)).toContain('/chat/completions');
        // 末尾 system 是礼物回应指令，包含礼物名与协议
        const messages = JSON.parse(init.body).messages;
        const tail = messages[messages.length - 1];
        expect(tail.role).toBe('system');
        expect(tail.content).toContain('深蓝色围巾');
        expect(tail.content).toContain('GIFT_REACT');
        // post-processing 收到原始内容与允许的 giftId
        expect(postProcessMock).toHaveBeenCalledTimes(1);
        const [rawContent, ctx] = postProcessMock.mock.calls[0];
        expect(rawContent).toContain('我收了');
        expect(ctx.giftReactionContext).toEqual({ giftId: gift.id });
        expect(ctx.instantRender).toBe(true);
        // reaction 流程绝不重新识图
        expect(describeImageMock).not.toHaveBeenCalled();
    });

    it('Chat API 失败：ok=false，礼物仍 delivered、无 reaction、无 post-processing', async () => {
        fetchMock.mockRejectedValueOnce(new Error('额度不足'));
        const gift = await seedGift();
        const res = await triggerGiftReaction(gift.id, {
            char: CHAR, userProfile: USER, groups: [], apiConfig: API,
        });
        expect(res.ok).toBe(false);
        expect(postProcessMock).not.toHaveBeenCalled();
        const loaded = await getGiftRecord(gift.id);
        expect(loaded?.status).toBe('delivered');
        expect(loaded?.reaction).toBeUndefined();
    });

    it('已有正式 reaction：跳过生成（不重复扣费）', async () => {
        const gift = await seedGift();
        const { updateGiftRecord } = await import('./giftStore');
        await updateGiftRecord(gift.id, { reaction: { acceptance: 'accepted' } });
        const res = await triggerGiftReaction(gift.id, {
            char: CHAR, userProfile: USER, groups: [], apiConfig: API,
        });
        expect(res.ok).toBe(false);
        expect(res.reason).toBe('already_reacted');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('空回复：ok=false，不进 post-processing', async () => {
        fetchMock.mockResolvedValueOnce({ choices: [{ message: { content: '' } }] });
        const gift = await seedGift();
        const res = await triggerGiftReaction(gift.id, {
            char: CHAR, userProfile: USER, groups: [], apiConfig: API,
        });
        expect(res.ok).toBe(false);
        expect(postProcessMock).not.toHaveBeenCalled();
    });
});

describe('refreshGiftCardSnapshot — 识图摘要晚到同步', () => {
    it('visualSummary 落定后同步进礼物卡快照，幂等', async () => {
        const gift = await seedGift();
        await projectGiftToChat(gift);
        const { updateGiftRecord } = await import('./giftStore');
        const updated = (await updateGiftRecord(gift.id, {
            image: { ...(gift.image as any), visualSummary: '一条深蓝色针织围巾。' },
        }))!;
        await refreshGiftCardSnapshot(updated);
        const card = (await cardsOf())[0];
        expect(card.metadata.gift.visualSummary).toBe('一条深蓝色针织围巾。');
        // 再跑一次不重复写、不报错
        await refreshGiftCardSnapshot(updated);
        expect((await cardsOf())[0].metadata.gift.visualSummary).toBe('一条深蓝色针织围巾。');
    });
});
