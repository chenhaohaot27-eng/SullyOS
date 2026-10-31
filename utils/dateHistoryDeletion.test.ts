import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DB, openDB } from './db';
import { DATE_DELETION_STORE, sanitizeDeletedRow } from './dateDeletionLedger';
import { planDateDeletion, resolveDateDeletion, previewDateDeletion, deleteDateHistory, finishDateDeletionSync, readDeletionLedger } from './dateHistoryDeletion';
import { withMemoryMutation } from './memoryMutationGate';
import { MemoryNodeDB } from './memoryPalace/db';
import { buildDateHistoryGroups } from './dateHistory';
const msg = (id: number, extra: any = {}) => ({ id, charId: 'a', role: 'assistant', type: 'text', content: `消息${id}`, timestamp: new Date(2026, 0, 1, 23, 58 + id).getTime(), metadata: { source: 'date', isOpening: id === 1 }, ...extra });
const node = (id: string, ids?: number[], extra: any = {}) => ({ id, charId: 'a', content: id, room: 'living_room', tags: [], mood: 'neutral', importance: 5, embedded: true, createdAt: 1, lastAccessedAt: 1, accessCount: 0, sourceMessageIds: ids, ...extra });
const rows = () => ({ messages: [msg(1), msg(2), msg(3, { metadata: { source: 'date', isOpening: true } }), msg(4, { charId: 'b' }), msg(5, { metadata: {} })], characters: [{ id: 'a', memories: [] }, { id: 'b', memories: [] }], memory_nodes: [node('delete', [1]), node('mixed', [1, 2]), node('keep', [3]), node('legacy'), node('other', [1], { charId: 'b' })], memory_vectors: [], memory_links: [], event_boxes: [], room_plates: [], digest_reports: [], [DATE_DELETION_STORE]: [] } as Record<string, any[]>);
async function seed(data: Record<string, any[]>) {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => { const tx = db.transaction(Object.keys(data), 'readwrite'); for (const [name, items] of Object.entries(data)) items.forEach(row => tx.objectStore(name).put(row)); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
}
beforeEach(async () => { await DB.deleteDB(); localStorage.clear(); vi.restoreAllMocks(); });
describe('date deletion scope and rebuild', () => {
    it('resolves a paginated tail to the full cross-midnight encounter', () => {
        expect(resolveDateDeletion(rows().messages, 'a', { view: 'encounter', anchorIds: [2] }).map(m => m.id)).toEqual([1, 2]);
        expect(resolveDateDeletion(rows().messages, 'a', { messageIds: [4, 5] })).toEqual([]);
    });
    it('keeps other dates and other characters and untraced legacy memories', () => {
        const p = planDateDeletion(rows(), 'a', { messageIds: [1] });
        expect(p.removedNodes).toEqual(['delete']);
        expect(p.updates.memory_nodes[0]).toMatchObject({ id: 'mixed', sourceMessageIds: [2], content: '角色：消息2' });
        expect(p.warnings.join()).toContain('来源不明');
    });
    it('rebuilds event summaries and auto-archive bullets from survivors', () => {
        const data = rows();
        data.memory_nodes.push(node('summary', undefined, { isBoxSummary: true }), node('child', undefined, { sourceId: 'delete', origin: 'digestion' }));
        data.event_boxes.push({ id: 'box', charId: 'a', name: 'old', liveMemoryIds: ['keep'], archivedMemoryIds: ['delete'], summaryNodeId: 'summary' });
        data.characters[0].memories = [{ id: 'f', mood: 'palace', date: '2026-01-01', summary: '- delete\n- keep', sourceMemoryIds: ['delete', 'keep'], sourceEntries: [{ memoryId: 'delete', text: 'delete' }, { memoryId: 'keep', text: 'keep' }] }];
        const p = planDateDeletion(data, 'a', { messageIds: [1] });
        expect(p.removedNodes).toContain('child');
        expect(p.updates.memory_nodes.find(n => n.id === 'summary').content).toBe('keep');
        expect(p.updates.event_boxes[0].archivedMemoryIds).toEqual([]);
        expect(p.updates.characters[0].memories[0].summary).toBe('- keep');
    });
    it('reports incomplete source reconstruction without deleting the mixed node', () => {
        const data = rows(); data.memory_nodes[1].sourceMessageIds = [1, 999];
        const p = planDateDeletion(data, 'a', { messageIds: [1] });
        expect(p.warnings.join()).toContain('重建失败');
        expect(p.removedNodes).not.toContain('mixed');
        expect(sanitizeDeletedRow('memory_nodes', data.memory_nodes[1], [p.ledger])).toBeDefined();
    });
    it('does not trust imported legacy IDs that may belong to a different database', () => {
        const data = rows(); data.memory_nodes.push(node('imported', undefined, { legacyCsy: { sourceMessageIds: [1] } }));
        expect(planDateDeletion(data, 'a', { messageIds: [1] }).removedNodes).not.toContain('imported');
    });
    it('does not turn legacy day groups into a cross-date encounter after deletion', async () => {
        const data = rows(); data.messages = [msg(1, { metadata: { source: 'date' }, timestamp: new Date(2026, 0, 1, 10).getTime() }), msg(2, { metadata: { source: 'date' }, timestamp: new Date(2026, 0, 1, 11).getTime() }), msg(3, { metadata: { source: 'date' }, timestamp: new Date(2026, 0, 2, 10).getTime() })];
        await seed(data); const selection = { messageIds: [1] };
        await deleteDateHistory(await previewDateDeletion('a', selection), selection);
        const all = await DB.getRecentMessagesByCharIdAndSource('a', 'date', 99);
        expect(buildDateHistoryGroups(all, 'encounter', 'oldest').map(g => g.messages.map(m => m.id))).toEqual([[2], [3]]);
    });
    it('aborts unsafe event reconstruction before deleting anything', async () => {
        const data = rows(); data.event_boxes.push({ id: 'box', charId: 'a', liveMemoryIds: ['delete', 'missing'], archivedMemoryIds: [], summaryNodeId: null });
        await seed(data);
        await expect(previewDateDeletion('a', { messageIds: [1] })).rejects.toThrow('原始节点缺失');
        expect((await DB.getRawStoreData('messages')).length).toBe(5);
    });
});
describe('committed deletion and consistency', () => {
    it('atomically removes vectors/links and preserves boundaries, rejects stale saves', async () => {
        const data = rows(); data.memory_vectors.push({ memoryId: 'delete', charId: 'a', vector: [1], dimensions: 1 });
        data.memory_links.push({ id: 'link', sourceId: 'delete', targetId: 'keep' });
        await seed(data);
        const p = await previewDateDeletion('a', { messageIds: [1] });
        await deleteDateHistory(p, { messageIds: [1] });
        expect((await DB.getRawStoreData('memory_vectors')).length).toBe(0);
        expect((await DB.getRawStoreData('memory_links')).length).toBe(0);
        const messages = await DB.getRecentMessagesByCharIdAndSource('a', 'date', 999);
        expect(buildDateHistoryGroups(messages, 'encounter', 'oldest').map(g => g.messages.map(m => m.id))).toEqual([[2], [3]]);
        await expect(MemoryNodeDB.save(node('delete', [1]) as any)).rejects.toThrow();
        expect(await MemoryNodeDB.getById('other')).toBeDefined();
        await MemoryNodeDB.save(node('mixed', [1, 2]) as any);
        expect((await MemoryNodeDB.getById('mixed'))?.content).toBe('角色：消息2');
    });
    it('refuses deleting while extraction/digestion holds a task lease', async () => {
        await seed(rows()); const p = await previewDateDeletion('a', { messageIds: [1] });
        await withMemoryMutation(async () => { await expect(deleteDateHistory(p, { messageIds: [1] })).rejects.toThrow(/正在运行|正在处理/); });
        expect((await DB.getRawStoreData('messages')).length).toBe(5);
    });
    it('rejects changed groups instead of silently extending confirmation', async () => {
        await seed(rows()); const s = { view: 'encounter' as const, anchorIds: [3] }; const p = await previewDateDeletion('a', s);
        await seed({ messages: [msg(6)] });
        await expect(deleteDateHistory(p, s)).rejects.toThrow('记录已变化');
    });
    it('keeps pending remote failures, retries idempotently with character filter', async () => {
        await seed(rows()); const s = { messageIds: [1] }; await deleteDateHistory(await previewDateDeletion('a', s), s);
        localStorage.setItem('os_remote_vector_config', JSON.stringify({ enabled: true, initialized: true, supabaseUrl: 'https://example.test', supabaseAnonKey: 'test' }));
        const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 500 }));
        const errors = await finishDateDeletionSync('a', async () => { throw new Error('offline'); });
        expect(errors.join()).toContain('清理失败'); expect(errors.join()).toContain('offline');
        expect((await readDeletionLedger('a'))?.cloudPending).toBe(true);
        expect(String(fetch.mock.calls[0][0])).toContain('char_id=eq.a');
        fetch.mockImplementation(async () => new Response('', { status: 200 }));
        expect(await finishDateDeletionSync('a', async () => {})).toEqual([]);
        expect((await readDeletionLedger('a'))?.remotePending).toEqual([]);
    });
    it('blocks old backup before any write, and includes tombstones in exports', async () => {
        await seed(rows()); const s = { messageIds: [1] }; await deleteDateHistory(await previewDateDeletion('a', s), s);
        await expect(DB.importFullData({ messages: [msg(1)] } as any)).rejects.toThrow('写入前停止');
        expect((await DB.getRawStoreData('messages')).length).toBe(4);
        expect((await DB.exportFullData()).dateDeletionLedger?.[0].messageIds).toContain(1);
    });
});
