import { beforeEach, describe, expect, it } from 'vitest';
import { DB, openDB } from '../db';
import {
    appendWorldEvent,
    ensureLivingWorldState,
    getAgentState,
    getLivingWorldState,
    listWorldEvents,
    saveAgentState,
} from './store';
import { worldTick } from './tick';
import { mapWorldHomeSnapshot } from './adapters/worldHome';

beforeEach(async () => {
    await DB.deleteDB();
});

async function createVersion71DatabaseWithData() {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('AetherOS_Data', 71);
        req.onupgradeneeded = () => {
            const db = req.result;
            const characters = db.createObjectStore('characters', { keyPath: 'id' });
            const messages = db.createObjectStore('messages', { keyPath: 'id' });
            messages.createIndex('charId', 'charId', { unique: false });
            messages.createIndex('groupId', 'groupId', { unique: false });
            db.createObjectStore('worlds', { keyPath: 'id' });
            db.createObjectStore('life_sim', { keyPath: 'id' });
            const memoryNodes = db.createObjectStore('memory_nodes', { keyPath: 'id' });
            memoryNodes.createIndex('charId', 'charId', { unique: false });
            memoryNodes.createIndex('room', 'room', { unique: false });
            memoryNodes.createIndex('embedded', 'embedded', { unique: false });
            memoryNodes.createIndex('boxId', 'boxId', { unique: false });
            memoryNodes.createIndex('eventBoxId', 'eventBoxId', { unique: false });
            db.createObjectStore('memory_vectors', { keyPath: 'memoryId' }).createIndex('charId', 'charId', { unique: false });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['characters', 'messages', 'worlds', 'life_sim', 'memory_nodes'], 'readwrite');
        tx.objectStore('characters').put({ id: 'char-existing', name: 'Existing' });
        tx.objectStore('messages').put({ id: 1, charId: 'char-existing', role: 'user', type: 'text', content: 'hello', timestamp: 1 });
        tx.objectStore('worlds').put({ id: 'world-existing', name: 'World', memberIds: ['char-existing'], npcs: [], houses: [], relationships: [], storyClock: 0, createdAt: 1, updatedAt: 1 });
        tx.objectStore('life_sim').put({ id: 'main', actionLog: [], pendingEffects: [] });
        tx.objectStore('memory_nodes').put({ id: 'mem-existing', charId: 'char-existing', room: 'living_room', embedded: false });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
    db.close();
}

describe('Living World passive foundation DB', () => {
    it('fresh database creates living_world store', async () => {
        const db = await openDB();
        expect(db.objectStoreNames.contains('living_world')).toBe(true);
    });

    it('existing database upgrade preserves old stores and adds living_world', async () => {
        await createVersion71DatabaseWithData();

        const db = await openDB();
        expect(db.objectStoreNames.contains('living_world')).toBe(true);

        expect((await DB.getRawStoreData('characters')).map((c: any) => c.id)).toEqual(['char-existing']);
        expect((await DB.getRawStoreData('messages')).map((m: any) => m.id)).toEqual([1]);
        expect((await DB.getRawStoreData('worlds')).map((w: any) => w.id)).toEqual(['world-existing']);
        expect((await DB.getRawStoreData('life_sim')).map((s: any) => s.id)).toEqual(['main']);
        expect((await DB.getRawStoreData('memory_nodes')).map((n: any) => n.id)).toEqual(['mem-existing']);
    });
});

describe('Living World store API', () => {
    it('saves state, agent state, and append-only events in timestamp order', async () => {
        const state = await ensureLivingWorldState('world-1');
        expect(state.worldId).toBe('world-1');
        expect(state.schemaVersion).toBe(1);

        await saveAgentState({
            worldId: 'world-1',
            charId: 'char-1',
            currentGoal: 'observe quietly',
            computeTier: 'ambient',
            updatedAt: 10,
        });
        expect(await getAgentState('world-1', 'char-1')).toMatchObject({
            worldId: 'world-1',
            charId: 'char-1',
            currentGoal: 'observe quietly',
            computeTier: 'ambient',
        });

        await appendWorldEvent({
            id: 'evt-2',
            worldId: 'world-1',
            timestamp: 200,
            type: 'note',
            actorIds: ['char-1'],
            source: 'manual',
            summary: 'second',
            refs: [{ kind: 'message', id: 'm2' }],
        });
        await appendWorldEvent({
            id: 'evt-1',
            worldId: 'world-1',
            timestamp: 100,
            type: 'note',
            actorIds: ['char-1'],
            source: 'manual',
            summary: 'first',
        });

        const events = await listWorldEvents('world-1');
        expect(events.map(event => event.id)).toEqual(['evt-1', 'evt-2']);
        await expect(appendWorldEvent({
            id: 'evt-1',
            worldId: 'world-1',
            timestamp: 300,
            type: 'note',
            actorIds: [],
            source: 'manual',
            summary: 'duplicate',
        })).rejects.toBeTruthy();
    });

    it('worldTick only updates tick metadata and does not append events', async () => {
        const result = await worldTick(new Date('2026-08-16T00:00:00.000Z'), 'foreground', { worldId: 'world-2' });
        expect(result.didAdvance).toBe(false);
        expect(result.state.lastTickAt).toBe(Date.parse('2026-08-16T00:00:00.000Z'));
        expect(await listWorldEvents('world-2')).toEqual([]);
    });

    it('WorldHome adapter maps snapshots without mutating source world', () => {
        const world: any = {
            id: 'world-home-1',
            memberIds: ['char-a'],
            npcs: [{ id: 'npc-a', name: 'NPC' }],
            houses: [{ id: 'house-a', residentIds: ['char-a'] }],
            relationships: [{ a: 'char-a', b: 'npc-a', label: '邻居', score: 1 }],
            storyClock: 8,
            realClock: { dayKey: '2026-08-16', seg: 1 },
        };
        const snapshot = mapWorldHomeSnapshot(world);
        snapshot.memberIds.push('char-b');
        expect(world.memberIds).toEqual(['char-a']);
        expect(snapshot).toMatchObject({
            worldId: 'world-home-1',
            storyClock: 8,
            realClock: { dayKey: '2026-08-16', seg: 1 },
        });
    });
});

describe('Living World backup integration', () => {
    it('exportFullData/importFullData roundtrips Living World records', async () => {
        await ensureLivingWorldState('world-backup');
        await saveAgentState({
            worldId: 'world-backup',
            charId: 'char-backup',
            pendingIntent: 'stay passive',
            updatedAt: 1,
        });
        await appendWorldEvent({
            id: 'evt-backup',
            worldId: 'world-backup',
            timestamp: 123,
            type: 'note',
            actorIds: ['char-backup'],
            source: 'manual',
            summary: 'reference only',
            refs: [{ kind: 'worldEpisode', id: 'episode-1' }],
        });

        const exported = await DB.exportFullData();
        expect(exported.livingWorld?.map((record: any) => record.id).sort()).toEqual([
            'evt-backup',
            'state:world-backup',
        ].sort());

        await DB.deleteDB();
        await openDB();
        await DB.importFullData(exported as any);

        expect(await getLivingWorldState('world-backup')).toMatchObject({ worldId: 'world-backup' });
        expect(await getAgentState('world-backup', 'char-backup')).toMatchObject({ pendingIntent: 'stay passive' });
        expect((await listWorldEvents('world-backup')).map(event => event.id)).toEqual(['evt-backup']);
    });

    it('old backup without livingWorld imports as empty Living World state', async () => {
        await openDB();
        await DB.importFullData({ timestamp: Date.now(), version: 3 } as any);
        expect(await DB.getRawStoreData('living_world')).toEqual([]);
        expect(await getLivingWorldState('missing-world')).toBeNull();
    });
});
