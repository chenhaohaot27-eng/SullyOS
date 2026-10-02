import type { CharacterProfile } from '../types';
import { DB, openDB } from './db';

const MIGRATION_KEY = 'privateNpcLeakCleanupV1';
const MIGRATION_DONE = 'completed';

// One-way SHA-256 fingerprints. The public build contains neither private IDs nor profile text.
const LEAKED_ID_HASHES = new Set([
    '2482506a2b192f95809535676b60715e996a7336a33d3c31f7dbcfb77ca6c643',
    'f885c9d2b4895958463950d369ce68f7dd41cf297f6ed06b148774794a421578',
    'ffe7719aa276df471cacc6c67637f0729f266ce4c629b373c64dcd2a9e1744ac',
    '30002903da49de233419c829f41ee528533ddbd6632965134da8212aea9eae6e',
]);

const LEAKED_PROFILE_HASHES = new Set([
    '4a1149f0dcf372d5afa7c0b04d1d4d0c77c74d72efad86c47534e2f51ecaf214',
    'bd139a4f3eec56b09f940a04b428ccd6f89a5e71a341eaf2901c5a7ae4a2f127',
    'f43670ea0cf7b92df72f2a139c70d311560ea278558eadf8043fbb9fc9e95030',
    'f1c7abc4af75cf8938ef7397724ce02c30dfc4474bf815ce9b9743b170386453',
]);

const sha256 = async (value: string): Promise<string> => {
    if (!globalThis.crypto?.subtle) throw new Error('Web Crypto is unavailable');
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
};

const stableValue = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;
    return Object.keys(value as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((result, key) => {
            const child = (value as Record<string, unknown>)[key];
            if (child !== undefined) result[key] = stableValue(child);
            return result;
        }, {});
};

const stripKnownAutomaticDefaults = (character: CharacterProfile): Record<string, unknown> => {
    const candidate = { ...character } as Record<string, unknown>;
    const emotion = candidate.emotionConfig;
    if (emotion && typeof emotion === 'object') {
        const entries = Object.entries(emotion as Record<string, unknown>);
        if (entries.length === 1 && entries[0][0] === 'enabled' && entries[0][1] === true) {
            delete candidate.emotionConfig;
        }
    }
    if (candidate.contextRangePolicyVersion === 1) delete candidate.contextRangePolicyVersion;
    if (candidate.contextRangeMode === 'manual') delete candidate.contextRangeMode;
    if (candidate.contextLimit === 500) delete candidate.contextLimit;
    if (candidate.contextUserStartMessageId === undefined) delete candidate.contextUserStartMessageId;
    return candidate;
};

export const isCanonicalLeakedId = async (id: string): Promise<boolean> => LEAKED_ID_HASHES.has(await sha256(id));

export const isUntouchedLeakedSeed = async (character: CharacterProfile): Promise<boolean> => {
    const serialized = JSON.stringify(stableValue(stripKnownAutomaticDefaults(character)));
    return LEAKED_PROFILE_HASHES.has(await sha256(serialized));
};

export const findCandidateIdsInValue = (value: unknown, ids: readonly string[], seen = new WeakSet<object>()): Set<string> => {
    const matches = new Set<string>();
    if (typeof value === 'string') {
        for (const id of ids) if (value.includes(id)) matches.add(id);
        return matches;
    }
    if (!value || typeof value !== 'object') return matches;
    if (seen.has(value)) return matches;
    seen.add(value);
    if ((typeof Blob !== 'undefined' && value instanceof Blob) || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return matches;
    if (value instanceof Map) {
        for (const [key, child] of value.entries()) {
            for (const id of findCandidateIdsInValue(key, ids, seen)) matches.add(id);
            for (const id of findCandidateIdsInValue(child, ids, seen)) matches.add(id);
        }
        return matches;
    }
    if (value instanceof Set) {
        for (const child of value.values()) {
            for (const id of findCandidateIdsInValue(child, ids, seen)) matches.add(id);
        }
        return matches;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        for (const id of ids) if (key.includes(id)) matches.add(id);
        for (const id of findCandidateIdsInValue(child, ids, seen)) matches.add(id);
    }
    return matches;
};

const scanDatabase = async (
    db: IDBDatabase,
    candidateIds: readonly string[],
    skipOwnCharacterRecord: boolean,
): Promise<Set<string>> => {
    const referenced = new Set<string>();
    for (const storeName of Array.from(db.objectStoreNames)) {
        await new Promise<void>((resolve, reject) => {
            let transaction: IDBTransaction;
            try {
                transaction = db.transaction(storeName, 'readonly');
            } catch (error) {
                reject(error);
                return;
            }
            const request = transaction.objectStore(storeName).openCursor();
            request.onerror = () => reject(request.error || new Error(`Failed to scan ${storeName}`));
            transaction.onerror = () => reject(transaction.error || new Error(`Failed to scan ${storeName}`));
            transaction.onabort = () => reject(transaction.error || new Error(`Scan aborted for ${storeName}`));
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) {
                    resolve();
                    return;
                }
                for (const id of candidateIds) {
                    const isOwnRecord = skipOwnCharacterRecord
                        && storeName === 'characters'
                        && cursor.primaryKey === id;
                    if (isOwnRecord) continue;
                    if (findCandidateIdsInValue(cursor.primaryKey, [id]).has(id)
                        || findCandidateIdsInValue(cursor.value, [id]).has(id)) {
                        referenced.add(id);
                    }
                }
                cursor.continue();
            };
        });
    }
    return referenced;
};

const openExistingDatabase = (name: string): Promise<IDBDatabase> => new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    let createdByRace = false;
    request.onupgradeneeded = () => {
        createdByRace = true;
        request.transaction?.abort();
    };
    request.onsuccess = () => {
        if (createdByRace) {
            request.result.close();
            reject(new Error(`Database disappeared during cleanup scan: ${name}`));
            return;
        }
        resolve(request.result);
    };
    request.onerror = () => reject(request.error || new Error(`Failed to open ${name}`));
});

export const scanPrivateNpcDependencies = async (candidateIds: readonly string[]): Promise<Set<string>> => {
    const referenced = new Set<string>();

    const localStorageKeys: string[] = [];
    for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index);
        if (key === null) throw new Error('localStorage changed during cleanup scan');
        localStorageKeys.push(key);
        const value = localStorage.getItem(key);
        for (const id of candidateIds) {
            if (key.includes(id) || value?.includes(id)) referenced.add(id);
        }
    }
    const keysAfterScan = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index));
    if (keysAfterScan.some(key => key === null)
        || [...localStorageKeys].sort().join('\0') !== [...keysAfterScan as string[]].sort().join('\0')) {
        throw new Error('localStorage changed during cleanup scan');
    }

    const mainDb = await openDB();
    for (const id of await scanDatabase(mainDb, candidateIds, true)) referenced.add(id);

    const databaseFactory = indexedDB as IDBFactory & {
        databases?: () => Promise<Array<{ name?: string; version?: number }>>;
    };
    if (typeof databaseFactory.databases !== 'function') {
        throw new Error('Cannot enumerate auxiliary IndexedDB databases safely');
    }
    const databaseInfos = await databaseFactory.databases();
    const auxiliaryNames = [...new Set(databaseInfos.map(info => info.name).filter((name): name is string => !!name && name !== mainDb.name))];
    for (const name of auxiliaryNames) {
        const db = await openExistingDatabase(name);
        try {
            for (const id of await scanDatabase(db, candidateIds, false)) referenced.add(id);
        } finally {
            db.close();
        }
    }

    return referenced;
};

export interface PrivateNpcLeakCleanupRuntime {
    getMarker(): string | null;
    setMarker(value: string): void;
    isUntouched(character: CharacterProfile): Promise<boolean>;
    findReferencedIds(candidateIds: readonly string[]): Promise<Set<string>>;
    deleteRecordsOnly(ids: readonly string[]): Promise<void>;
}

const browserRuntime: PrivateNpcLeakCleanupRuntime = {
    getMarker: () => localStorage.getItem(MIGRATION_KEY),
    setMarker: value => localStorage.setItem(MIGRATION_KEY, value),
    isUntouched: isUntouchedLeakedSeed,
    findReferencedIds: scanPrivateNpcDependencies,
    deleteRecordsOnly: ids => DB.deleteCharacterRecordsOnly(ids),
};

export interface PrivateNpcLeakCleanupResult {
    characters: CharacterProfile[];
    deletedIds: string[];
    preservedIds: string[];
    alreadyCompleted: boolean;
}

/**
 * One-time, fail-closed cleanup. Candidate classification and every dependency read finish before
 * the single record-only delete transaction starts. Any thrown error leaves the completion marker
 * unset so a later startup can retry without broad deletion or alias/name matching.
 */
export async function runPrivateNpcLeakCleanupV1(
    characters: CharacterProfile[],
    runtime: PrivateNpcLeakCleanupRuntime = browserRuntime,
): Promise<PrivateNpcLeakCleanupResult> {
    if (runtime.getMarker() === MIGRATION_DONE) {
        return { characters, deletedIds: [], preservedIds: [], alreadyCompleted: true };
    }

    const candidates: CharacterProfile[] = [];
    for (const character of characters) {
        if (await isCanonicalLeakedId(character.id)) candidates.push(character);
    }

    if (candidates.length === 0) {
        runtime.setMarker(MIGRATION_DONE);
        return { characters, deletedIds: [], preservedIds: [], alreadyCompleted: false };
    }

    const untouchedById = new Map<string, boolean>();
    for (const candidate of candidates) {
        untouchedById.set(candidate.id, await runtime.isUntouched(candidate));
    }
    const referencedIds = await runtime.findReferencedIds(candidates.map(candidate => candidate.id));
    const deletedIds = candidates
        .filter(candidate => untouchedById.get(candidate.id) && !referencedIds.has(candidate.id))
        .map(candidate => candidate.id);
    const deletedSet = new Set(deletedIds);
    const preservedIds = candidates.filter(candidate => !deletedSet.has(candidate.id)).map(candidate => candidate.id);

    if (deletedIds.length > 0) await runtime.deleteRecordsOnly(deletedIds);
    runtime.setMarker(MIGRATION_DONE);
    return {
        characters: characters.filter(character => !deletedSet.has(character.id)),
        deletedIds,
        preservedIds,
        alreadyCompleted: false,
    };
}
