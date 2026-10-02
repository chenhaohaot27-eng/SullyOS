import { describe, it, expect, beforeEach } from 'vitest';
import {
    extractProactiveAction,
    canExecuteProactiveAction,
    recordProactiveAction,
    getRemainingCooldown,
    resetProactiveActionCooldownForTests,
} from './proactiveAction';

describe('proactiveAction', () => {
    beforeEach(() => {
        resetProactiveActionCooldownForTests();
    });

    describe('extractProactiveAction', () => {
        it('should extract PHOTO action with all fields', () => {
            const content = `这是正常对话
[[PROACTIVE_ACTION: {"kind":"PHOTO","prompt":"A beautiful sunset over the ocean","caption":"Look at this view!","includeCharacter":true,"style":"photorealistic"}]]`;
            const result = extractProactiveAction(content);
            expect(result.action).toEqual({
                kind: 'PHOTO',
                prompt: 'A beautiful sunset over the ocean',
                caption: 'Look at this view!',
                includeCharacter: true,
                style: 'photorealistic',
            });
            expect(result.cleanedContent).toBe('这是正常对话');
            expect(result.invalidTagFound).toBe(false);
        });

        it('should extract PHOTO action with minimal fields', () => {
            const content = `[[PROACTIVE_ACTION: {"kind":"PHOTO","prompt":"Test photo"}]]`;
            const result = extractProactiveAction(content);
            expect(result.action).toEqual({
                kind: 'PHOTO',
                prompt: 'Test photo',
                caption: '',
                includeCharacter: false,
                style: '',
            });
            expect(result.cleanedContent).toBe('');
            expect(result.invalidTagFound).toBe(false);
        });

        it('should extract NONE action', () => {
            const content = `正常对话
[[PROACTIVE_ACTION: {"kind":"NONE"}]]`;
            const result = extractProactiveAction(content);
            expect(result.action).toEqual({ kind: 'NONE' });
            expect(result.cleanedContent).toBe('正常对话');
            expect(result.invalidTagFound).toBe(false);
        });

        it('should handle case-insensitive kind', () => {
            const content = `[[PROACTIVE_ACTION: {"kind":"photo","prompt":"Test"}]]`;
            const result = extractProactiveAction(content);
            expect(result.action?.kind).toBe('PHOTO');
        });

        it('should handle fenced JSON (```json wrapper)', () => {
            const content = `正常对话
[[PROACTIVE_ACTION: \`\`\`json
{"kind":"PHOTO","prompt":"Test photo"}
\`\`\`]]`;
            const result = extractProactiveAction(content);
            expect(result.action?.kind).toBe('PHOTO');
            expect(result.action?.prompt).toBe('Test photo');
        });

        it('should handle full-width colon', () => {
            const content = `[[PROACTIVE_ACTION：{"kind":"PHOTO","prompt":"Test"}]]`;
            const result = extractProactiveAction(content);
            expect(result.action?.kind).toBe('PHOTO');
        });

        it('should return null for invalid JSON', () => {
            const content = `[[PROACTIVE_ACTION: {invalid json}]]`;
            const result = extractProactiveAction(content);
            expect(result.action).toBeNull();
            expect(result.cleanedContent).toBe('');
            expect(result.invalidTagFound).toBe(true);
        });

        it('should return null for PHOTO without prompt', () => {
            const content = `[[PROACTIVE_ACTION: {"kind":"PHOTO"}]]`;
            const result = extractProactiveAction(content);
            expect(result.action).toBeNull();
            expect(result.invalidTagFound).toBe(true);
        });

        it('should return null for PHOTO with empty prompt', () => {
            const content = `[[PROACTIVE_ACTION: {"kind":"PHOTO","prompt":"   "}]]`;
            const result = extractProactiveAction(content);
            expect(result.action).toBeNull();
            expect(result.invalidTagFound).toBe(true);
        });

        it('should return null for unknown action kind', () => {
            const content = `[[PROACTIVE_ACTION: {"kind":"UNKNOWN"}]]`;
            const result = extractProactiveAction(content);
            expect(result.action).toBeNull();
            expect(result.invalidTagFound).toBe(true);
        });

        it('should handle no tags (normal chat)', () => {
            const content = `这是正常聊天内容，没有任何标签`;
            const result = extractProactiveAction(content);
            expect(result.action).toBeNull();
            expect(result.cleanedContent).toBe(content);
            expect(result.invalidTagFound).toBe(false);
        });

        it('should only accept first valid tag when multiple tags exist', () => {
            const content = `[[PROACTIVE_ACTION: {"kind":"PHOTO","prompt":"First"}]]
[[PROACTIVE_ACTION: {"kind":"PHOTO","prompt":"Second"}]]`;
            const result = extractProactiveAction(content);
            expect(result.action?.prompt).toBe('First');
            expect(result.cleanedContent).toBe('');
        });

        it('should strip all tags including invalid ones', () => {
            const content = `正常对话
[[PROACTIVE_ACTION: {invalid}]]
更多对话
[[PROACTIVE_ACTION: {"kind":"PHOTO","prompt":"Valid"}]]`;
            const result = extractProactiveAction(content);
            expect(result.action?.prompt).toBe('Valid');
            expect(result.cleanedContent).toBe('正常对话\n更多对话');
        });

        it('should truncate long prompt to MAX_PROMPT_LENGTH', () => {
            const longPrompt = 'A'.repeat(1500);
            const content = `[[PROACTIVE_ACTION: {"kind":"PHOTO","prompt":"${longPrompt}"}]]`;
            const result = extractProactiveAction(content);
            expect(result.action?.prompt?.length).toBe(1200); // MAX_PROMPT_LENGTH
        });

        it('should truncate long caption to MAX_CAPTION_LENGTH', () => {
            const longCaption = 'B'.repeat(300);
            const content = `[[PROACTIVE_ACTION: {"kind":"PHOTO","prompt":"Test","caption":"${longCaption}"}]]`;
            const result = extractProactiveAction(content);
            expect(result.action?.caption?.length).toBe(200); // MAX_CAPTION_LENGTH
        });

        it('should collapse multiple newlines after stripping tags', () => {
            const content = `正常对话

[[PROACTIVE_ACTION: {"kind":"PHOTO","prompt":"Test"}]]


更多对话`;
            const result = extractProactiveAction(content);
            expect(result.cleanedContent).toBe('正常对话\n更多对话');
        });
    });

    describe('cooldown management', () => {
        const charId = 'test-char-123';

        it('should allow execution when no cooldown exists', () => {
            expect(canExecuteProactiveAction(charId, 'PHOTO')).toBe(true);
        });

        it('should block execution within cooldown period', () => {
            const now = Date.now();
            recordProactiveAction(charId, 'PHOTO', now);
            expect(canExecuteProactiveAction(charId, 'PHOTO', now + 1000)).toBe(false);
        });

        it('should allow execution after cooldown expires', () => {
            const now = Date.now();
            const cooldownMs = 24 * 60 * 60 * 1000; // 24 hours
            recordProactiveAction(charId, 'PHOTO', now);
            expect(canExecuteProactiveAction(charId, 'PHOTO', now + cooldownMs)).toBe(true);
        });

        it('should isolate cooldown by character', () => {
            const now = Date.now();
            recordProactiveAction('char-1', 'PHOTO', now);
            expect(canExecuteProactiveAction('char-1', 'PHOTO', now + 1000)).toBe(false);
            expect(canExecuteProactiveAction('char-2', 'PHOTO', now + 1000)).toBe(true);
        });

        it('should isolate cooldown by action kind', () => {
            const now = Date.now();
            recordProactiveAction(charId, 'PHOTO', now);
            expect(canExecuteProactiveAction(charId, 'PHOTO', now + 1000)).toBe(false);
            // Future action types would be independent
        });

        it('should return 0 cooldown for NONE action', () => {
            expect(canExecuteProactiveAction(charId, 'NONE')).toBe(false);
            expect(getRemainingCooldown(charId, 'NONE')).toBe(0);
        });

        it('should calculate remaining cooldown correctly', () => {
            const now = Date.now();
            const cooldownMs = 24 * 60 * 60 * 1000;
            recordProactiveAction(charId, 'PHOTO', now);

            const elapsed = 60 * 60 * 1000; // 1 hour
            const remaining = getRemainingCooldown(charId, 'PHOTO', now + elapsed);
            expect(remaining).toBe(cooldownMs - elapsed);
        });

        it('should return 0 remaining cooldown after expiry', () => {
            const now = Date.now();
            const cooldownMs = 24 * 60 * 60 * 1000;
            recordProactiveAction(charId, 'PHOTO', now);

            const remaining = getRemainingCooldown(charId, 'PHOTO', now + cooldownMs + 1000);
            expect(remaining).toBe(0);
        });

        it('should return 0 remaining cooldown when no record exists', () => {
            expect(getRemainingCooldown(charId, 'PHOTO')).toBe(0);
        });

        it('should not record cooldown for NONE action', () => {
            const now = Date.now();
            recordProactiveAction(charId, 'NONE', now);
            expect(canExecuteProactiveAction(charId, 'NONE', now + 1000)).toBe(false);
        });
    });

    describe('edge cases', () => {
        it('should handle empty content', () => {
            const result = extractProactiveAction('');
            expect(result.action).toBeNull();
            expect(result.cleanedContent).toBe('');
            expect(result.invalidTagFound).toBe(false);
        });

        it('should handle content with only whitespace', () => {
            const result = extractProactiveAction('   \n\n   ');
            expect(result.action).toBeNull();
            expect(result.cleanedContent).toBe('');
            expect(result.invalidTagFound).toBe(false);
        });

        it('should handle tag with missing kind field', () => {
            const content = `[[PROACTIVE_ACTION: {"prompt":"Test"}]]`;
            const result = extractProactiveAction(content);
            expect(result.action).toBeNull();
            expect(result.invalidTagFound).toBe(true);
        });

        it('should handle tag with non-string kind', () => {
            const content = `[[PROACTIVE_ACTION: {"kind":123,"prompt":"Test"}]]`;
            const result = extractProactiveAction(content);
            expect(result.action).toBeNull();
            expect(result.invalidTagFound).toBe(true);
        });

        it('should handle tag with array payload', () => {
            const content = `[[PROACTIVE_ACTION: ["not","an","object"]]]`;
            const result = extractProactiveAction(content);
            expect(result.action).toBeNull();
            expect(result.invalidTagFound).toBe(true);
        });

        it('should handle tag with null payload', () => {
            const content = `[[PROACTIVE_ACTION: null]]`;
            const result = extractProactiveAction(content);
            expect(result.action).toBeNull();
            expect(result.invalidTagFound).toBe(true);
        });
    });
});
