/**
 * giftStore — GiftRecord 的唯一数据访问层（Phase 1）。
 *
 * 职责边界：只做 gift_records store 的 CRUD / 查询 / 持久幂等。
 * 不掺聊天、AI、Prompt、vision、生图、Blob 生命周期（后续 Phase 接入）。
 *
 * 幂等语义（本模块最重要的契约）：
 *  - 同一个 eventKey 的逻辑礼物副作用，无论重放多少次（StrictMode / 流式重放 /
 *    post-processing 重跑 / 刷新 / 并发），DB 中永远只有一条 GiftRecord。
 *  - 实现：先按 eventKey 快速查询（挡住绝大多数正常重复）；真正写入用 add() +
 *    eventKey UNIQUE index 兜底——并发漏过快查时 ConstraintError 被捕获，
 *    回读现有记录返回 created:false，重复执行不是 fatal error。
 */

import { openDB } from './db';
import type {
    GiftImageData,
    GiftRecord,
} from './giftTypes';

const STORE_NAME = 'gift_records';
const SCHEMA_VERSION = 1;

// ─── 内部工具 ────────────────────────────────────────────────────────────────

let seq = 0;
const genId = (): string =>
    `gift_${Date.now().toString(36)}_${(seq++).toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

const isConstraintError = (e: unknown): boolean =>
    !!(e && typeof e === 'object' && (e as { name?: unknown }).name === 'ConstraintError');

const waitForTx = (tx: IDBTransaction): Promise<void> => new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('gift_records transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('gift_records transaction aborted'));
});

const requireNonEmpty = (label: string, value: unknown): string => {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`GiftRecord ${label} is required`);
    }
    return value;
};

const requireNumber = (label: string, value: unknown): number => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`GiftRecord ${label} must be a valid number`);
    }
    return value;
};

/** add()（非 put()）：让 eventKey/id 的唯一约束在 DB 层真正生效。 */
async function addRecord(record: GiftRecord): Promise<void> {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const req = tx.objectStore(STORE_NAME).add(record);
        let settled = false;
        // 请求级错误（如 ConstraintError）：事务随后 abort，双通道只 settle 一次。
        req.onerror = () => {
            settled = true;
            reject(req.error || tx.error || new Error('gift_records add failed'));
        };
        tx.oncomplete = () => { if (!settled) resolve(); };
        tx.onabort = () => {
            if (!settled) reject(tx.error || req.error || new Error('gift_records add aborted'));
        };
    });
}

async function putRecord(record: GiftRecord): Promise<void> {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(record);
    await waitForTx(tx);
}

async function getRecord(id: string): Promise<GiftRecord | null> {
    const db = await openDB();
    if (!db.objectStoreNames.contains(STORE_NAME)) return null;
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(id);
        req.onsuccess = () => resolve((req.result as GiftRecord) || null);
        req.onerror = () => reject(req.error || tx.error);
    });
}

// ─── 公开 API ────────────────────────────────────────────────────────────────

/** createGiftRecord 入参：id/时间戳/schemaVersion 由 Store 决定，其余按需给全。 */
export type CreateGiftRecordInput = Omit<GiftRecord,
    'id' | 'schemaVersion' | 'createdAt' | 'updatedAt' | 'image'
> & { image?: GiftImageData };

export interface CreateGiftRecordResult {
    record: GiftRecord;
    /** false = eventKey 已存在，返回的是既有记录（幂等命中，非错误）。 */
    created: boolean;
}

/**
 * 幂等创建。同 eventKey 重复调用（顺序或并发）最终只落一条：
 * 第一次 → { record, created: true }；已存在 → { record: existing, created: false }。
 */
export async function createGiftRecord(input: CreateGiftRecordInput): Promise<CreateGiftRecordResult> {
    requireNonEmpty('eventKey', input.eventKey);
    requireNonEmpty('charId', input.charId);
    requireNonEmpty('gift.name', input.gift?.name);
    if (!input.sender || typeof input.sender !== 'object') throw new Error('GiftRecord sender is required');
    requireNonEmpty('sender.id', input.sender.id);
    requireNonEmpty('sender.nameSnapshot', input.sender.nameSnapshot);
    if (!input.recipient || typeof input.recipient !== 'object') throw new Error('GiftRecord recipient is required');
    requireNonEmpty('recipient.id', input.recipient.id);
    requireNonEmpty('recipient.nameSnapshot', input.recipient.nameSnapshot);

    // 快路径：绝大多数重复（post-processing 重跑 / 重放）在这里直接短路。
    const existing = await getGiftRecordByEventKey(input.eventKey);
    if (existing) return { record: existing, created: false };

    const now = Date.now();
    const record: GiftRecord = {
        ...input,
        id: genId(),
        schemaVersion: SCHEMA_VERSION,
        image: input.image || { origin: 'none', status: 'none' },
        status: input.status || 'pending',
        createdAt: now,
        updatedAt: now,
    };
    requireNumber('createdAt', record.createdAt);
    requireNumber('updatedAt', record.updatedAt);

    try {
        await addRecord(record);
        return { record, created: true };
    } catch (e) {
        // 并发兜底：快查漏过、两路同时 add，后到的一条撞 eventKey 唯一索引。
        // 回读现有记录返回 created:false —— 重复执行不是 fatal error。
        if (isConstraintError(e)) {
            const winner = await getGiftRecordByEventKey(input.eventKey);
            if (winner) return { record: winner, created: false };
        }
        throw e;
    }
}

export async function getGiftRecord(id: string): Promise<GiftRecord | null> {
    requireNonEmpty('id', id);
    return getRecord(id);
}

export async function getGiftRecordByEventKey(eventKey: string): Promise<GiftRecord | null> {
    requireNonEmpty('eventKey', eventKey);
    const db = await openDB();
    if (!db.objectStoreNames.contains(STORE_NAME)) return null;
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        if (!store.indexNames.contains('eventKey')) return resolve(null);
        const req = store.index('eventKey').get(eventKey);
        req.onsuccess = () => resolve((req.result as GiftRecord) || null);
        req.onerror = () => reject(req.error || tx.error);
    });
}

export type UpdateGiftRecordPatch = Partial<Omit<GiftRecord, 'schemaVersion'>>;

/**
 * 安全 patch 更新：id / eventKey / createdAt / schemaVersion 不可变，updatedAt 自动刷新。
 * 记录不存在时返回 null（绝不静默创建新记录）。
 */
export async function updateGiftRecord(
    id: string,
    patch: UpdateGiftRecordPatch,
): Promise<GiftRecord | null> {
    requireNonEmpty('id', id);
    if (!patch || typeof patch !== 'object') throw new Error('GiftRecord patch must be an object');
    const existing = await getRecord(id);
    if (!existing) return null;

    const {
        id: _id,
        eventKey: _eventKey,
        createdAt: _createdAt,
        schemaVersion: _schemaVersion,
        updatedAt: _updatedAt,
        ...safePatch
    } = patch as Partial<GiftRecord>;

    const updated: GiftRecord = {
        ...existing,
        ...safePatch,
        id: existing.id,
        eventKey: existing.eventKey,
        createdAt: existing.createdAt,
        schemaVersion: existing.schemaVersion,
        updatedAt: Date.now(),
    };
    await putRecord(updated);
    return updated;
}

export interface ListGiftRecordsOptions {
    charId?: string;
}

/** 列表查询，createdAt DESC（同毫秒按 id 稳定排序）。「收到/送出」由 UI 按 sender/recipient.type 本地过滤。 */
export async function listGiftRecords(options?: ListGiftRecordsOptions): Promise<GiftRecord[]> {
    const charId = options?.charId?.trim();
    const db = await openDB();
    if (!db.objectStoreNames.contains(STORE_NAME)) return [];
    const records = await new Promise<GiftRecord[]>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = (charId && store.indexNames.contains('charId'))
            ? store.index('charId').getAll(charId)
            : store.getAll();
        req.onsuccess = () => resolve((req.result as GiftRecord[]) || []);
        req.onerror = () => reject(req.error || tx.error);
    });
    return records.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** listGiftRecords({ charId }) 的便捷别名。 */
export async function listGiftRecordsByChar(charId: string): Promise<GiftRecord[]> {
    requireNonEmpty('charId', charId);
    return listGiftRecords({ charId });
}

/**
 * 只删 GiftRecord 本身。绝不触碰 blob_assets —— 聊天礼物卡 / 其他记录可能仍引用同一 Blob
 * （blobRef 的安全策略是「宁留孤儿、不破图」）。返回是否真的删除了。
 */
export async function deleteGiftRecord(id: string): Promise<boolean> {
    requireNonEmpty('id', id);
    const existing = await getRecord(id);
    if (!existing) return false;
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    await waitForTx(tx);
    return true;
}
