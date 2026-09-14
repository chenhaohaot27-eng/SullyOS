export interface FoodOrderIntentItem {
    name: string;
    quantity: number;
    note?: string;
}

export interface SimulatedFoodItem {
    name: string;
    price?: number;
    description?: string;
}

export interface SimulatedFoodFallback {
    merchantName: string;
    rating?: number;
    distanceKm?: number;
    deliveryFee?: number;
    etaMinutes?: number;
    items: SimulatedFoodItem[];
}

export interface FoodOrderIntent {
    recipient: 'user' | 'character';
    merchantPreference?: string;
    items: FoodOrderIntentItem[];
    reason?: string;
    useCatalogFirst: boolean;
    simulatedFallback?: SimulatedFoodFallback;
}

export interface FoodOrderExtraction {
    intent: FoodOrderIntent | null;
    cleanedContent: string;
    invalidTagFound: boolean;
    tagCount: number;
}

const FOOD_ORDER_TAG_RE = /\[\[FOOD_ORDER[:：]\s*([\s\S]*?)\]\]/g;
const text = (value: unknown, max: number): string | undefined =>
    typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
const safeNumber = (value: unknown, min: number, max: number): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value >= min
        ? Math.min(max, value)
        : undefined;

function parseItems(value: unknown): FoodOrderIntentItem[] {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 8).flatMap(raw => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
        const obj = raw as Record<string, unknown>;
        const name = text(obj.name, 100);
        if (!name) return [];
        const quantity = typeof obj.quantity === 'number' && Number.isInteger(obj.quantity)
            ? Math.min(20, Math.max(1, obj.quantity))
            : 1;
        return [{ name, quantity, note: text(obj.note, 300) }];
    });
}

function parseFallback(value: unknown): SimulatedFoodFallback | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const obj = value as Record<string, unknown>;
    const merchantName = text(obj.merchantName, 100);
    if (!merchantName || !Array.isArray(obj.items)) return undefined;
    const items = obj.items.slice(0, 8).flatMap(raw => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
        const item = raw as Record<string, unknown>;
        const name = text(item.name, 100);
        if (!name) return [];
        return [{
            name,
            price: safeNumber(item.price, 0, 10_000),
            description: text(item.description, 500),
        }];
    });
    if (items.length === 0) return undefined;
    return {
        merchantName,
        rating: safeNumber(obj.rating, 0, 5),
        distanceKm: safeNumber(obj.distanceKm, 0, 1_000),
        deliveryFee: safeNumber(obj.deliveryFee, 0, 1_000),
        etaMinutes: safeNumber(obj.etaMinutes, 10, 180),
        items,
    };
}

function parseFoodOrderPayload(raw: string): FoodOrderIntent | null {
    let candidate = raw.trim();
    const fenced = candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fenced) candidate = fenced[1].trim();
    let parsed: unknown;
    try { parsed = JSON.parse(candidate); } catch { return null; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    if (obj.recipient !== 'user' && obj.recipient !== 'character') return null;
    const items = parseItems(obj.items);
    if (items.length === 0) return null;
    return {
        recipient: obj.recipient,
        merchantPreference: text(obj.merchantPreference, 100),
        items,
        reason: text(obj.reason, 500),
        useCatalogFirst: obj.useCatalogFirst !== false,
        simulatedFallback: parseFallback(obj.simulatedFallback),
    };
}

/** 所有标签都会剥除；一轮只执行第一个合法 FOOD_ORDER，避免多单。 */
export function extractFoodOrderIntent(content: string): FoodOrderExtraction {
    let intent: FoodOrderIntent | null = null;
    let tagCount = 0;
    const cleanedContent = content.replace(FOOD_ORDER_TAG_RE, (_match, payload: string) => {
        tagCount += 1;
        if (!intent) intent = parseFoodOrderPayload(String(payload));
        return '';
    }).replace(/\n[ \t]*\n+/g, '\n').trim();
    return { intent, cleanedContent, invalidTagFound: tagCount > 0 && !intent, tagCount };
}

export function stripFoodOrderIntent(content: string): string {
    return extractFoodOrderIntent(content).cleanedContent;
}

export function buildFoodOrderTagGuide(): string {
    return `   - **真实点外卖 FOOD_ORDER**: FOOD_ORDER 是会在 Lemuria 中真实创建订单的偶发系统行为。只有你此刻确实实施一份新订单时，先自然说出你点了什么，再单独输出恰好一次严格 JSON：\`[[FOOD_ORDER: {"recipient":"user","merchantPreference":"清淡粥铺","items":[{"name":"鲜虾粥","quantity":1,"note":"不要香菜"}],"reason":"对方今天没怎么吃东西","useCatalogFirst":true,"simulatedFallback":{"merchantName":"夜雨粥铺","deliveryFee":5,"etaMinutes":35,"items":[{"name":"鲜虾粥","price":29,"description":"清淡热粥"}]}}]]\`。recipient 只能是 user（给对方）或 character（给自己）。系统一定先匹配用户导入的真实商品，只有没有足够匹配时才使用 simulatedFallback；fallback 是 Lemuria 模拟信息，不是实时平台数据。讨论、询问、玩笑、假设、回忆、"以后给你点"或"我想给你点"都禁止输出 FOOD_ORDER。食品、正餐、奶茶、咖啡等用 FOOD_ORDER；SEND_PHOTO 只表示照片，GIFT_SEND 只表示礼物，绝不能用 GIFT_SEND 假装点餐。不得提供 orderId/eventKey/状态/时间/API/支付/地址字段，不得输出假链接。不要频繁点外卖。`;
}
