import { describe, expect, it } from 'vitest';
import {
    formatImageGenerationRequestLog,
    getImageGenerationLogMeta,
    sanitizeImageGenerationLogText,
    withImageGenerationLogMeta,
} from './imageGenerationLogging';

describe('image generation request logging', () => {
    it('records image request dimensions and provider without chat-only undefined fields', () => {
        const init = withImageGenerationLogMeta({ method: 'POST' }, {
            operation: 'generate',
            provider: 'gemini-native',
            model: 'gemini-3-pro-image',
            resolution: '2K',
            aspectRatio: '16:9',
            referenceImageCount: 3,
        });
        const summary = formatImageGenerationRequestLog(getImageGenerationLogMeta(init)!);

        expect(summary).toContain('image model: gemini-3-pro-image');
        expect(summary).toContain('provider/protocol: gemini-native');
        expect(summary).toContain('resolution: 2K');
        expect(summary).toContain('aspect ratio: 16:9');
        expect(summary).toContain('reference images: 3');
        expect(summary).not.toContain('model: undefined');
        expect(summary).not.toContain('messages(0)');
    });

    it('redacts API keys, complete prompts and reference base64 from provider error logs', () => {
        const apiKey = 'secret-image-api-key-123';
        const prompt = 'a private portrait prompt that must not enter logs';
        const base64 = 'aGVsbG8taW1hZ2U=';
        const body = JSON.stringify({
            contents: [{ parts: [
                { text: prompt },
                { inlineData: { mimeType: 'image/png', data: base64 } },
            ] }],
        });
        const init = withImageGenerationLogMeta({
            method: 'POST',
            headers: { 'x-goog-api-key': apiKey },
            body,
        }, {
            operation: 'generate',
            provider: 'gemini-native',
            model: 'gemini-image',
            resolution: '2K',
            aspectRatio: '1:1',
            referenceImageCount: 1,
        });
        const logged = sanitizeImageGenerationLogText(
            `upstream echoed key=${apiKey}; prompt=${prompt}; image=data:image/png;base64,${base64}`,
            init,
            body,
        );

        expect(logged).not.toContain(apiKey);
        expect(logged).not.toContain(prompt);
        expect(logged).not.toContain(base64);
        expect(logged).toContain('[REDACTED]');
    });
});
