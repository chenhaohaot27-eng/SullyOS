import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ImageGenerationConfig } from '../types';
import {
    ImageGenerationError,
    ImageGenerationService,
    normalizeImageGenerationResponse,
} from './imageGenerationService';

const baseConfig: ImageGenerationConfig = {
    version: 1,
    enabled: true,
    provider: 'gemini-native',
    baseUrl: 'https://generativelanguage.example',
    apiKey: 'super-secret-image-key',
    model: 'gemini-3-pro-image',
    defaultResolution: '2K',
    defaultAspectRatio: '1:1',
    allowReferenceImages: true,
    timeoutMs: 10_000,
};

const tinyBase64 = 'aGVsbG8taW1hZ2U=';

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
});

afterEach(() => vi.restoreAllMocks());

describe('imageGenerationService provider adapters', () => {
    it('constructs Gemini Native request with resolution, ratio, style, and multiple references', async () => {
        const fetchMock = vi.fn().mockResolvedValue(response({
            candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/webp', data: tinyBase64 } }] } }],
        }));
        const service = new ImageGenerationService({ fetchImpl: fetchMock as typeof fetch, loadConfig: () => baseConfig });
        const result = await service.generateImage({
            prompt: 'portrait',
            style: 'watercolor',
            resolution: '4K',
            aspectRatio: '3:2',
            referenceImages: [
                `data:image/png;base64,${tinyBase64}`,
                { data: tinyBase64, mimeType: 'image/jpeg' },
            ],
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('https://generativelanguage.example/v1beta/models/gemini-3-pro-image:generateContent');
        expect(new Headers(init.headers).get('x-goog-api-key')).toBe(baseConfig.apiKey);
        const body = JSON.parse(String(init.body));
        expect(body.generationConfig.imageConfig).toEqual({ aspectRatio: '3:2', imageSize: '4K' });
        expect(body.contents[0].parts[0].text).toContain('Style: watercolor');
        expect(body.contents[0].parts.slice(1)).toEqual([
            { inlineData: { mimeType: 'image/png', data: tinyBase64 } },
            { inlineData: { mimeType: 'image/jpeg', data: tinyBase64 } },
        ]);
        expect(result.images[0]).toMatchObject({ source: 'data-uri', mimeType: 'image/webp' });
    });

    it('constructs OpenAI-compatible Images request without provider branching in the caller', async () => {
        const config = { ...baseConfig, provider: 'openai-images' as const, baseUrl: 'https://images.example/v1', model: 'gpt-image-1' };
        const fetchMock = vi.fn().mockResolvedValue(response({ data: [{ url: 'https://cdn.example/generated.png' }] }));
        const service = new ImageGenerationService({ fetchImpl: fetchMock as typeof fetch, loadConfig: () => config });

        const result = await service.generateImage({ prompt: 'landscape', resolution: '2K', aspectRatio: '16:9' });
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('https://images.example/v1/images/generations');
        expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${config.apiKey}`);
        expect(JSON.parse(String(init.body))).toEqual({
            model: 'gpt-image-1',
            prompt: 'landscape',
            n: 1,
            size: '3648x2048',
            response_format: 'b64_json',
        });
        expect(result.images[0].url).toBe('https://cdn.example/generated.png');
    });

    it('rejects reference images explicitly when the selected adapter does not support them', async () => {
        const config = { ...baseConfig, provider: 'openai-images' as const };
        const fetchMock = vi.fn();
        const service = new ImageGenerationService({ fetchImpl: fetchMock as typeof fetch, loadConfig: () => config });

        await expect(service.generateImage({ prompt: 'x', referenceImages: [`data:image/png;base64,${tinyBase64}`] }))
            .rejects.toMatchObject({ code: 'REFERENCE_NOT_SUPPORTED' });
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe('image generation response normalization', () => {
    it('normalizes URL, raw base64, and data URI while rejecting blob URLs', () => {
        const images = normalizeImageGenerationResponse({ data: [
            { url: 'https://cdn.example/a.png' },
            { b64_json: tinyBase64, mime_type: 'image/jpeg' },
            { image: `data:image/webp;base64,${tinyBase64}` },
            { url: 'blob:https://app.example/temporary' },
        ] });

        expect(images).toEqual([
            { source: 'url', url: 'https://cdn.example/a.png', mimeType: 'image/png', revisedPrompt: undefined },
            { source: 'data-uri', url: `data:image/jpeg;base64,${tinyBase64}`, mimeType: 'image/jpeg', revisedPrompt: undefined },
            { source: 'data-uri', url: `data:image/webp;base64,${tinyBase64}`, mimeType: 'image/webp', revisedPrompt: undefined },
        ]);
        expect(normalizeImageGenerationResponse({ base64: tinyBase64.replace(/=+$/, '') })[0].url)
            .toBe(`data:image/png;base64,${tinyBase64}`);
    });
});

describe('image generation failure handling', () => {
    it('maps authentication and empty responses to stable errors', async () => {
        const authService = new ImageGenerationService({
            fetchImpl: vi.fn().mockResolvedValue(response({ error: { message: 'bad key' } }, 401)) as typeof fetch,
            loadConfig: () => baseConfig,
        });
        await expect(authService.generateImage({ prompt: 'x' })).rejects.toMatchObject({ code: 'AUTH', status: 401 });

        const emptyService = new ImageGenerationService({
            fetchImpl: vi.fn().mockResolvedValue(response({ candidates: [{ content: { parts: [{ text: 'no image' }] } }] })) as typeof fetch,
            loadConfig: () => baseConfig,
        });
        await expect(emptyService.generateImage({ prompt: 'x' })).rejects.toMatchObject({ code: 'EMPTY_RESPONSE' });
    });

    it('distinguishes timeout from caller cancellation', async () => {
        const abortingFetch = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
            if (init?.signal?.aborted) {
                reject(new DOMException('aborted', 'AbortError'));
                return;
            }
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        })) as unknown as typeof fetch;
        const timeoutService = new ImageGenerationService({ fetchImpl: abortingFetch, loadConfig: () => ({ ...baseConfig, timeoutMs: 5_000 }) });
        const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: TimerHandler) => {
            queueMicrotask(() => typeof handler === 'function' && handler());
            return 1 as unknown as ReturnType<typeof setTimeout>;
        }) as unknown as typeof setTimeout);
        const timed = timeoutService.generateImage({ prompt: 'x' });
        await expect(timed).rejects.toMatchObject({ code: 'TIMEOUT' });
        timeoutSpy.mockRestore();

        const controller = new AbortController();
        const cancelService = new ImageGenerationService({ fetchImpl: abortingFetch, loadConfig: () => baseConfig });
        const cancelled = cancelService.generateImage({ prompt: 'x', signal: controller.signal });
        controller.abort();
        await expect(cancelled).rejects.toMatchObject({ code: 'CANCELLED' });
    });

    it('never logs or exposes the complete API key in provider errors', async () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const service = new ImageGenerationService({
            fetchImpl: vi.fn().mockResolvedValue(response({ error: { message: `upstream echoed ${baseConfig.apiKey}` } }, 500)) as typeof fetch,
            loadConfig: () => baseConfig,
        });

        let thrown: unknown;
        try { await service.generateImage({ prompt: 'x' }); } catch (caught) { thrown = caught; }
        expect(thrown).toBeInstanceOf(ImageGenerationError);
        expect(String((thrown as Error).message)).not.toContain(baseConfig.apiKey);
        expect(log).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();
        expect(error).not.toHaveBeenCalled();
    });
});
