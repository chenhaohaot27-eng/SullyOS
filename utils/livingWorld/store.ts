import type { LivingWorldAgentState, LivingWorldEvent, LivingWorldState } from '../../types';
import { openDB } from '../db';

const STORE_NAME = 'living_world';
const SCHEMA_VERSION = 1;

type LivingWorldStateRecord = LivingWorldState & {
    id: string;
    kind: 'state';
};

type LivingWorldEventRecord = LivingWorldEvent & {
    kind: 'event';
};

type LivingWorldRecord = LivingWorldStateRecord | LivingWorldEventRecord;

const stateId = (worldId: string) => `state:${worldId}`;
const eventId = (worldId: string, timestamp: number, suffix: string) => `event:${worldId}:${timestamp}:${suffix}`;
const genSuffix = () => Math.random().toString(36).slice(2, 10);

const requireWorldId = (worldId: string) => {
    if (!worldId || !worldId.trim()) throw new Error('Living World worldId is required');
};

const requireCharId = (charId: string) => {
    if (!charId || !charId.trim()) throw new Error('Living World charId is required');
};

const toState = (record: LivingWorldStateRecord): LivingWorldState => {
    const { id: _id, kind: _kind, ...state } = record;
    return state;
};

const waitForTx = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Living World transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('Living World transaction aborted'));
});

async function getRecord<T extends LivingWorldRecord>(id: string): Promise<T | null> {
    const db = await openDB();
    if (!db.objectStoreNames.contains(STORE_NAME)) return null;
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(id);
        req.onsuccess = () => resolve((req.result as T) || null);
        req.onerror = () => reject(req.error || tx.error);
    });
}

async function putRecord(record: LivingWorldRecord): Promise<void> {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(record);
    await waitForTx(tx);
}

export async function getLivingWorldState(worldId: string): Promise<LivingWorldState | null> {
    requireWorldId(worldId);
    const record = await getRecord<LivingWorldStateRecord>(stateId(worldId));
    if (!record || record.kind !== 'state') return null;
    return toState(record);
}

export async function ensureLivingWorldState(worldId: string): Promise<LivingWorldState> {
    requireWorldId(worldId);
    const existing = await getLivingWorldState(worldId);
    if (existing) return existing;

    const now = Date.now();
    const state: LivingWorldState = {
        schemaVersion: SCHEMA_VERSION,
        worldId,
        createdAt: now,
        updatedAt: now,
        agents: [],
    };
    await saveLivingWorldState(state);
    return state;
}

export async function saveLivingWorldState(state: LivingWorldState): Promise<void> {
    requireWorldId(state.worldId);
    await putRecord({
        ...state,
        schemaVersion: state.schemaVersion || SCHEMA_VERSION,
        updatedAt: state.updatedAt || Date.now(),
        agents: state.agents || [],
        id: stateId(state.worldId),
        kind: 'state',
    });
}

export async function getAgentState(worldId: string, charId: string): Promise<LivingWorldAgentState | null> {
    requireWorldId(worldId);
    requireCharId(charId);
    const state = await getLivingWorldState(worldId);
    return state?.agents.find(agent => agent.charId === charId) || null;
}

export async function saveAgentState(agent: LivingWorldAgentState): Promise<void> {
    requireWorldId(agent.worldId);
    requireCharId(agent.charId);
    const state = await ensureLivingWorldState(agent.worldId);
    const nextAgent: LivingWorldAgentState = {
        ...agent,
        updatedAt: agent.updatedAt || Date.now(),
    };
    const agents = state.agents.filter(existing => existing.charId !== agent.charId);
    agents.push(nextAgent);
    await saveLivingWorldState({
        ...state,
        agents,
        updatedAt: Date.now(),
    });
}

export async function appendWorldEvent(
    event: Omit<LivingWorldEvent, 'id' | 'timestamp'> & Partial<Pick<LivingWorldEvent, 'id' | 'timestamp'>>,
): Promise<LivingWorldEvent> {
    requireWorldId(event.worldId);
    if (!event.type || !event.type.trim()) throw new Error('Living World event type is required');
    if (!event.summary || !event.summary.trim()) throw new Error('Living World event summary is required');

    const timestamp = event.timestamp || Date.now();
    const id = event.id || eventId(event.worldId, timestamp, genSuffix());
    const record: LivingWorldEventRecord = {
        ...event,
        id,
        timestamp,
        actorIds: event.actorIds || [],
        source: event.source || 'manual',
        kind: 'event',
    };
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).add(record);
    await waitForTx(tx);
    return {
        id: record.id,
        worldId: record.worldId,
        timestamp: record.timestamp,
        type: record.type,
        actorIds: record.actorIds,
        targetIds: record.targetIds,
        source: record.source,
        importance: record.importance,
        summary: record.summary,
        refs: record.refs,
    };
}

export async function listWorldEvents(worldId: string, limit?: number): Promise<LivingWorldEvent[]> {
    requireWorldId(worldId);
    const db = await openDB();
    if (!db.objectStoreNames.contains(STORE_NAME)) return [];
    const records = await new Promise<LivingWorldRecord[]>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.indexNames.contains('worldId_kind')
            ? store.index('worldId_kind').getAll(IDBKeyRange.only([worldId, 'event']))
            : store.getAll();
        req.onsuccess = () => resolve((req.result as LivingWorldRecord[]) || []);
        req.onerror = () => reject(req.error || tx.error);
    });
    const events = records
        .filter((record): record is LivingWorldEventRecord => record.kind === 'event' && record.worldId === worldId)
        .sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id))
        .map(({ kind: _kind, ...event }) => event);
    return typeof limit === 'number' && limit >= 0 ? events.slice(-limit) : events;
}
