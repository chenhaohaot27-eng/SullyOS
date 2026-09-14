import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DB } from './db';
import { createFoodOrder, getFoodOrder, updateFoodOrder } from './foodOrderStore';

const mocks = vi.hoisted(() => ({
    completeChat: vi.fn(),
    postProcess: vi.fn(),
    buildPayload: vi.fn(),
}));

vi.mock('./chatCompletionClient', () => ({ completeChat: mocks.completeChat }));
vi.mock('./applyAssistantPostProcessing', () => ({ applyAssistantPostProcessing: mocks.postProcess }));
vi.mock('./chatRequestPayload', () => ({ buildChatRequestPayload: mocks.buildPayload }));
vi.mock('./chatPrompts', () => ({ ChatPrompts: { filterVisibleEmojis: () => ({ emojis: [], categories: [] }) } }));
vi.mock('./formalNpcRegistry', () => ({ resolveCharacterChatApiConfig: (api: any) => api }));

import {
    materializeFoodOrderStatus,
    projectFoodOrderToChat,
    triggerFoodOrderReaction,
    handleFoodOrderDelivery,
} from './foodChatBridge';

const CHAR = { id: 'c1', name: '小星', avatar: '', contextLimit: 20 } as any;
const USER = { id: 'user', name: '玩家', avatar: '' } as any;
const API = { baseUrl: 'https://api.test/v1', apiKey: 'k', model: 'm' } as any;
const deps = { char: CHAR, userProfile: USER, groups: [], apiConfig: API };

async function seed(over: Record<string, unknown> = {}) {
    return (await createFoodOrder({
        eventKey: `food:user:c1:${Math.random()}`,
        source: 'catalog_imported',
        orderer: { type: 'user', id: 'user', nameSnapshot: '玩家' },
        recipient: { type: 'character', id: 'c1', nameSnapshot: '小星' },
        charId: 'c1', merchantName: '星河食堂',
        items: [{ catalogItemId: 'item-1', name: '牛肉饭', quantity: 1, unitPrice: 28, imageRef: 'blobref:food-1' }],
        subtotal: 28, deliveryFee: 5, total: 33, status: 'confirmed',
        timeline: { confirmedAt: 100, preparingAt: 200, pickedUpAt: 300, deliveringAt: 400, estimatedDeliveredAt: 500 },
        ...over,
    } as any)).record;
}

const messages = () => DB.getMessagesByCharId('c1', true);

beforeEach(async () => {
    await DB.deleteDB();
    vi.clearAllMocks();
    mocks.completeChat.mockResolvedValue({ choices: [{ message: { content: '好，我等着。' } }] });
    mocks.buildPayload.mockResolvedValue({ fullMessages: [{ role: 'system', content: 'SYS' }] });
    mocks.postProcess.mockImplementation(async (raw: string) => {
        await DB.saveMessage({ charId: 'c1', role: 'assistant', type: 'text', content: raw });
    });
});

describe('Food order Chat projection', () => {
    it('首次创建一张订单卡', async () => {
        const order = await seed();
        const result = await projectFoodOrderToChat(order);
        expect(result.created).toBe(true);
        const card = (await messages()).find(message => message.type === 'food_order_card')!;
        expect(card.metadata.foodOrder).toMatchObject({ orderId: order.id, phase: 'ordered', merchantName: '星河食堂' });
        expect(card.metadata.foodOrder.eventKey).toBeUndefined();
    });
    it('重放不重复投影', async () => {
        const order = await seed();
        await projectFoodOrderToChat(order);
        const again = await projectFoodOrderToChat((await getFoodOrder(order.id))!);
        expect(again.created).toBe(false);
        expect((await messages()).filter(message => message.type === 'food_order_card')).toHaveLength(1);
    });
    it('已有卡但链接丢失时恢复链接', async () => {
        const order = await seed();
        await DB.saveMessage({ charId: 'c1', role: 'user', type: 'food_order_card', content: '', metadata: { foodOrder: { orderId: order.id, phase: 'ordered' } } });
        const result = await projectFoodOrderToChat(order);
        expect(result.created).toBe(false);
        expect((await getFoodOrder(order.id))?.chat?.orderCardMessageId).toBe(result.cardMessageId);
    });
    it('卡片只保存正确 orderId 与极简 fallback', async () => {
        const order = await seed(); await projectFoodOrderToChat(order);
        const snap = (await messages()).find(message => message.type === 'food_order_card')!.metadata.foodOrder;
        expect(snap.orderId).toBe(order.id);
        expect(snap.timeline).toBeUndefined(); expect(snap.orderer).toBeUndefined(); expect(snap.recipient).toBeUndefined();
    });
    it('投影只复用 blobref，不复制 Blob', async () => {
        const spy = vi.spyOn(DB, 'putBlobAsset');
        const order = await seed(); await projectFoodOrderToChat(order);
        expect(spy).not.toHaveBeenCalled();
        expect((await messages()).find(message => message.type === 'food_order_card')!.metadata.foodOrder.representativeImageRef).toBe('blobref:food-1');
    });
});

describe('placed reaction', () => {
    it('复用正常 payload/client/post-processing，一次最多一回', async () => {
        const order = await seed(); await projectFoodOrderToChat(order);
        expect((await triggerFoodOrderReaction(order.id, 'ordered', deps)).ok).toBe(true);
        expect((await triggerFoodOrderReaction(order.id, 'ordered', deps)).reason).toBe('already_attempted');
        expect(mocks.buildPayload).toHaveBeenCalledTimes(1);
        expect(mocks.completeChat).toHaveBeenCalledTimes(1);
        expect(mocks.postProcess).toHaveBeenCalledTimes(1);
    });
    it('API 失败不改变订单 confirmed', async () => {
        mocks.completeChat.mockRejectedValueOnce(new Error('offline'));
        const order = await seed();
        expect((await triggerFoodOrderReaction(order.id, 'ordered', deps)).ok).toBe(false);
        expect((await getFoodOrder(order.id))?.status).toBe('confirmed');
    });
    it('自动回复请求禁用 Vision 且源码不建立第二客户端/生图入口', async () => {
        const order = await seed(); await triggerFoodOrderReaction(order.id, 'ordered', deps);
        expect(mocks.buildPayload.mock.calls[0][0].visionApiConfig).toBeUndefined();
        const source = await import('node:fs').then(fs => fs.readFileSync(new URL('./foodChatBridge.ts', import.meta.url), 'utf8'));
        expect(source).toContain("from './chatCompletionClient'");
        expect(source).not.toMatch(/safeFetchJson|describeImageWithVisionApi|generateImage\(/);
    });
    it('越界动作标签在通用后处理前被丢弃，只留下自然正文', async () => {
        mocks.completeChat.mockResolvedValueOnce({
            choices: [{ message: { content: '收到啦\n[[ACTION:TRANSFER|to=user|amount=1]]\n[schedule_message | 2099-01-01 12:00:00 | fixed | test]' } }],
        });
        const order = await seed();
        await triggerFoodOrderReaction(order.id, 'ordered', deps);
        expect(mocks.postProcess.mock.calls[0][0]).toBe('收到啦');
    });
});

describe('delivery event', () => {
    it('ETA 前不创建 delivery event', async () => {
        const order = await seed();
        const result = await handleFoodOrderDelivery(order.id, deps, 450);
        expect(result.eventCreated).toBe(false);
        expect((await messages()).filter(message => message.metadata?.foodOrder?.phase === 'delivered')).toHaveLength(0);
    });
    it('ETA 后持久 delivered/deliveredAt 并创建一次事件', async () => {
        const order = await seed();
        const result = await handleFoodOrderDelivery(order.id, deps, 600);
        expect(result.eventCreated).toBe(true);
        expect(result.order?.status).toBe('delivered');
        expect(result.order?.timeline.deliveredAt).toBe(500);
    });
    it('重放不重复 event', async () => {
        const order = await seed();
        await handleFoodOrderDelivery(order.id, deps, 600);
        await handleFoodOrderDelivery(order.id, deps, 700);
        expect((await messages()).filter(message => message.metadata?.foodOrder?.phase === 'delivered')).toHaveLength(1);
    });
    it('并发送达检查也只创建一个 event', async () => {
        const order = await seed();
        await Promise.all([
            handleFoodOrderDelivery(order.id, deps, 600),
            handleFoodOrderDelivery(order.id, deps, 600),
        ]);
        expect((await messages()).filter(message => message.metadata?.foodOrder?.phase === 'delivered')).toHaveLength(1);
    });
    it('模拟关闭后超过 ETA 首次重开补建一次', async () => {
        const order = await seed();
        const reopened = await handleFoodOrderDelivery(order.id, deps, 10_000);
        expect(reopened.eventCreated).toBe(true);
        expect((await getFoodOrder(order.id))?.chat?.deliveryEventMessageId).toBeTruthy();
    });
    it('cancelled 不推进、不送达', async () => {
        const order = await seed({ status: 'cancelled' });
        expect((await materializeFoodOrderStatus(order.id, 10_000))?.status).toBe('cancelled');
        const result = await handleFoodOrderDelivery(order.id, deps, 10_000);
        expect(result.eventCreated).toBe(false); expect(mocks.completeChat).not.toHaveBeenCalled();
    });
    it('送达 Chat response 最多一次', async () => {
        const order = await seed();
        await handleFoodOrderDelivery(order.id, deps, 600);
        await handleFoodOrderDelivery(order.id, deps, 700);
        expect(mocks.completeChat).toHaveBeenCalledTimes(1);
        expect((await getFoodOrder(order.id))?.chat?.deliveryReactionAttemptedAt).toBeTruthy();
    });
    it('完整成功订单最多两次 Chat，且两次都不路由 Vision', async () => {
        const order = await seed();
        await projectFoodOrderToChat(order);
        await triggerFoodOrderReaction(order.id, 'ordered', deps);
        await handleFoodOrderDelivery(order.id, deps, 600);
        await handleFoodOrderDelivery(order.id, deps, 700);
        expect(mocks.completeChat).toHaveBeenCalledTimes(2);
        expect(mocks.buildPayload).toHaveBeenCalledTimes(2);
        expect(mocks.buildPayload.mock.calls.every(call => call[0].visionApiConfig === undefined)).toBe(true);
    });
});

describe('Food order Chat wiring', () => {
    it('MessageItem 与历史 formatter 都接入订单卡片', async () => {
        const fs = await import('node:fs');
        const messageItem = fs.readFileSync(new URL('../components/chat/MessageItem.tsx', import.meta.url), 'utf8');
        const prompts = fs.readFileSync(new URL('./chatPrompts.ts', import.meta.url), 'utf8');
        expect(messageItem).toContain("m.type === 'food_order_card'");
        expect(prompts).toContain("m.type as string) === 'food_order_card'");
        expect(prompts).toContain('[外卖订单]');
        expect(prompts).toContain('这不是假设');
    });
});
