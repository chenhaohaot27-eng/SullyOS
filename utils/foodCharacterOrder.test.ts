import { beforeEach, describe, expect, it } from 'vitest';
import type { CharacterProfile } from '../types';
import { DB } from './db';
import { createFoodCatalogItem } from './foodCatalogStore';
import { handleFoodOrderDelivery } from './foodChatBridge';
import {
    AUTONOMOUS_FOOD_COOLDOWN_MS,
    executeCharacterFoodOrder,
    foodOrderActionEventKey,
    hasRecentAutonomousFoodOrder,
    isExplicitFoodRequest,
    matchFoodIntentToCatalog,
    resetFoodOrderActionClaimsForTests,
} from './foodCharacterOrder';
import type { FoodOrderIntent } from './foodIntent';
import { createFoodOrder, listFoodOrders } from './foodOrderStore';

const CHAR = { id: 'c1', name: '祁煜' } as CharacterProfile;
const intent = (over: Partial<FoodOrderIntent> = {}): FoodOrderIntent => ({
    recipient: 'user', merchantPreference: '粥铺',
    items: [{ name: '鲜虾粥', quantity: 1, note: '不要香菜' }],
    useCatalogFirst: true,
    simulatedFallback: {
        merchantName: '夜雨粥铺', deliveryFee: 6, etaMinutes: 35,
        items: [{ name: '鲜虾瘦肉粥', price: 29, description: '清淡热粥' }],
    },
    ...over,
});

async function catalog(name: string, over: Record<string, unknown> = {}) {
    return (await createFoodCatalogItem({
        source: 'imported_share', platform: 'meituan', merchantName: '星河食堂',
        name, price: 22, originalUrl: `https://example.com/${encodeURIComponent(name)}/${Math.random()}`,
        ...over,
    } as any)).record;
}

beforeEach(async () => {
    await DB.deleteDB();
    resetFoodOrderActionClaimsForTests();
});

describe('Catalog-first matching', () => {
    it('exact name 使用真实导入 snapshot 与 imported source', async () => {
        const item = await catalog('鲜虾粥', { imageRef: 'blobref:prawn' });
        const result = await executeCharacterFoodOrder({ intent: intent(), char: CHAR, userName: '玩家', triggerMessageId: 11 });
        expect(result.matchSource).toBe('catalog'); expect(result.order?.source).toBe('catalog_imported');
        expect(result.order?.items[0]).toMatchObject({ catalogItemId: item.id, name: '鲜虾粥', imageRef: 'blobref:prawn', note: '不要香菜' });
    });
    it('多个匹配项按 favorite 优先', async () => {
        const exact = await catalog('鲜虾粥');
        const favorite = await catalog('招牌鲜虾粥', { favorite: true });
        const match = matchFoodIntentToCatalog(intent(), [exact, favorite], []);
        expect(match?.items[0].catalogItemId).toBe(favorite.id);
    });
    it('favorite 相同时按最近下过优先', async () => {
        const older = await catalog('招牌鲜虾粥');
        const newer = await catalog('鲜虾粥大份');
        const previous = (await createFoodOrder({
            eventKey: 'food:old', source: 'catalog_imported', charId: 'c1',
            orderer: { type: 'user', id: 'user', nameSnapshot: '玩家' },
            recipient: { type: 'character', id: 'c1', nameSnapshot: '祁煜' },
            items: [{ catalogItemId: older.id, name: older.name, quantity: 1 }],
            status: 'delivered', timeline: { confirmedAt: 1, preparingAt: 2, pickedUpAt: 3, deliveringAt: 4, estimatedDeliveredAt: 5, deliveredAt: 5 },
        })).record;
        const match = matchFoodIntentToCatalog(intent(), [older, newer], [previous]);
        expect(match?.items[0].catalogItemId).toBe(older.id);
    });
    it('目录无足够匹配时使用单次回复携带的模拟 fallback', async () => {
        await catalog('牛肉饭');
        const result = await executeCharacterFoodOrder({ intent: intent(), char: CHAR, userName: '玩家', triggerMessageId: 12 });
        expect(result.matchSource).toBe('simulated'); expect(result.order?.source).toBe('simulated');
        expect(result.order).toMatchObject({ merchantName: '夜雨粥铺', deliveryFee: 6, total: 35 });
        expect(result.order?.timeline.estimatedDeliveredAt).toBe(result.order!.timeline.confirmedAt + 35 * 60_000);
    });
    it('无目录匹配且无 fallback 时静默跳过', async () => {
        const result = await executeCharacterFoodOrder({ intent: intent({ simulatedFallback: undefined }), char: CHAR, triggerMessageId: 13 });
        expect(result).toMatchObject({ created: false, skipped: 'no_match_or_fallback' });
    });
});

describe('Character FOOD_ORDER persistence', () => {
    it('character -> user 创建一个 OrderRecord 与一张 assistant 卡', async () => {
        const result = await executeCharacterFoodOrder({ intent: intent(), char: CHAR, userName: '玩家', triggerMessageId: 21 });
        expect(result.order?.orderer).toMatchObject({ type: 'character', id: 'c1' });
        expect(result.order?.recipient).toMatchObject({ type: 'user', id: 'user' });
        expect(await listFoodOrders()).toHaveLength(1);
        const cards = (await DB.getMessagesByCharId('c1', true)).filter(message => message.type === 'food_order_card');
        expect(cards).toHaveLength(1); expect(cards[0].role).toBe('assistant');
        expect(cards[0].metadata.foodOrder.source).toBe('simulated');
    });
    it('支持 character -> self', async () => {
        const result = await executeCharacterFoodOrder({ intent: intent({ recipient: 'character' }), char: CHAR, triggerMessageId: 22 });
        expect(result.order?.recipient).toMatchObject({ type: 'character', id: 'c1', nameSnapshot: '祁煜' });
    });
    it('角色订单送达只写系统事件，不触发额外角色回复', async () => {
        const result = await executeCharacterFoodOrder({ intent: intent(), char: CHAR, userName: '玩家', triggerMessageId: 220 });
        const order = result.order!;
        const delivery = await handleFoodOrderDelivery(order.id, {
            char: CHAR, userProfile: { name: '玩家' } as any, groups: [], apiConfig: {} as any,
        }, order.timeline.estimatedDeliveredAt + 1);
        expect(delivery).toMatchObject({ eventCreated: true, reactionTriggered: false });
        const events = (await DB.getMessagesByCharId('c1', true)).filter(message => message.role === 'system' && message.metadata?.foodOrder?.orderId === order.id && message.metadata?.foodOrder?.phase === 'delivered');
        expect(events).toHaveLength(1);
    });
    it('同一 assistant action 重放只保留一单一卡', async () => {
        const first = await executeCharacterFoodOrder({ intent: intent(), char: CHAR, triggerMessageId: 23 });
        const again = await executeCharacterFoodOrder({ intent: intent(), char: CHAR, triggerMessageId: 23 });
        expect(first.created).toBe(true); expect(again.skipped).toBe('already_exists');
        expect(await listFoodOrders()).toHaveLength(1);
        expect((await DB.getMessagesByCharId('c1', true)).filter(message => message.type === 'food_order_card')).toHaveLength(1);
    });
    it('并发重放由 action claim + eventKey unique 收敛为一单一卡', async () => {
        const [a, b] = await Promise.all([
            executeCharacterFoodOrder({ intent: intent(), char: CHAR, triggerMessageId: 24 }),
            executeCharacterFoodOrder({ intent: intent(), char: CHAR, triggerMessageId: 24 }),
        ]);
        expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
        expect(await listFoodOrders()).toHaveLength(1);
        expect((await DB.getMessagesByCharId('c1', true)).filter(message => message.type === 'food_order_card')).toHaveLength(1);
    });
    it('事件键绑定 assistant trigger message', () => {
        expect(foodOrderActionEventKey('c1', intent(), 991)).toBe('food:assistant:991:order:0');
    });
});

describe('6h autonomous cooldown', () => {
    it('首单允许，6h 内第二个自主新订单静默阻止', async () => {
        const first = await executeCharacterFoodOrder({ intent: intent(), char: CHAR, triggerMessageId: 31 });
        const second = await executeCharacterFoodOrder({ intent: intent({ items: [{ name: '小米粥', quantity: 1 }] }), char: CHAR, triggerMessageId: 32 });
        expect(first.created).toBe(true);
        expect(second).toMatchObject({ created: false, skipped: 'cooldown' });
    });
    it('明确用户请求绕过 cooldown', async () => {
        await executeCharacterFoodOrder({ intent: intent(), char: CHAR, triggerMessageId: 33 });
        const bypass = await executeCharacterFoodOrder({
            intent: intent({ items: [{ name: '奶茶', quantity: 1 }], simulatedFallback: { merchantName: '潮汐茶铺', items: [{ name: '奶茶', price: 18 }] } }),
            char: CHAR, triggerMessageId: 34, explicitFoodRequest: true,
        });
        expect(bypass.created).toBe(true);
        expect(isExplicitFoodRequest('给我买杯奶茶')).toBe(true);
        expect(isExplicitFoodRequest('以后要不要一起喝奶茶？')).toBe(false);
    });
    it('玩家订单不进入自主订单 cooldown', async () => {
        await createFoodOrder({
            eventKey: 'food:user:c1:x', source: 'catalog_imported', charId: 'c1',
            orderer: { type: 'user', id: 'user', nameSnapshot: '玩家' },
            recipient: { type: 'character', id: 'c1', nameSnapshot: '祁煜' },
            items: [{ name: '牛肉饭', quantity: 1 }], status: 'confirmed',
            timeline: { confirmedAt: 1, preparingAt: 2, pickedUpAt: 3, deliveringAt: 4, estimatedDeliveredAt: 5 },
        });
        expect(await hasRecentAutonomousFoodOrder('c1')).toBe(false);
        expect((await executeCharacterFoodOrder({ intent: intent(), char: CHAR, triggerMessageId: 35 })).created).toBe(true);
    });
    it('满 6 小时后不再命中', async () => {
        const now = Date.now();
        const result = await executeCharacterFoodOrder({ intent: intent(), char: CHAR, triggerMessageId: 36, now });
        expect(await hasRecentAutonomousFoodOrder('c1', result.order!.createdAt + AUTONOMOUS_FOOD_COOLDOWN_MS + 1)).toBe(false);
    });
});

describe('token and wiring guards', () => {
    it('Catalog 与 fallback 全程不导入 Vision、Image 或额外 Chat client', async () => {
        const fs = await import('node:fs');
        const source = fs.readFileSync(new URL('./foodCharacterOrder.ts', import.meta.url), 'utf8');
        expect(source).not.toMatch(/visionApi|imageGeneration|generateImage|completeChat|safeFetchJson/);
    });
    it('统一后处理会剥离并执行 FOOD_ORDER，worker 路径明确禁止执行', async () => {
        const fs = await import('node:fs');
        const source = fs.readFileSync(new URL('./applyAssistantPostProcessing.ts', import.meta.url), 'utf8');
        expect(source).toContain('extractFoodOrderIntent(aiContent)');
        expect(source).toContain('foodOrderExtraction.intent && !skipSecondPassLLM');
        expect(source).toContain('executeCharacterFoodOrder({');
    });
});
