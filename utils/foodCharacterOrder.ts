import type { CharacterProfile } from '../types';
import { FOOD_DELIVERY_FEE } from './foodCart';
import { listFoodCatalogItems } from './foodCatalogStore';
import { projectFoodOrderToChat } from './foodChatBridge';
import {
    createFoodOrder,
    getFoodOrderByEventKey,
    listFoodOrdersByChar,
} from './foodOrderStore';
import { createFoodOrderTimeline } from './foodOrderTimeline';
import type { FoodOrderItemSnapshot, FoodOrderRecord } from './foodOrderTypes';
import type { FoodCatalogItem } from './foodTypes';
import type { FoodOrderIntent } from './foodIntent';

export const AUTONOMOUS_FOOD_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const ACTION_CLAIM_TTL_MS = 60_000;
const actionClaims = new Map<string, number>();

const normalize = (value?: string): string =>
    (value || '').normalize('NFKC').trim().toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');

const stableHash = (value: string): string => {
    let hash = 0x811c9dc5;
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36);
};

export function foodOrderActionEventKey(
    charId: string,
    intent: FoodOrderIntent,
    triggerMessageId?: string | number,
    now = Date.now(),
): string {
    if (triggerMessageId !== undefined && String(triggerMessageId).trim()) {
        return `food:assistant:${String(triggerMessageId).trim().slice(0, 160)}:order:0`;
    }
    const bucket = Math.floor(now / AUTONOMOUS_FOOD_COOLDOWN_MS);
    return `food:assistant:${charId}:${bucket}:${stableHash(JSON.stringify(intent))}:order:0`;
}

export function isExplicitFoodRequest(content: string | undefined): boolean {
    const value = (content || '').normalize('NFKC').trim();
    if (!value) return false;
    return /(?:给我|帮我|替我|为我).{0,10}(?:点|买|选|叫).{0,8}(?:外卖|吃的|饭|餐|粥|面|奶茶|咖啡|饮料)/u.test(value)
        || /(?:点|叫|买).{0,4}(?:个|份|杯)?(?:外卖|奶茶|咖啡|吃的)/u.test(value)
        || /帮我选点吃的/u.test(value);
}

export async function hasRecentAutonomousFoodOrder(
    charId: string,
    now = Date.now(),
    withinMs = AUTONOMOUS_FOOD_COOLDOWN_MS,
): Promise<boolean> {
    const since = now - withinMs;
    return (await listFoodOrdersByChar(charId)).some(order =>
        order.orderer.type === 'character' && order.createdAt > since,
    );
}

function nameScore(item: FoodCatalogItem, desiredName: string): number {
    const desired = normalize(desiredName);
    const name = normalize(item.name);
    const description = normalize(item.description);
    if (!desired || !name) return 0;
    if (name === desired) return 100;
    if (name.includes(desired) || desired.includes(name)) return 60;
    if (description.includes(desired)) return 20;
    return 0;
}

interface MatchContext {
    recentByCatalogId: Map<string, number>;
    merchantPreference?: string;
}

function compareCandidates(a: FoodCatalogItem, b: FoodCatalogItem, desired: string, ctx: MatchContext): number {
    const favorite = Number(!!b.favorite) - Number(!!a.favorite);
    if (favorite) return favorite;
    const recent = (ctx.recentByCatalogId.get(b.id) || 0) - (ctx.recentByCatalogId.get(a.id) || 0);
    if (recent) return recent;
    const imported = b.createdAt - a.createdAt;
    if (imported) return imported;
    const preference = normalize(ctx.merchantPreference);
    const merchantA = normalize(a.merchantName);
    const merchantB = normalize(b.merchantName);
    const merchantScoreA = preference && (merchantA.includes(preference) || preference.includes(merchantA)) ? 1 : 0;
    const merchantScoreB = preference && (merchantB.includes(preference) || preference.includes(merchantB)) ? 1 : 0;
    if (merchantScoreA !== merchantScoreB) return merchantScoreB - merchantScoreA;
    return nameScore(b, desired) - nameScore(a, desired) || a.id.localeCompare(b.id);
}

export interface CatalogMatchResult {
    items: FoodOrderItemSnapshot[];
    merchantName?: string;
}

export function matchFoodIntentToCatalog(
    intent: FoodOrderIntent,
    catalog: FoodCatalogItem[],
    orders: FoodOrderRecord[],
): CatalogMatchResult | null {
    const recentByCatalogId = new Map<string, number>();
    for (const order of orders) {
        for (const item of order.items) {
            if (item.catalogItemId) {
                recentByCatalogId.set(item.catalogItemId, Math.max(recentByCatalogId.get(item.catalogItemId) || 0, order.createdAt));
            }
        }
    }
    const imported = catalog.filter(item => item.source !== 'simulated');
    const used = new Set<string>();
    let merchantKey: string | undefined;
    const snapshots: FoodOrderItemSnapshot[] = [];
    for (const desired of intent.items) {
        const candidates = imported.filter(item => {
            if (used.has(item.id) || nameScore(item, desired.name) <= 0) return false;
            return merchantKey === undefined || normalize(item.merchantName) === merchantKey;
        }).sort((a, b) => compareCandidates(a, b, desired.name, { recentByCatalogId, merchantPreference: intent.merchantPreference }));
        const selected = candidates[0];
        if (!selected) return null;
        used.add(selected.id);
        merchantKey = normalize(selected.merchantName);
        snapshots.push({
            catalogItemId: selected.id,
            name: selected.name,
            merchantName: selected.merchantName,
            quantity: desired.quantity,
            unitPrice: selected.price,
            description: selected.description,
            note: desired.note,
            imageRef: selected.imageRef,
            originalUrl: selected.originalUrl,
        });
    }
    return { items: snapshots, merchantName: snapshots[0]?.merchantName };
}

function simulatedSnapshots(intent: FoodOrderIntent): CatalogMatchResult | null {
    const fallback = intent.simulatedFallback;
    if (!fallback) return null;
    const used = new Set<number>();
    const items = intent.items.map((desired, desiredIndex) => {
        let index = fallback.items.findIndex((candidate, i) => !used.has(i) && (
            normalize(candidate.name) === normalize(desired.name)
            || normalize(candidate.name).includes(normalize(desired.name))
            || normalize(desired.name).includes(normalize(candidate.name))
        ));
        if (index < 0 && desiredIndex < fallback.items.length && !used.has(desiredIndex)) index = desiredIndex;
        if (index < 0) return null;
        used.add(index);
        const candidate = fallback.items[index];
        return {
            name: candidate.name,
            merchantName: fallback.merchantName,
            quantity: desired.quantity,
            unitPrice: candidate.price,
            description: candidate.description,
            note: desired.note,
        } satisfies FoodOrderItemSnapshot;
    });
    if (items.some(item => item === null)) return null;
    return { items: items as FoodOrderItemSnapshot[], merchantName: fallback.merchantName };
}

function totals(items: FoodOrderItemSnapshot[], deliveryFee: number): { subtotal?: number; total?: number } {
    const known = items.reduce((sum, item) => sum + (item.unitPrice === undefined ? 0 : item.unitPrice * item.quantity), 0);
    const rounded = Math.round(known * 100) / 100;
    if (items.some(item => item.unitPrice === undefined)) return { subtotal: rounded };
    return { subtotal: rounded, total: Math.round((rounded + deliveryFee) * 100) / 100 };
}

function claimAction(eventKey: string, now: number): boolean {
    for (const [key, at] of actionClaims) if (now - at > ACTION_CLAIM_TTL_MS) actionClaims.delete(key);
    if (actionClaims.has(eventKey)) return false;
    actionClaims.set(eventKey, now);
    return true;
}

async function waitForOrder(eventKey: string): Promise<FoodOrderRecord | null> {
    const deadline = Date.now() + 5_000;
    for (;;) {
        const record = await getFoodOrderByEventKey(eventKey);
        if (record || Date.now() >= deadline) return record;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
}

export function resetFoodOrderActionClaimsForTests(): void {
    actionClaims.clear();
}

export type CharacterFoodOrderSkipReason = 'already_exists' | 'cooldown' | 'no_match_or_fallback' | 'in_progress';
export interface CharacterFoodOrderResult {
    order?: FoodOrderRecord;
    created: boolean;
    skipped?: CharacterFoodOrderSkipReason;
    matchSource?: 'catalog' | 'simulated';
}

export async function executeCharacterFoodOrder(opts: {
    intent: FoodOrderIntent;
    char: CharacterProfile;
    userName?: string;
    triggerMessageId?: string | number;
    explicitFoodRequest?: boolean;
    now?: number;
}): Promise<CharacterFoodOrderResult> {
    const now = opts.now ?? Date.now();
    const eventKey = foodOrderActionEventKey(opts.char.id, opts.intent, opts.triggerMessageId, now);
    const existing = await getFoodOrderByEventKey(eventKey);
    if (existing) {
        await projectFoodOrderToChat(existing);
        return { order: existing, created: false, skipped: 'already_exists', matchSource: existing.source === 'simulated' ? 'simulated' : 'catalog' };
    }
    if (!claimAction(eventKey, now)) {
        const winner = await waitForOrder(eventKey);
        return winner
            ? { order: winner, created: false, skipped: 'already_exists', matchSource: winner.source === 'simulated' ? 'simulated' : 'catalog' }
            : { created: false, skipped: 'in_progress' };
    }
    try {
        if (!opts.explicitFoodRequest && await hasRecentAutonomousFoodOrder(opts.char.id, now)) {
            return { created: false, skipped: 'cooldown' };
        }
        const catalog = await listFoodCatalogItems();
        const history = await listFoodOrdersByChar(opts.char.id);
        const catalogMatch = matchFoodIntentToCatalog(opts.intent, catalog, history);
        const match = catalogMatch || simulatedSnapshots(opts.intent);
        if (!match) return { created: false, skipped: 'no_match_or_fallback' };
        const source = catalogMatch ? 'catalog_imported' : 'simulated';
        const fallbackFee = opts.intent.simulatedFallback?.deliveryFee;
        const deliveryFee = source === 'simulated' && fallbackFee !== undefined ? fallbackFee : FOOD_DELIVERY_FEE;
        const amounts = totals(match.items, deliveryFee);
        const recipient = opts.intent.recipient === 'character'
            ? { type: 'character' as const, id: opts.char.id, nameSnapshot: opts.char.name }
            : { type: 'user' as const, id: 'user', nameSnapshot: opts.userName || '你' };
        const created = await createFoodOrder({
            eventKey,
            source,
            orderer: { type: 'character', id: opts.char.id, nameSnapshot: opts.char.name },
            recipient,
            charId: opts.char.id,
            merchantName: match.merchantName,
            items: match.items,
            ...amounts,
            deliveryFee,
            status: 'confirmed',
            timeline: createFoodOrderTimeline(now, Math.random, source === 'simulated' ? opts.intent.simulatedFallback?.etaMinutes : undefined),
        });
        await projectFoodOrderToChat(created.record);
        return { order: created.record, created: created.created, matchSource: catalogMatch ? 'catalog' : 'simulated' };
    } finally {
        actionClaims.delete(eventKey);
    }
}
