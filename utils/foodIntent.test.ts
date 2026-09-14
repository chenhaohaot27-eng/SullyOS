import { describe, expect, it } from 'vitest';
import { buildFoodOrderTagGuide, extractFoodOrderIntent } from './foodIntent';

const tag = (payload: unknown) => `先吃点东西。\n[[FOOD_ORDER:${JSON.stringify(payload)}]]`;
const valid = {
    recipient: 'user', merchantPreference: '清淡粥铺',
    items: [{ name: '鲜虾粥', quantity: 1, note: '不要香菜' }],
    reason: '今天没吃饭', useCatalogFirst: true,
};

describe('FOOD_ORDER intent', () => {
    it('解析合法严格 JSON 并剥掉标签', () => {
        const out = extractFoodOrderIntent(tag(valid));
        expect(out.intent).toMatchObject(valid);
        expect(out.cleanedContent).toBe('先吃点东西。');
    });
    it('缺少 items 时不执行但仍剥标签', () => {
        const out = extractFoodOrderIntent(tag({ recipient: 'user' }));
        expect(out.intent).toBeNull(); expect(out.invalidTagFound).toBe(true);
        expect(out.cleanedContent).toBe('先吃点东西。');
    });
    it('非法 recipient 不执行', () => {
        expect(extractFoodOrderIntent(tag({ ...valid, recipient: 'friend' })).intent).toBeNull();
    });
    it('模型禁用字段全部忽略', () => {
        const out = extractFoodOrderIntent(tag({ ...valid, orderId: 'hack', eventKey: 'hack', charId: 'x', status: 'delivered', apiKey: 'secret', affinity: 99 }));
        expect(out.intent).not.toBeNull();
        expect(out.intent).not.toHaveProperty('orderId');
        expect(out.intent).not.toHaveProperty('eventKey');
        expect(out.intent).not.toHaveProperty('status');
    });
    it('多个 action 全部 strip，但只认第一个合法 action', () => {
        const out = extractFoodOrderIntent(`${tag(valid)}\n${tag({ ...valid, items: [{ name: '奶茶' }] })}`);
        expect(out.tagCount).toBe(2); expect(out.intent?.items[0].name).toBe('鲜虾粥');
        expect(out.cleanedContent).toBe('先吃点东西。\n先吃点东西。');
    });
    it('malformed JSON 失败且不泄漏标签正文', () => {
        const out = extractFoodOrderIntent('正文\n[[FOOD_ORDER:{bad json}]]');
        expect(out.intent).toBeNull(); expect(out.cleanedContent).toBe('正文');
    });
    it('过长文本、数量和 fallback 数值被限制', () => {
        const out = extractFoodOrderIntent(tag({
            ...valid, merchantPreference: '店'.repeat(200), items: [{ name: '粥'.repeat(200), quantity: 999, note: '少'.repeat(500) }],
            simulatedFallback: { merchantName: '铺'.repeat(200), etaMinutes: 999, deliveryFee: 99999, items: [{ name: '面'.repeat(200), price: 99999, description: '香'.repeat(800) }] },
        })).intent!;
        expect(out.merchantPreference).toHaveLength(100); expect(out.items[0].quantity).toBe(20);
        expect(out.items[0].name).toHaveLength(100); expect(out.items[0].note).toHaveLength(300);
        expect(out.simulatedFallback?.etaMinutes).toBe(180); expect(out.simulatedFallback?.items[0].price).toBe(10_000);
    });
    it('prompt 明确区分 Food、Gift、Photo 与非即时意图', () => {
        const guide = buildFoodOrderTagGuide();
        expect(guide).toContain('GIFT_SEND'); expect(guide).toContain('SEND_PHOTO');
        expect(guide).toContain('以后给你点'); expect(guide).toContain('不要频繁');
    });
});
