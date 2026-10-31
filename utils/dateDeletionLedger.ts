/** Durable tombstones live outside backup-replaced stores. Never match by date/text. */
export const DATE_DELETION_STORE = 'date_deletion_ledger';
export interface DeletionLedger {
    charId: string;
    messageIds: number[];
    nodeIds: string[];
    unresolvedNodeIds?: string[];
    /** Rebuilt rows: reject stale snapshots, allow subsequent edits based on the new revision. */
    replacements: Record<string, Record<string, any>>;
    remotePending: string[];
    cloudPending: boolean;
    revision: number;
    warnings?: string[];
    syncErrors?: string[];
    invalidDateStateBefore?: number;
}
export function sanitizeDeletedRow(store: string, row: any, ledgers: DeletionLedger[]): any | undefined {
    if (!row) return row;
    const ledger = ledgers.find(l => l.charId === (store === 'characters' ? row.id : row.charId))
        || (store === 'memory_vectors' && !row.charId ? ledgers.find(l => l.nodeIds.includes(row.memoryId) || l.replacements.memory_nodes?.[row.memoryId]) : undefined);
    if (store === 'memory_links') {
        return ledgers.some(l => l.nodeIds.includes(row.sourceId) || l.nodeIds.includes(row.targetId)) ? undefined : row;
    }
    if (!ledger) return row;
    if (store === 'messages' && !row.groupId && row.metadata?.source === 'date' && ledger.messageIds.includes(row.id)) return undefined;
    if (store === 'memory_vectors' && (ledger.nodeIds.includes(row.memoryId) || ((row.deletionRevision || 0) < (ledger.replacements.memory_nodes?.[row.memoryId]?.deletionRevision || 0)))) return undefined;
    if (store === 'memory_nodes') {
        if (ledger.nodeIds.includes(row.id) || (row.sourceId && ledger.nodeIds.includes(row.sourceId))) return undefined;
        const replacement = ledger.replacements[store]?.[row.id];
        if (replacement && (row.deletionRevision || 0) < replacement.deletionRevision) return replacement;
        const ids: number[] = row.sourceMessageIds || [];
        if (ids.some(id => ledger.messageIds.includes(id)) && !ledger.unresolvedNodeIds?.includes(row.id)) return undefined;
    }
    const replacement = ledger.replacements[store]?.[row.id];
    if (replacement && (row.deletionRevision || 0) < replacement.deletionRevision) return replacement;
    if (store === 'characters') {
        const changes = ledger.replacements.fragments || {};
        return { ...row, savedDateState: row.savedDateState && ((row.savedDateState.sourceMessageId && ledger.messageIds.includes(row.savedDateState.sourceMessageId)) || row.savedDateState.timestamp <= (ledger.invalidDateStateBefore || 0)) ? undefined : row.savedDateState, memories: (row.memories || []).flatMap((m: any) => {
            const change = changes[m.id];
            if (change === null) return [];
            if (change && (m.deletionRevision || 0) < change.deletionRevision) return [change];
            // Rebuild only known bullets, retaining unrelated and legacy material.
            if (m.sourceEntries && m.sourceMemoryIds?.some((id: string) => ledger.nodeIds.includes(id) || ledger.replacements.memory_nodes?.[id])) {
                const entries = m.sourceEntries.flatMap((e: any) => ledger.nodeIds.includes(e.memoryId) ? [] : [{ ...e, text: ledger.replacements.memory_nodes?.[e.memoryId]?.content || e.text }]);
                if (!entries.length && !m.legacySummary) return [];
                return [{ ...m, sourceEntries: entries, sourceMemoryIds: entries.map((e: any) => e.memoryId),
                    summary: [m.legacySummary, ...entries.map((e: any) => `- ${e.text.replace(/\n/g, ' ')}`)].filter(Boolean).join('\n'), deletionRevision: ledger.revision }];
            }
            return [m];
        }) };
    }
    return row;
}
export function guardedPut(tx: IDBTransaction, store: string, row: any): void {
    const req = tx.objectStore(DATE_DELETION_STORE).getAll();
    req.onsuccess = () => {
        const safe = sanitizeDeletedRow(store, row, req.result);
        if (safe !== undefined) tx.objectStore(store).put(safe);
    };
}
