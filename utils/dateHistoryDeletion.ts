import { DB, openDB } from './db';
import { buildDateHistoryGroups, type DateHistoryView } from './dateHistory';
import { DATE_DELETION_STORE, type DeletionLedger } from './dateDeletionLedger';
import { withMemoryMutation } from './memoryMutationGate';
import { bm25Index } from './memoryPalace/bm25Index';
import type { Message } from '../types';

export type DateDeleteSelection = { messageIds: number[] } | { view: DateHistoryView; anchorIds: number[] };
const stores = ['messages', 'characters', 'memory_nodes', 'memory_vectors', 'memory_links', 'event_boxes', 'room_plates', 'digest_reports', DATE_DELETION_STORE];
export interface DeletePlan {
    charId: string; messageIds: number[]; removedNodes: string[];
    updates: Record<string, any[]>; warnings: string[]; ledger: DeletionLedger;
}
export function resolveDateDeletion(messages: Message[], charId: string, selection: DateDeleteSelection): Message[] {
    const own = messages.filter(m => m.charId === charId && !m.groupId && m.metadata?.source === 'date');
    if ('messageIds' in selection) return own.filter(m => selection.messageIds.includes(m.id));
    const anchors = new Set(selection.anchorIds);
    return buildDateHistoryGroups(own, selection.view, 'oldest')
        .filter(g => g.messages.some(m => anchors.has(m.id))).flatMap(g => g.messages);
}

/** Pure plan; exact IDs only. Deterministic rebuilding retains source text, with no LLM inference. */
export function planDateDeletion(rows: Record<string, any[]>, charId: string, selection: DateDeleteSelection): DeletePlan {
    const selected = resolveDateDeletion(rows.messages, charId, selection);
    const messageIds = selected.map(m => m.id);
    const deleted = new Set(messageIds);
    const previous = rows[DATE_DELETION_STORE]?.find(l => l.charId === charId) as DeletionLedger | undefined;
    const revision = Math.max(Date.now(), (previous?.revision || 0) + 1);
    const ledger: DeletionLedger = {
        charId, messageIds: [...new Set([...(previous?.messageIds || []), ...messageIds])],
        unresolvedNodeIds: [...(previous?.unresolvedNodeIds || [])],
        nodeIds: [...(previous?.nodeIds || [])], replacements: structuredClone(previous?.replacements || {}),
        invalidDateStateBefore: previous?.invalidDateStateBefore,
        remotePending: [...(previous?.remotePending || [])], cloudPending: true, revision,
    };
    const updates: Record<string, any[]> = {};
    const warnings: string[] = ['远程仅清理可确认的节点 ID；远程独有和旧版未溯源内容保留，不按日期推断删除。'];
    const nodes = rows.memory_nodes.filter(n => n.charId === charId);
    const removed = new Set<string>();
    const changed = new Map<string, any>();
    const replace = (store: string, row: any) => {
        const value = { ...row, deletionRevision: revision };
        (updates[store] ||= []).push(value);
        (ledger.replacements[store] ||= {})[row.id] = value;
        return value;
    };
    let unknown = 0;
    for (const node of nodes) {
        if (node.isBoxSummary) continue;
        const ids: number[] = node.sourceMessageIds || [];
        if (!ids.length) { if (!node.sourceId) unknown++; continue; }
        if (!ids.some(id => deleted.has(id))) continue;
        const remaining = ids.filter(id => !ledger.messageIds.includes(id));
        if (!remaining.length) { removed.add(node.id); continue; }
        const material = rows.messages.filter(m => m.charId === charId && remaining.includes(m.id));
        if (material.length !== remaining.length || material.some(m => !m.content?.trim() || (m.type !== 'text' && m.type !== 'voice'))) {
            ledger.unresolvedNodeIds!.push(node.id);
            warnings.push(`记忆 ${node.id} 含多来源且保留材料不完整，重建失败，已保留原记忆供人工核查。`);
            continue;
        }
        changed.set(node.id, replace('memory_nodes', {
            ...node, content: material.map(m => `${m.role === 'user' ? '用户' : '角色'}：${m.content}`).join('\n'),
            sourceMessageIds: remaining, embedded: false, tags: [], mood: 'neutral',
        }));
    }
    // Confirmed cognitive lineage. Rebuild descendants from their retained parent material.
    let progress = true;
    while (progress) {
        progress = false;
        for (const n of nodes) {
            if (removed.has(n.id) || changed.has(n.id) || !n.sourceId) continue;
            if (removed.has(n.sourceId)) { removed.add(n.id); progress = true; }
            else if (changed.has(n.sourceId)) {
                const parent = changed.get(n.sourceId);
                changed.set(n.id, replace('memory_nodes', { ...n, content: parent.content, sourceMessageIds: parent.sourceMessageIds, embedded: false, tags: [], mood: 'neutral' }));
                progress = true;
            }
        }
    }
    const impacted = (id: string) => removed.has(id) || changed.has(id);
    for (const box of rows.event_boxes.filter(b => b.charId === charId)) {
        const members: string[] = [...new Set<string>([...box.liveMemoryIds, ...box.archivedMemoryIds])];
        if (!members.some(impacted)) continue;
        const kept = members.filter(id => !removed.has(id));
        const material = kept.map(id => changed.get(id) || nodes.find(n => n.id === id));
        if (material.some(n => !n)) throw new Error(`事件盒 ${box.id} 原始节点缺失，无法安全重建；未执行删除。`);
        const summary = nodes.find(n => n.id === box.summaryNodeId);
        if (summary) {
            if (!kept.length) removed.add(summary.id);
            else changed.set(summary.id, replace('memory_nodes', {
                ...summary, content: material.map(n => n.content).join('\n'),
                sourceMemoryIds: kept, sourceMessageIds: [...new Set(material.flatMap(n => n.sourceMessageIds || []))],
                tags: [], embedded: false, mood: 'neutral',
            }));
        }
        replace('event_boxes', { ...box, name: '保留的见面相关记忆', tags: [],
            liveMemoryIds: box.liveMemoryIds.filter((id: string) => !removed.has(id)),
            archivedMemoryIds: box.archivedMemoryIds.filter((id: string) => !removed.has(id)),
            summaryNodeId: kept.length ? box.summaryNodeId : null, updatedAt: revision,
        });
    }
    const character = rows.characters.find(c => c.id === charId);
    let legacyArchives = 0;
    if (character) {
        const memories = (character.memories || []).flatMap((fragment: any) => {
            if (!fragment.sourceMemoryIds?.length) { legacyArchives++; return [fragment]; }
            if (!fragment.sourceMemoryIds.some(impacted)) return [fragment];
            // New archives carry per-node bullets. Never rewrite untraced legacy text.
            if (!fragment.sourceEntries) { warnings.push(`归档 ${fragment.id} 缺少逐条来源，已保留。`); return [fragment]; }
            const entries = fragment.sourceEntries.flatMap((e: any) => removed.has(e.memoryId) ? [] : [{ ...e, text: changed.get(e.memoryId)?.content || e.text }]);
            const rebuilt = entries.length || fragment.legacySummary ? {
                ...fragment, sourceEntries: entries, sourceMemoryIds: entries.map((e: any) => e.memoryId),
                summary: [fragment.legacySummary, ...entries.map((e: any) => `- ${e.text.replace(/\n/g, ' ')}`)].filter(Boolean).join('\n'), deletionRevision: revision,
            } : null;
            (ledger.replacements.fragments ||= {})[fragment.id] = rebuilt;
            return rebuilt ? [rebuilt] : [];
        });
        let savedDateState = character.savedDateState;
        if (savedDateState) {
            const source = savedDateState.sourceMessageId || rows.messages
                .filter(m => m.charId === charId && m.metadata?.source === 'date' && m.role === 'assistant' && m.timestamp <= savedDateState.timestamp)
                .sort((a, b) => b.timestamp - a.timestamp || b.id - a.id)[0]?.id;
            if (source && deleted.has(source)) { ledger.invalidDateStateBefore = Math.max(previous?.invalidDateStateBefore || 0, savedDateState.timestamp); savedDateState = undefined; }
            else if (!savedDateState.sourceMessageId) warnings.push('旧见面进度快照缺少消息来源；未确认关联的快照已保留。');
        }
        updates.characters = [{ ...character, memories, savedDateState }];
    }
    // Old room plates / digestion logs contain no fact-level provenance. Report, don't guess.
    const plates = rows.room_plates.filter(p => p.charId === charId).reduce((n, p) => n + p.entries.length, 0);
    if (unknown || legacyArchives || plates) warnings.push(`来源不明，保留待核查：${unknown} 条记忆、${legacyArchives} 条旧归档、${plates} 条认知门牌。不能保证它们不含本次记录。`);
    if (rows.digest_reports.some(r => r.charId === charId)) warnings.push('消化日志缺少完整消息溯源，已保留供核查。');
    ledger.warnings = warnings;
    ledger.nodeIds = [...new Set([...ledger.nodeIds, ...removed])];
    ledger.remotePending = [...new Set([...ledger.remotePending, ...removed, ...changed.keys()])];
    return { charId, messageIds, removedNodes: [...removed], updates, warnings, ledger };
}

async function transactionPlan(charId: string, selection: DateDeleteSelection, commit: boolean, expectedIds?: number[]): Promise<DeletePlan> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(stores, commit ? 'readwrite' : 'readonly');
        const rows: Record<string, any[]> = {};
        let count = 0; let plan: DeletePlan; let failure: unknown;
        for (const store of stores) {
            const objectStore = tx.objectStore(store);
            const req = objectStore.indexNames.contains('charId') ? objectStore.index('charId').getAll(IDBKeyRange.only(charId)) : objectStore.getAll();
            req.onsuccess = () => {
                rows[store] = req.result;
                if (++count !== stores.length) return;
                try {
                    plan = planDateDeletion(rows, charId, selection);
                    if (!commit) return;
                    if (expectedIds && JSON.stringify([...plan.messageIds].sort()) !== JSON.stringify([...expectedIds].sort())) throw new Error('记录已变化，请重新确认删除范围。');
                    if (!plan.messageIds.length) throw new Error('没有可删除的见面记录。');
                    plan.messageIds.forEach(id => tx.objectStore('messages').delete(id));
                    const invalid = new Set(plan.ledger.remotePending);
                    plan.removedNodes.forEach(id => tx.objectStore('memory_nodes').delete(id));
                    invalid.forEach(id => tx.objectStore('memory_vectors').delete(id));
                    rows.memory_links.filter(l => plan.removedNodes.includes(l.sourceId) || plan.removedNodes.includes(l.targetId)).forEach(l => tx.objectStore('memory_links').delete(l.id));
                    for (const [storeName, items] of Object.entries(plan.updates)) items.forEach(item => tx.objectStore(storeName).put(item));
                    // Keep encounter boundaries after deletion of opening messages, including cross-midnight.
                    for (const group of buildDateHistoryGroups(rows.messages.filter(m => m.charId === charId && !m.groupId && m.metadata?.source === 'date'), 'encounter', 'oldest')) {
                        const kept = group.messages.filter(m => !plan.messageIds.includes(m.id));
                        if (group.hasOpeningAnchor && kept.length && plan.messageIds.includes(group.messages[0].id)) {
                            const first = kept[0];
                            tx.objectStore('messages').put({ ...first, metadata: { ...first.metadata, isOpening: true, encounterTitle: group.title } });
                        }
                    }
                    tx.objectStore(DATE_DELETION_STORE).put(plan.ledger);
                } catch (e) { failure = e; tx.abort(); }
            };
        }
        tx.oncomplete = () => resolve(plan!);
        tx.onerror = tx.onabort = () => reject(failure || tx.error || new Error('删除事务未提交，未删除本地数据。'));
    });
}
export const previewDateDeletion = (charId: string, selection: DateDeleteSelection) => transactionPlan(charId, selection, false);
export async function deleteDateHistory(plan: DeletePlan, selection: DateDeleteSelection): Promise<DeletePlan> {
    return withMemoryMutation(async () => {
        const result = await transactionPlan(plan.charId, selection, true, plan.messageIds);
        bm25Index.dropAll();
        const { clearReceipts } = await import('./memoryPalace/recallReceipts');
        clearReceipts(plan.charId);
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('date-history-deleted', { detail: { charId: plan.charId } }));
            try { localStorage.setItem('os_date_deletion_revision', JSON.stringify({ charId: plan.charId, at: Date.now() })); } catch { /* DB ledger remains authoritative */ }
        }
        return result;
    }, true);
}
export async function readDeletionLedger(charId: string): Promise<DeletionLedger | undefined> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const req = db.transaction(DATE_DELETION_STORE).objectStore(DATE_DELETION_STORE).get(charId);
        req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
}
export async function finishDateDeletionSync(charId: string, syncCloud: () => Promise<void>): Promise<string[]> {
    return withMemoryMutation(async () => {
        const ledger = await readDeletionLedger(charId);
        if (!ledger) return [];
        const errors: string[] = [];
        let config: any;
        try { config = JSON.parse(localStorage.getItem('os_remote_vector_config') || 'null'); } catch { errors.push('远程向量配置无法读取。'); }
        if (config?.enabled) {
            const { deleteVector } = await import('./memoryPalace/supabaseVector');
            const remaining: string[] = [];
            for (const id of ledger.remotePending) {
                if (!await deleteVector(config, id, charId)) remaining.push(id);
            }
            ledger.remotePending = remaining;
            if (remaining.length) errors.push(`远程向量 ${remaining.length} 条清理失败，已保留重试记录。`);
        } else if (ledger.remotePending.length) errors.push('远程向量未启用：已记录待清理 ID，启用后请重试同步。');
        try { await syncCloud(); ledger.cloudPending = false; }
        catch (e) { errors.push(`主动消息云端快照更新失败：${e instanceof Error ? e.message : String(e)}`); }
        ledger.syncErrors = errors;
        const db = await openDB();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(DATE_DELETION_STORE, 'readwrite');
            tx.objectStore(DATE_DELETION_STORE).put(ledger);
            tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error);
        });
        return errors;
    }, true);
}
