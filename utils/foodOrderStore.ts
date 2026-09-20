import { openDB } from './db';
import type { FoodOrderChatState, FoodOrderRecord } from './foodOrderTypes';

const STORE_NAME = 'food_orders';
const SCHEMA_VERSION = 1;
let seq = 0;
const genId = (): string => `food_order_${Date.now().toString(36)}_${(seq++).toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const constraint = (error: unknown): boolean => !!(error && typeof error === 'object' && (error as { name?: unknown }).name === 'ConstraintError');
const required = (label: string, value: unknown): string => {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`FoodOrderRecord ${label} is required`);
    return value.trim();
};
const waitTx = (tx: IDBTransaction): Promise<void> => new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('food_orders transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('food_orders transaction aborted'));
});

export type CreateFoodOrderInput = Omit<FoodOrderRecord,
    'id' | 'schemaVersion' | 'createdAt' | 'updatedAt' | 'currency'
> & { currency?: 'CNY' };

export interface CreateFoodOrderResult { record: FoodOrderRecord; created: boolean; }

export const FOOD_ORDERS_STORE = STORE_NAME;
export const genFoodOrderId = genId;

/** 校验 + 构造 FoodOrderRecord（不落库）。foodWallet 的原子下单在同一事务里复用它。 */
export function buildFoodOrderRecord(input: CreateFoodOrderInput): FoodOrderRecord {
    const eventKey = required('eventKey', input.eventKey);
    required('charId', input.charId);
    required('orderer.id', input.orderer?.id);
    required('recipient.id', input.recipient?.id);
    if (!Array.isArray(input.items) || input.items.length === 0) throw new Error('FoodOrderRecord items are required');
    input.items.forEach((item, index) => {
        required(`items[${index}].name`, item.name);
        if (!Number.isInteger(item.quantity) || item.quantity <= 0) throw new Error('FoodOrderRecord quantity must be a positive integer');
    });
    const now = Date.now();
    return {
        ...input,
        id: genId(),
        eventKey,
        schemaVersion: SCHEMA_VERSION,
        currency: 'CNY',
        items: input.items.map(item => ({ ...item })),
        createdAt: now,
        updatedAt: now,
    };
}

export async function createFoodOrder(input: CreateFoodOrderInput): Promise<CreateFoodOrderResult> {
    const eventKey = required('eventKey', input.eventKey);
    const existing = await getFoodOrderByEventKey(eventKey);
    if (existing) return { record: existing, created: false };
    const record = buildFoodOrderRecord(input);
    try {
        const db = await openDB();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const req = tx.objectStore(STORE_NAME).add(record);
            let settled = false;
            req.onerror = () => { settled = true; reject(req.error || tx.error); };
            tx.oncomplete = () => { if (!settled) resolve(); };
            tx.onabort = () => { if (!settled) reject(tx.error || req.error); };
        });
        return { record, created: true };
    } catch (error) {
        if (constraint(error)) {
            const winner = await getFoodOrderByEventKey(eventKey);
            if (winner) return { record: winner, created: false };
        }
        throw error;
    }
}

export async function getFoodOrder(id: string): Promise<FoodOrderRecord | null> {
    required('id', id);
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(id);
        req.onsuccess = () => resolve((req.result as FoodOrderRecord) || null);
        req.onerror = () => reject(req.error || tx.error);
    });
}

export async function getFoodOrderByEventKey(eventKey: string): Promise<FoodOrderRecord | null> {
    required('eventKey', eventKey);
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).index('eventKey').get(eventKey);
        req.onsuccess = () => resolve((req.result as FoodOrderRecord) || null);
        req.onerror = () => reject(req.error || tx.error);
    });
}

export type UpdateFoodOrderPatch = Partial<Omit<FoodOrderRecord, 'schemaVersion'>>;
export async function updateFoodOrder(id: string, patch: UpdateFoodOrderPatch): Promise<FoodOrderRecord | null> {
    required('id', id);
    const existing = await getFoodOrder(id);
    if (!existing) return null;
    const { id: _id, eventKey: _eventKey, schemaVersion: _schema, createdAt: _created, updatedAt: _updated, ...safe } = patch as Partial<FoodOrderRecord>;
    const updated: FoodOrderRecord = {
        ...existing, ...safe,
        id: existing.id, eventKey: existing.eventKey, schemaVersion: existing.schemaVersion,
        createdAt: existing.createdAt, updatedAt: Date.now(),
    };
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(updated);
    await waitTx(tx);
    return updated;
}

export async function listFoodOrders(): Promise<FoodOrderRecord[]> {
    const db = await openDB();
    const records = await new Promise<FoodOrderRecord[]>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).getAll();
        req.onsuccess = () => resolve((req.result as FoodOrderRecord[]) || []);
        req.onerror = () => reject(req.error || tx.error);
    });
    return records.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}

export async function listFoodOrdersByChar(charId: string): Promise<FoodOrderRecord[]> {
    required('charId', charId);
    const db = await openDB();
    const records = await new Promise<FoodOrderRecord[]>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).index('charId').getAll(charId);
        req.onsuccess = () => resolve((req.result as FoodOrderRecord[]) || []);
        req.onerror = () => reject(req.error || tx.error);
    });
    return records.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}

/** 事务内 first-attempt-wins，确保每个阶段最多发起一次自动 Chat 请求。 */
export async function claimFoodOrderReaction(orderId: string, phase: 'ordered' | 'delivered', now = Date.now()): Promise<boolean> {
    required('id', orderId);
    const field: keyof FoodOrderChatState = phase === 'ordered' ? 'orderReactionAttemptedAt' : 'deliveryReactionAttemptedAt';
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const req = store.get(orderId);
        let claimed = false;
        req.onsuccess = () => {
            const record = req.result as FoodOrderRecord | undefined;
            if (!record || record.chat?.[field]) return;
            claimed = true;
            store.put({ ...record, chat: { ...(record.chat || {}), [field]: now }, updatedAt: now });
        };
        tx.oncomplete = () => resolve(claimed);
        tx.onerror = () => reject(tx.error || req.error);
        tx.onabort = () => reject(tx.error || req.error);
    });
}

/** delivery event 插入权的短租约；并发只放行一个，崩溃超过 60 秒可由重开恢复。 */
export async function claimFoodDeliveryEvent(orderId: string, now = Date.now()): Promise<boolean> {
    required('id', orderId);
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const req = store.get(orderId);
        let claimed = false;
        req.onsuccess = () => {
            const record = req.result as FoodOrderRecord | undefined;
            if (!record || record.chat?.deliveryEventMessageId) return;
            const previous = record.chat?.deliveryEventClaimedAt || 0;
            if (previous && now - previous < 60_000) return;
            claimed = true;
            store.put({ ...record, chat: { ...(record.chat || {}), deliveryEventClaimedAt: now }, updatedAt: now });
        };
        tx.oncomplete = () => resolve(claimed);
        tx.onerror = () => reject(tx.error || req.error);
        tx.onabort = () => reject(tx.error || req.error);
    });
}
