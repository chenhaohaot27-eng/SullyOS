import { describe, expect, it } from 'vitest';
import { normalizeGeminiUsage } from './geminiUsage';

describe('Gemini usage normalization', () => {
    it('includes explicit thoughts in completion and preserves the provider total', () => {
        expect(normalizeGeminiUsage({ promptTokenCount: 168, candidatesTokenCount: 1, thoughtsTokenCount: 107, totalTokenCount: 276 }))
            .toEqual({ prompt_tokens: 168, completion_tokens: 108, total_tokens: 276, completion_tokens_details: { reasoning_tokens: 107 } });
    });

    it('never infers missing reasoning from a total-token difference', () => {
        expect(normalizeGeminiUsage({ promptTokenCount: 168, candidatesTokenCount: 1, totalTokenCount: 276 }))
            .toEqual({ prompt_tokens: 168, completion_tokens: 1, total_tokens: 276 });
    });

    it('preserves an explicit zero reasoning count', () => {
        expect(normalizeGeminiUsage({ promptTokenCount: 194, candidatesTokenCount: 396, thoughtsTokenCount: 0, totalTokenCount: 590 }))
            .toEqual({ prompt_tokens: 194, completion_tokens: 396, total_tokens: 590, completion_tokens_details: { reasoning_tokens: 0 } });
    });

    it.each([-1, NaN, Infinity, -Infinity, '107', null, true, {}, []])('ignores invalid thoughtsTokenCount %j', thoughtsTokenCount => {
        expect(normalizeGeminiUsage({ promptTokenCount: 168, candidatesTokenCount: 1, thoughtsTokenCount, totalTokenCount: 276 }))
            .toEqual({ prompt_tokens: 168, completion_tokens: 1, total_tokens: 276 });
    });

    it('ignores inherited thought counts and does not mutate input', () => {
        const usage = Object.freeze(Object.assign(Object.create({ thoughtsTokenCount: 107 }), {
            promptTokenCount: 168, candidatesTokenCount: 1, totalTokenCount: 276,
        }));
        expect(normalizeGeminiUsage(usage)).toEqual({ prompt_tokens: 168, completion_tokens: 1, total_tokens: 276 });
        expect(Object.hasOwn(usage, 'thoughtsTokenCount')).toBe(false);
    });

    it('includes known thought and tool-use counts in a fallback total without mixing their roles', () => {
        const usage = { promptTokenCount: 10, candidatesTokenCount: 2, thoughtsTokenCount: 3, toolUsePromptTokenCount: 7 };
        expect(normalizeGeminiUsage(usage)).toEqual({
            prompt_tokens: 10, completion_tokens: 5, total_tokens: 22, completion_tokens_details: { reasoning_tokens: 3 },
        });
        expect(normalizeGeminiUsage({ ...usage, totalTokenCount: 99 })?.total_tokens).toBe(99);
        expect(normalizeGeminiUsage({ ...usage, totalTokenCount: 0 })?.total_tokens).toBe(0);
        expect(normalizeGeminiUsage({ promptTokenCount: 10, candidatesTokenCount: 2, toolUsePromptTokenCount: 7, totalTokenCount: 19 }))
            .toEqual({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 19 });
    });

    it('does not manufacture missing usage or reinterpret already-normalized OpenAI fields', () => {
        expect(normalizeGeminiUsage(undefined)).toBeUndefined();
        expect(normalizeGeminiUsage({})).toBeUndefined();
        expect(normalizeGeminiUsage({ prompt_tokens: 168, completion_tokens: 108, total_tokens: 276 })).toBeUndefined();
    });
});
