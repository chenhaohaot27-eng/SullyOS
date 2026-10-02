import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CharacterProfile } from '../types';
import { DB } from './db';
import {
    findCandidateIdsInValue,
    isCanonicalLeakedId,
    runPrivateNpcLeakCleanupV1,
    scanPrivateNpcDependencies,
    type PrivateNpcLeakCleanupRuntime,
} from './privateNpcLeakCleanup';

const leakedId = (suffix = 'talia'): string => ['formal', 'npc', suffix].join('-');
const profile = (id: string, name = 'Private candidate'): CharacterProfile => ({
    id,
    name,
    avatar: '',
    description: '',
    systemPrompt: '',
    memories: [],
});

const createRuntime = (options: {
    marker?: string | null;
    untouched?: boolean;
    references?: Set<string>;
    scanError?: Error;
    deleteError?: Error;
} = {}) => {
    let marker = options.marker ?? null;
    const deleted: string[][] = [];
    const runtime: PrivateNpcLeakCleanupRuntime = {
        getMarker: vi.fn(() => marker),
        setMarker: vi.fn(value => { marker = value; }),
        isUntouched: vi.fn(async () => options.untouched ?? true),
        findReferencedIds: vi.fn(async () => {
            if (options.scanError) throw options.scanError;
            return options.references ?? new Set<string>();
        }),
        deleteRecordsOnly: vi.fn(async ids => {
            if (options.deleteError) throw options.deleteError;
            deleted.push([...ids]);
        }),
    };
    return { runtime, deleted, marker: () => marker };
};

beforeEach(async () => {
    await DB.deleteDB();
    localStorage.clear();
});

afterEach(async () => {
    await DB.deleteDB();
});

describe('privateNpcLeakCleanupV1', () => {
    it('recognizes only the four exact historical IDs without publishing their literals', async () => {
        for (const suffix of ['talia', 'amund', 'charles', 'sutherland']) {
            expect(await isCanonicalLeakedId(leakedId(suffix))).toBe(true);
        }
        expect(await isCanonicalLeakedId('custom-talia')).toBe(false);
        expect(await isCanonicalLeakedId(`${leakedId()}-copy`)).toBe(false);
    });

    it('marks a fresh database complete without creating or deleting profiles', async () => {
        const state = createRuntime();
        const result = await runPrivateNpcLeakCleanupV1([], state.runtime);

        expect(result.characters).toEqual([]);
        expect(state.runtime.isUntouched).not.toHaveBeenCalled();
        expect(state.runtime.findReferencedIds).not.toHaveBeenCalled();
        expect(state.runtime.deleteRecordsOnly).not.toHaveBeenCalled();
        expect(state.marker()).toBe('completed');
    });

    it('leaves ordinary existing-user profiles byte-for-byte unchanged', async () => {
        const ordinary = {
            ...profile('user-character', 'User character'),
            aliases: ['Custom alias'],
            memories: [{ id: 'memory-1', date: '2026-09-06', summary: 'keep me' }],
            systemPrompt: 'custom prompt',
        };
        const snapshot = structuredClone(ordinary);
        const state = createRuntime();
        const result = await runPrivateNpcLeakCleanupV1([ordinary], state.runtime);

        expect(result.characters).toEqual([snapshot]);
        expect(result.characters[0]).toBe(ordinary);
        expect(state.runtime.deleteRecordsOnly).not.toHaveBeenCalled();
    });

    it('deletes an untouched, unreferenced candidate through the record-only API', async () => {
        const candidate = profile(leakedId());
        const ordinary = profile('custom-keep', 'Ordinary');
        const state = createRuntime();
        const result = await runPrivateNpcLeakCleanupV1([candidate, ordinary], state.runtime);

        expect(result.characters).toEqual([ordinary]);
        expect(state.deleted).toEqual([[candidate.id]]);
        expect(result.deletedIds).toEqual([candidate.id]);
        expect(state.marker()).toBe('completed');
    });

    it('the record-only DB API leaves related messages and unrelated profiles intact', async () => {
        const candidate = profile(leakedId());
        const ordinary = profile('custom-keep', 'Ordinary');
        await DB.saveCharacter(candidate);
        await DB.saveCharacter(ordinary);
        await DB.saveMessage({
            charId: candidate.id,
            role: 'user',
            type: 'text',
            content: 'must remain',
        });

        expect(await scanPrivateNpcDependencies([candidate.id])).toEqual(new Set([candidate.id]));

        await DB.deleteCharacterRecordsOnly([candidate.id]);

        expect(await DB.getAllCharacters()).toEqual([ordinary]);
        expect(await DB.getMessagesByCharId(candidate.id)).toHaveLength(1);
    });

    it('treats per-character local settings as dependencies', async () => {
        const id = leakedId();
        localStorage.setItem(`settings:${id}`, 'enabled');

        expect(await scanPrivateNpcDependencies([id])).toEqual(new Set([id]));
    });

    it('preserves a candidate whose profile differs from the original seed', async () => {
        const candidate = profile(leakedId());
        const state = createRuntime({ untouched: false });
        const result = await runPrivateNpcLeakCleanupV1([candidate], state.runtime);

        expect(result.characters).toEqual([candidate]);
        expect(result.preservedIds).toEqual([candidate.id]);
        expect(state.runtime.deleteRecordsOnly).not.toHaveBeenCalled();
        expect(state.marker()).toBe('completed');
    });

    it.each(['message', 'memory', 'relationship', 'story', 'gift', 'group', 'active-message task'])(
        'preserves a candidate referenced by %s data',
        async () => {
            const candidate = profile(leakedId());
            const state = createRuntime({ references: new Set([candidate.id]) });
            const result = await runPrivateNpcLeakCleanupV1([candidate], state.runtime);

            expect(result.characters).toEqual([candidate]);
            expect(state.runtime.deleteRecordsOnly).not.toHaveBeenCalled();
            expect(state.marker()).toBe('completed');
        },
    );

    it('finds exact candidate IDs recursively in keys, arrays, maps and sets', () => {
        const id = leakedId();
        const record = {
            message: { charId: id },
            [`relationship:${id}`]: true,
            nested: new Map([['gift', new Set([`owner=${id}`])]]),
        };
        expect(findCandidateIdsInValue(record, [id])).toEqual(new Set([id]));
        expect(findCandidateIdsInValue({ name: 'same display name only' }, [id])).toEqual(new Set());
    });

    it('never deletes a different ID merely because its name or alias matches', async () => {
        const sameName = { ...profile('user-imported-card'), aliases: ['Private candidate'] };
        const state = createRuntime();
        const result = await runPrivateNpcLeakCleanupV1([sameName], state.runtime);

        expect(result.characters).toEqual([sameName]);
        expect(state.runtime.isUntouched).not.toHaveBeenCalled();
        expect(state.runtime.deleteRecordsOnly).not.toHaveBeenCalled();
    });

    it('preserves everything and leaves the marker unset when dependency scanning fails', async () => {
        const candidate = profile(leakedId());
        const state = createRuntime({ scanError: new Error('read failed') });

        await expect(runPrivateNpcLeakCleanupV1([candidate], state.runtime)).rejects.toThrow('read failed');
        expect(state.runtime.deleteRecordsOnly).not.toHaveBeenCalled();
        expect(state.marker()).toBeNull();
    });

    it('leaves the marker unset when the atomic record-only delete fails', async () => {
        const candidate = profile(leakedId());
        const state = createRuntime({ deleteError: new Error('write failed') });

        await expect(runPrivateNpcLeakCleanupV1([candidate], state.runtime)).rejects.toThrow('write failed');
        expect(state.marker()).toBeNull();
    });

    it('runs only once after successful completion', async () => {
        const candidate = profile(leakedId());
        const state = createRuntime({ marker: 'completed' });
        const result = await runPrivateNpcLeakCleanupV1([candidate], state.runtime);

        expect(result.alreadyCompleted).toBe(true);
        expect(result.characters).toEqual([candidate]);
        expect(state.runtime.isUntouched).not.toHaveBeenCalled();
        expect(state.runtime.findReferencedIds).not.toHaveBeenCalled();
        expect(state.runtime.deleteRecordsOnly).not.toHaveBeenCalled();
    });
});
