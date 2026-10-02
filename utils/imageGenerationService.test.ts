import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ImageGenerationConfig } from '../types';
import {
    buildImageGenerationModelsEndpoint,
    filterAvailableImageModels,
    ImageGenerationError,
    ImageGenerationService,
    normalizeAvailableImageModels,
    normalizeImageGenerationResponse,
    resolveImageModelSelection,
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

const response = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
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

describe('image generation model discovery', () => {
    it('parses OpenAI model lists and preserves unknown-capability models', async () => {
        const config = { ...baseConfig, provider: 'openai-images' as const, baseUrl: 'https://images.example/v1/' };
        const fetchMock = vi.fn().mockResolvedValue(response({ data: [
            { id: 'gpt-image-1', display_name: 'GPT Image 1', modalities: ['image'] },
            { id: 'vendor-custom-v2' },
        ] }));
        const service = new ImageGenerationService({ fetchImpl: fetchMock as typeof fetch });

        const models = await service.listAvailableModels(config);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('https://images.example/v1/models');
        expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${config.apiKey}`);
        expect(models).toEqual([
            expect.objectContaining({ id: 'gpt-image-1', displayName: 'GPT Image 1', provider: 'openai-images', imageCapability: 'confirmed', protocolCompatibility: ['openai-images'] }),
            expect.objectContaining({ id: 'vendor-custom-v2', imageCapability: 'unknown' }),
        ]);
    });

    it('parses Gemini model lists, cleans models/ prefixes, and keeps supported methods', async () => {
        const config = { ...baseConfig, baseUrl: 'https://gemini.example/v1beta/' };
        const fetchMock = vi.fn().mockResolvedValue(response({ models: [
            { name: 'models/imagen-4', displayName: 'Imagen 4', supportedGenerationMethods: ['predictImage'] },
            { name: 'models/gemini-custom', supportedGenerationMethods: ['generateContent'] },
        ] }));
        const service = new ImageGenerationService({ fetchImpl: fetchMock as typeof fetch });

        const models = await service.listAvailableModels(config);
        expect(fetchMock.mock.calls[0][0]).toBe('https://gemini.example/v1beta/models');
        expect(models[0]).toEqual(expect.objectContaining({
            id: 'imagen-4',
            displayName: 'Imagen 4',
            supportedMethods: ['predictImage'],
            imageCapability: 'confirmed',
        }));
        expect(models[1]).toEqual(expect.objectContaining({ id: 'gemini-custom', imageCapability: 'unknown' }));
    });

    it('joins model-list paths without duplicate v1/v1beta/models segments', () => {
        expect(buildImageGenerationModelsEndpoint({ provider: 'gemini-native', baseUrl: 'https://x.example' })).toBe('https://x.example/v1beta/models');
        expect(buildImageGenerationModelsEndpoint({ provider: 'gemini-native', baseUrl: 'https://x.example/v1/' })).toBe('https://x.example/v1/models');
        expect(buildImageGenerationModelsEndpoint({ provider: 'gemini-native', baseUrl: 'https://x.example/v1beta/models/' })).toBe('https://x.example/v1beta/models');
        expect(buildImageGenerationModelsEndpoint({ provider: 'openai-images', baseUrl: 'https://x.example/v1/images/generations/' })).toBe('https://x.example/v1/models');
        expect(buildImageGenerationModelsEndpoint({ provider: 'openai-images', baseUrl: 'https://x.example/v1/models/' })).toBe('https://x.example/v1/models');
    });

    it('returns empty lists and maps unsupported /models without disabling manual input fallback', async () => {
        const emptyService = new ImageGenerationService({
            fetchImpl: vi.fn().mockResolvedValue(response({ data: [] })) as typeof fetch,
        });
        await expect(emptyService.listAvailableModels({ ...baseConfig, provider: 'openai-images' })).resolves.toEqual([]);

        const unsupportedService = new ImageGenerationService({
            fetchImpl: vi.fn().mockResolvedValue(response({ error: { message: 'not found' } }, 404)) as typeof fetch,
        });
        await expect(unsupportedService.listAvailableModels(baseConfig)).rejects.toMatchObject({
            code: 'MODELS_UNSUPPORTED',
            status: 404,
        });
        expect(resolveImageModelSelection('', 'manual-image-model')).toBe('manual-image-model');
    });

    it('filters by provider, search text and image likelihood without deleting unknown models', () => {
        const gemini = normalizeAvailableImageModels({ models: [
            { name: 'models/gemini-3-pro-image' },
            { name: 'models/banana-render' },
            { name: 'models/gemini-custom' },
        ] }, 'gemini-native');
        const openAi = normalizeAvailableImageModels({ data: [{ id: 'flux-1' }] }, 'openai-images');
        const all = [...gemini, ...openAi];

        expect(filterAvailableImageModels(all, { provider: 'gemini-native', imageOnly: true }).map(model => model.id))
            .toEqual(['gemini-3-pro-image', 'banana-render']);
        expect(filterAvailableImageModels(all, { provider: 'gemini-native', imageOnly: false }).map(model => model.id))
            .toContain('gemini-custom');
        expect(filterAvailableImageModels(all, { provider: 'openai-images', query: 'FLUX', imageOnly: true }).map(model => model.id))
            .toEqual(['flux-1']);
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

    it('maps HTTP 429 and saturated upstream messages to a friendly retry/switch hint with request id', async () => {
        const service = new ImageGenerationService({
            fetchImpl: vi.fn().mockResolvedValue(response(
                { error: { message: '当前分组上游负载已饱和，请稍后再试' } },
                429,
                { 'x-request-id': 'req-image-busy-42' },
            )) as typeof fetch,
            loadConfig: () => baseConfig,
        });

        await expect(service.generateImage({ prompt: 'x' })).rejects.toMatchObject({
            code: 'RATE_LIMIT',
            status: 429,
            requestId: 'req-image-busy-42',
            message: expect.stringContaining('当前模型线路繁忙。你可以稍后重试，或刷新模型列表后切换其他生图模型。'),
        });

        const messageOnlyService = new ImageGenerationService({
            fetchImpl: vi.fn().mockResolvedValue(response({ message: 'rate limit; please retry later' }, 503)) as typeof fetch,
            loadConfig: () => baseConfig,
        });
        await expect(messageOnlyService.generateImage({ prompt: 'x' })).rejects.toMatchObject({ code: 'RATE_LIMIT', status: 503 });
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
