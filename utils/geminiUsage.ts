export interface NormalizedGeminiUsage {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    completion_tokens_details?: { reasoning_tokens: number };
}

/** Gemini reports candidate and thought tokens separately. OpenAI completion
 * usage includes both. Only explicit numeric counts may contribute; a difference
 * in total can also contain tool-use input and must never be guessed as reasoning. */
export function normalizeGeminiUsage(value: unknown): NormalizedGeminiUsage | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const usage = value as Record<string, unknown>;
    const count = (key: string): number | undefined => {
        const n = Object.prototype.hasOwnProperty.call(usage, key) ? usage[key] : undefined;
        return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined;
    };
    const prompt = count('promptTokenCount');
    const candidates = count('candidatesTokenCount');
    const thoughts = count('thoughtsTokenCount');
    const generated = candidates != null || thoughts != null ? (candidates ?? 0) + (thoughts ?? 0) : undefined;
    const completion = generated != null && Number.isFinite(generated) ? generated : undefined;
    // Preserve the provider's total, including zero. Tool-use prompt tokens are
    // input overhead: count them only in a fallback total, never in completion.
    const sum = prompt != null && completion != null
        ? prompt + completion + (count('toolUsePromptTokenCount') ?? 0) : undefined;
    const total = count('totalTokenCount') ?? (sum != null && Number.isFinite(sum) ? sum : undefined);
    if (prompt == null && completion == null && total == null && thoughts == null) return undefined;
    return {
        ...(prompt != null ? { prompt_tokens: prompt } : {}),
        ...(completion != null ? { completion_tokens: completion } : {}),
        ...(total != null ? { total_tokens: total } : {}),
        ...(thoughts != null ? { completion_tokens_details: { reasoning_tokens: thoughts } } : {}),
    };
}
