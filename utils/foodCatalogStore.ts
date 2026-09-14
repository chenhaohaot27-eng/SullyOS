import { openDB } from './db';
import {
    buildFoodCatalogFingerprint,
    normalizeFoodUrl,
    type FoodCatalogItem,
} from './foodTypes';

const STORE_NAME = 'food_catalog';
const SCHEMA_VERSION = 1;

let seq = 0;
const genId = (): string =>
    `food_${Date.now().toString(36)}_${(seq++).toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

const isConstraintError = (error: unknown): boolean =>
    !!(error && typeof error === 'object' && (error as { name?: unknown }).name === 'ConstraintError');

const requireText = (label: string, value: unknown): string => {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`FoodCatalogItem ${label} is required`);
    return value.trim();
};

const waitForTx = (tx: IDBTransaction): Promise<void> => new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('food_catalog transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('food_catalog transaction aborted'));
});

async function addRecord(record: FoodCatalogItem): Promise<void> {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const request = tx.objectStore(STORE_NAME).add(record);
        let settled = false;
        request.onerror = () => { settled = true; reject(request.error || tx.error); };
        tx.oncomplete = () => { if (!settled) resolve(); };
        tx.onabort = () => { if (!settled) reject(tx.error || request.error); };
    });
}

async function putRecord(record: FoodCatalogItem): Promise<void> {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(record);
    await waitForTx(tx);
}

export type CreateFoodCatalogItemInput = Omit<FoodCatalogItem,
    'id' | 'schemaVersion' | 'createdAt' | 'updatedAt' | 'currency' | 'fingerprint'
> & { fingerprint?: string; currency?: 'CNY' };

export interface CreateFoodCatalogItemResult {
    record: FoodCatalogItem;
    created: boolean;
}

export async function createFoodCatalogItem(input: CreateFoodCatalogItemInput): Promise<CreateFoodCatalogItemResult> {
    const name = requireText('name', input.name);
    if (input.price !== undefined && (!Number.isFinite(input.price) || input.price < 0)) {
        throw new Error('FoodCatalogItem price must be a non-negative number');
    }
    const originalUrl = normalizeFoodUrl(input.originalUrl);
    const fingerprint = input.fingerprint?.trim() || buildFoodCatalogFingerprint({
        platform: input.platform,
        merchantName: input.merchantName,
        name,
        originalUrl,
    });
    requireText('fingerprint', fingerprint);
    const existing = await getFoodCatalogItemByFingerprint(fingerprint);
    if (existing) return { record: existing, created: false };

    const now = Date.now();
    const record: FoodCatalogItem = {
        ...input,
        id: genId(),
        schemaVersion: SCHEMA_VERSION,
        fingerprint,
        name,
        currency: 'CNY',
        ...(originalUrl ? { originalUrl } : { originalUrl: undefined }),
        createdAt: now,
        updatedAt: now,
    };
    try {
        await addRecord(record);
        return { record, created: true };
    } catch (error) {
        if (isConstraintError(error)) {
            const winner = await getFoodCatalogItemByFingerprint(fingerprint);
            if (winner) return { record: winner, created: false };
        }
        throw error;
    }
}

export async function getFoodCatalogItem(id: string): Promise<FoodCatalogItem | null> {
    requireText('id', id);
    const db = await openDB();
    if (!db.objectStoreNames.contains(STORE_NAME)) return null;
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const request = tx.objectStore(STORE_NAME).get(id);
        request.onsuccess = () => resolve((request.result as FoodCatalogItem) || null);
        request.onerror = () => reject(request.error || tx.error);
    });
}

export async function getFoodCatalogItemByFingerprint(fingerprint: string): Promise<FoodCatalogItem | null> {
    requireText('fingerprint', fingerprint);
    const db = await openDB();
    if (!db.objectStoreNames.contains(STORE_NAME)) return null;
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        if (!store.indexNames.contains('fingerprint')) return resolve(null);
        const request = store.index('fingerprint').get(fingerprint);
        request.onsuccess = () => resolve((request.result as FoodCatalogItem) || null);
        request.onerror = () => reject(request.error || tx.error);
    });
}

export type UpdateFoodCatalogItemPatch = Partial<Omit<FoodCatalogItem, 'schemaVersion'>>;

export async function updateFoodCatalogItem(
    id: string,
    patch: UpdateFoodCatalogItemPatch,
): Promise<FoodCatalogItem | null> {
    requireText('id', id);
    const existing = await getFoodCatalogItem(id);
    if (!existing) return null;
    const {
        id: _id, fingerprint: _fingerprint, schemaVersion: _schemaVersion,
        createdAt: _createdAt, updatedAt: _updatedAt, ...safePatch
    } = patch as Partial<FoodCatalogItem>;
    if (safePatch.name !== undefined) safePatch.name = requireText('name', safePatch.name);
    if (safePatch.price !== undefined && (!Number.isFinite(safePatch.price) || safePatch.price < 0)) {
        throw new Error('FoodCatalogItem price must be a non-negative number');
    }
    if (safePatch.originalUrl !== undefined) safePatch.originalUrl = normalizeFoodUrl(safePatch.originalUrl);
    const updated: FoodCatalogItem = {
        ...existing,
        ...safePatch,
        id: existing.id,
        fingerprint: existing.fingerprint,
        schemaVersion: existing.schemaVersion,
        createdAt: existing.createdAt,
        updatedAt: Date.now(),
    };
    await putRecord(updated);
    return updated;
}

export async function listFoodCatalogItems(): Promise<FoodCatalogItem[]> {
    const db = await openDB();
    if (!db.objectStoreNames.contains(STORE_NAME)) return [];
    const records = await new Promise<FoodCatalogItem[]>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const request = tx.objectStore(STORE_NAME).getAll();
        request.onsuccess = () => resolve((request.result as FoodCatalogItem[]) || []);
        request.onerror = () => reject(request.error || tx.error);
    });
    return records.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}

export async function toggleFoodFavorite(id: string): Promise<FoodCatalogItem | null> {
    const existing = await getFoodCatalogItem(id);
    if (!existing) return null;
    return updateFoodCatalogItem(id, { favorite: !existing.favorite });
}
