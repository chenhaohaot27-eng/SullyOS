import { describe, expect, it } from 'vitest';
import { parseMemoryNodesFromBuffer } from './extraction';
import { buildAutoArchiveFragments, mergePalaceFragmentsIntoMemories } from './pipeline';
import { sanitizeDeletedRow, type DeletionLedger } from '../dateDeletionLedger';
const messages: any[] = [1, 2].map(id => ({ id, charId: 'a', role: 'user', content: 'hello', type: 'text', timestamp: 1000 + id }));
describe('message provenance', () => {
    it('validates citations against actual input IDs, preserves honest batch fallback', () => {
        const nodes = parseMemoryNodesFromBuffer([
            { content: 'one', room: 'study', sourceMessageIds: [2] },
            { content: 'invalid', room: 'study', sourceMessageIds: [99] },
            { content: 'missing', room: 'study' },
        ], 'a', messages, 'batch');
        expect(nodes[0]).toMatchObject({ sourceMessageIds: [2], sourceScope: 'message' });
        expect(nodes[1]).toMatchObject({ sourceMessageIds: [1, 2], sourceScope: 'batch' });
        expect(nodes[2]).toMatchObject({ sourceMessageIds: [1, 2], sourceScope: 'batch' });
    });
    it('retains legacy archive text separately when adding traced bullets', () => {
        const archive = buildAutoArchiveFragments([{ id: 'n', content: 'new fact', createdAt: 1000 }], 2)!;
        const merged = mergePalaceFragmentsIntoMemories([{ id: 'legacy', date: archive.fragments[0].date, summary: '- old fact', mood: 'palace' }], archive.fragments);
        expect(merged[0]).toMatchObject({ sourceMemoryIds: ['n'], legacySummary: '- old fact' });
    });
    it('sanitizes late mixed archive writes without removing unrelated facts', () => {
        const ledger: DeletionLedger = { charId: 'a', messageIds: [1], nodeIds: ['n'], replacements: {}, remotePending: [], cloudPending: false, revision: 10 };
        const safe = sanitizeDeletedRow('characters', { id: 'a', memories: [{ id: 'f', summary: '- deleted\n- retained', sourceMemoryIds: ['n', 'keep'], sourceEntries: [{ memoryId: 'n', text: 'deleted' }, { memoryId: 'keep', text: 'retained' }], legacySummary: '- legacy' }] }, [ledger]);
        expect(safe.memories[0].summary).toBe('- legacy\n- retained');
    });
});
