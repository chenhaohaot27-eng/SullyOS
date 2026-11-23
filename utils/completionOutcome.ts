type FinishKind = 'complete' | 'tool' | 'limit' | 'interrupted' | 'unreported';

export function completionOutcome(response: unknown): { kind: FinishKind; reason: string | null } {
    const data = response as {
        error?: unknown;
        choices?: Array<{ finish_reason?: unknown; finishReason?: unknown }>;
        stream_incomplete?: boolean;
    } | null;
    if (data?.error || data?.stream_incomplete) return {
        kind: 'interrupted', reason: data.error ? 'upstream_error' : 'stream_incomplete',
    };
    const value = data?.choices?.[0]?.finish_reason ?? data?.choices?.[0]?.finishReason;
    const reason = typeof value === 'string' ? value.trim().toLowerCase().slice(0, 80) : '';
    if (!reason || reason === 'finish_reason_unspecified') return { kind: 'unreported', reason: null };
    if (['stop', 'end_turn', 'stop_sequence', 'done'].includes(reason)) return { kind: 'complete', reason };
    if (['tool_calls', 'function_call', 'tool_use'].includes(reason)) return { kind: 'tool', reason };
    if (['length', 'max_tokens', 'max_output_tokens'].includes(reason)) return { kind: 'limit', reason };
    return { kind: 'interrupted', reason };
}

export function assertCompletionDelivered(response: unknown): void {
    const outcome = completionOutcome(response);
    if (outcome.kind === 'interrupted') {
        throw new Error(`模型回复未完整结束（${outcome.reason}）`);
    }
}
