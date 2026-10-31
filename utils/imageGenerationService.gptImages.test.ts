import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ImageGenerationAspectRatio, ImageGenerationConfig, ImageGenerationResolution } from '../types';
import {
    DEFAULT_GPT_IMAGES_MODEL,
    GPT_IMAGE_MAX_ASPECT_RATIO,
    GPT_IMAGE_MAX_PIXELS,
    GPT_IMAGE_MAX_SIDE,
    GPT_IMAGE_MIN_ASPECT_RATIO,
    GPT_IMAGE_RECOMMENDED_SIZES,
    ImageGenerationService,
    isOfficialGptImageModel,
    OFFICIAL_GPT_IMAGES_BASE_URL,
    resolveGptImageSize,
} from './imageGenerationService';

/**
 * OpenAI 官方 GPT Images API（gpt-image-2.5-flare / gpt-image-2.5-sunburst）兼容性测试。
 * 全部使用 mock fetch，不会调用真实付费 API；apiKey 为编造的占位值。
 */
const officialConfig: ImageGenerationConfig = {
    version: 1,
    enabled: true,
    provider: 'gpt-images',
    baseUrl: OFFICIAL_GPT_IMAGES_BASE_URL,
    apiKey: 'sk-test-placeholder-not-real',
    model: DEFAULT_GPT_IMAGES_MODEL,
    defaultResolution: '1K',
    defaultAspectRatio: '1:1',
    allowReferenceImages: true,
    timeoutMs: 180_000,
    authMode: 'api-key',
};

const tinyBase64 = 'aGVsbG8taW1hZ2U=';

const response = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
});

afterEach(() => vi.restoreAllMocks());

describe('official GPT Images model detection', () => {
    it('recognizes gpt-image-* as official models and rejects everything else', () => {
        expect(isOfficialGptImageModel('gpt-image-2.5-flare')).toBe(true);
        expect(isOfficialGptImageModel('gpt-image-2.5-sunburst')).toBe(true);
        expect(isOfficialGptImageModel('gpt-image-1')).toBe(true);
        expect(isOfficialGptImageModel(' GPT-IMAGE-2.5-FLARE ')).toBe(true);
        expect(isOfficialGptImageModel('dall-e-3')).toBe(false);
        expect(isOfficialGptImageModel('gpt-4o')).toBe(false);
        expect(isOfficialGptImageModel('my-gpt-image-proxy')).toBe(false);
        expect(isOfficialGptImageModel('flux-dev')).toBe(false);
    });
});

describe('official GPT Images text-to-image (/images/generations)', () => {
    it('Flare: sends output_format instead of response_format and hits official recommended size', async () => {
        const fetchMock = vi.fn().mockResolvedValue(response({ data: [{ b64_json: tinyBase64 }] }));
        const service = new ImageGenerationService({ fetchImpl: fetchMock as typeof fetch, loadConfig: () => officialConfig });

        const result = await service.generateImage({ prompt: 'a magenta circle', resolution: '1K', aspectRatio: '1:1' });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('https://api.openai.com/v1/images/generations');
        expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${officialConfig.apiKey}`);
        const body = JSON.parse(String(init.body));
        expect(body).toEqual({
            model: 'gpt-image-2.5-flare',
            prompt: 'a magenta circle',
            n: 1,
            size: '1024x1024',
            output_format: 'png',
        });
        expect(body.response_format).toBeUndefined();
        // data[].b64_json → data-uri PNG
        expect(result.images[0]).toMatchObject({ source: 'data-uri', mimeType: 'image/png' });
        expect(result.images[0].url).toBe(`data:image/png;base64,${tinyBase64}`);
    });

    it('Sunburst: manual model input works and 2K 3:2 maps to 3072x2048', async () => {
        const config = { ...officialConfig, model: 'gpt-image-2.5-sunburst' };
        const fetchMock = vi.fn().mockResolvedValue(response({ data: [{ b64_json: tinyBase64 }] }));
        const service = new ImageGenerationService({ fetchImpl: fetchMock as typeof fetch, loadConfig: () => config });

        await service.generateImage({ prompt: 'sunset', resolution: '2K', aspectRatio: '3:2' });
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('https://api.openai.com/v1/images/generations');
        const body = JSON.parse(String(init.body));
        expect(body).toEqual({
            model: 'gpt-image-2.5-sunburst',
            prompt: 'sunset',
            n: 1,
            size: '3072x2048',
            output_format: 'png',
        });
        expect(body.response_format).toBeUndefined();
    });

    it('parses revised_prompt and keeps n=1 single image logic for portrait 2:3', async () => {
        const fetchMock = vi.fn().mockResolvedValue(response({
            data: [{ b64_json: tinyBase64, revised_prompt: 'a brighter magenta circle' }],
        }));
        const service = new ImageGenerationService({ fetchImpl: fetchMock as typeof fetch, loadConfig: () => officialConfig });

        const result = await service.generateImage({ prompt: 'x', resolution: '1K', aspectRatio: '2:3' });
        expect(result.images).toHaveLength(1);
        expect(result.images[0].revisedPrompt).toBe('a brighter magenta circle');
        const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
        expect(body.size).toBe('1024x1536');
        expect(body.n).toBe(1);
    });
});

describe('official GPT Images reference edits (/images/edits)', () => {
    it('single reference: uses image field, keeps jpeg extension, no manual multipart content-type', async () => {
        const fetchMock = vi.fn().mockResolvedValue(response({ data: [{ b64_json: tinyBase64 }] }));
        const service = new ImageGenerationService({ fetchImpl: fetchMock as typeof fetch, loadConfig: () => officialConfig });

        await service.generateImage({
            prompt: 'put this person at the beach',
            resolution: '1K',
            aspectRatio: '1:1',
            referenceImages: [{ data: tinyBase64, mimeType: 'image/jpeg' }],
        });

        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('https://api.openai.com/v1/images/edits');
        expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${officialConfig.apiKey}`);
        // multipart Content-Type 必须由运行时生成 boundary，绝不手动设置
        expect(new Headers(init.headers).get('content-type')).toBeNull();
        expect(init.body).toBeInstanceOf(FormData);

        const formData = init.body as FormData;
        expect(formData.get('model')).toBe('gpt-image-2.5-flare');
        expect(formData.get('n')).toBe('1');
        expect(formData.get('size')).toBe('1024x1024');
        expect(formData.get('output_format')).toBe('png');
        expect(formData.get('response_format')).toBeNull();
        const image = formData.get('image') as File;
        expect(image).toBeInstanceOf(Blob);
        expect(image.type).toBe('image/jpeg');
        expect(image.name).toBe('reference_0.jpg');
        // 多图专用字段在单图时不应出现
        expect(formData.getAll('image[]')).toHaveLength(0);
    });

    it('multiple references: uses image[] fields with original MIME types and extensions', async () => {
        const fetchMock = vi.fn().mockResolvedValue(response({ data: [{ b64_json: tinyBase64 }] }));
        const service = new ImageGenerationService({ fetchImpl: fetchMock as typeof fetch, loadConfig: () => officialConfig });

        await service.generateImage({
            prompt: 'combine these two references',
            resolution: '1K',
            aspectRatio: '3:2',
            referenceImages: [
                `data:image/png;base64,${tinyBase64}`,
                { data: tinyBase64, mimeType: 'image/webp' },
                { data: tinyBase64, mimeType: 'image/jpeg' },
            ],
        });

        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('https://api.openai.com/v1/images/edits');
        const formData = init.body as FormData;
        expect(formData.get('size')).toBe('1536x1024');
        const images = formData.getAll('image[]');
        expect(images).toHaveLength(3);
        expect((images[0] as File).name).toBe('reference_0.png');
        expect((images[0] as File).type).toBe('image/png');
        expect((images[1] as File).name).toBe('reference_1.webp');
        expect((images[1] as File).type).toBe('image/webp');
        expect((images[2] as File).name).toBe('reference_2.jpg');
        expect(formData.getAll('image')).toHaveLength(0);
    });

    it('legacy dall-e-3 keeps response_format and repeated image fields (third-party compatibility)', async () => {
        const config = { ...officialConfig, model: 'dall-e-3' };
        const fetchMock = vi.fn().mockResolvedValue(response({ data: [{ b64_json: tinyBase64 }] }));
        const service = new ImageGenerationService({ fetchImpl: fetchMock as typeof fetch, loadConfig: () => config });

        await service.generateImage({
            prompt: 'legacy path',
            resolution: '2K',
            aspectRatio: '1:1',
            referenceImages: [`data:image/png;base64,${tinyBase64}`, { data: tinyBase64, mimeType: 'image/jpeg' }],
        });

        const formData = (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as FormData;
        expect(formData.get('response_format')).toBe('b64_json');
        expect(formData.get('output_format')).toBeNull();
        expect(formData.getAll('image')).toHaveLength(2);
        expect(formData.getAll('image[]')).toHaveLength(0);
    });
});

describe('GPT Image 2.5 size mapping', () => {
    const ALL_RATIOS: ImageGenerationAspectRatio[] = ['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16'];
    const ALL_RESOLUTIONS: ImageGenerationResolution[] = ['1K', '2K', '4K'];

    it('1K recommended ratios hit the official sizes exactly', () => {
        expect(`${resolveGptImageSize('1K', '1:1').width}x${resolveGptImageSize('1K', '1:1').height}`).toBe('1024x1024');
        const landscape = resolveGptImageSize('1K', '3:2');
        expect(`${landscape.width}x${landscape.height}`).toBe('1536x1024');
        expect(GPT_IMAGE_RECOMMENDED_SIZES).toContain('1536x1024');
        const portrait = resolveGptImageSize('1K', '2:3');
        expect(`${portrait.width}x${portrait.height}`).toBe('1024x1536');
        expect(landscape.aspectRatioClamped).toBe(false);
        expect(portrait.aspectRatioClamped).toBe(false);
    });

    it('maps other in-range ratios to valid custom sizes (4:3 → 1360x1024)', () => {
        const size = resolveGptImageSize('1K', '4:3');
        expect(`${size.width}x${size.height}`).toBe('1360x1024');
        expect(size.aspectRatioClamped).toBe(false);
        expect(size.experimental).toBe(false);
    });

    it('clamps out-of-range ratios (16:9 / 9:16) to the closest supported ratio instead of failing silently', () => {
        const wide = resolveGptImageSize('1K', '16:9');
        expect(`${wide.width}x${wide.height}`).toBe('1536x1024');
        expect(wide.aspectRatioClamped).toBe(true);
        const tall = resolveGptImageSize('2K', '9:16');
        expect(`${tall.width}x${tall.height}`).toBe('2048x3072');
        expect(tall.aspectRatioClamped).toBe(true);
    });

    it('4K respects the 3840 side cap and 8,294,400 pixel cap (no more 4096x4096)', () => {
        const square = resolveGptImageSize('4K', '1:1');
        expect(`${square.width}x${square.height}`).toBe('2880x2880');
        expect(square.width * square.height).toBeLessThanOrEqual(GPT_IMAGE_MAX_PIXELS);
        expect(square.experimental).toBe(true);

        const landscape = resolveGptImageSize('4K', '3:2');
        expect(`${landscape.width}x${landscape.height}`).toBe('3520x2352');
        expect(landscape.width * landscape.height).toBeLessThanOrEqual(GPT_IMAGE_MAX_PIXELS);
    });

    it('every resolution/ratio combination stays inside official constraints', () => {
        for (const resolution of ALL_RESOLUTIONS) {
            for (const aspectRatio of ALL_RATIOS) {
                const size = resolveGptImageSize(resolution, aspectRatio);
                expect(size.width % 16).toBe(0);
                expect(size.height % 16).toBe(0);
                expect(size.width).toBeLessThanOrEqual(GPT_IMAGE_MAX_SIDE);
                expect(size.height).toBeLessThanOrEqual(GPT_IMAGE_MAX_SIDE);
                expect(size.width * size.height).toBeLessThanOrEqual(GPT_IMAGE_MAX_PIXELS);
                const ratio = size.width / size.height;
                expect(ratio).toBeLessThanOrEqual(GPT_IMAGE_MAX_ASPECT_RATIO + 1e-9);
                expect(ratio).toBeGreaterThanOrEqual(GPT_IMAGE_MIN_ASPECT_RATIO - 1e-9);
            }
        }
    });
});

describe('official GPT Images error handling', () => {
    it('surfaces 401/403 provider detail (invalid key / model unauthorized / org verification)', async () => {
        const fetchMock = vi.fn().mockResolvedValue(response({
            error: { message: 'Your organization must be verified to use this model' },
        }, 403));
        const service = new ImageGenerationService({ fetchImpl: fetchMock as typeof fetch, loadConfig: () => officialConfig });

        await expect(service.generateImage({ prompt: 'x' })).rejects.toMatchObject({
            code: 'AUTH',
            status: 403,
            message: expect.stringContaining('organization must be verified'),
        });
    });

    it('distinguishes quota/billing 429 from generic busy lines', async () => {
        const fetchMock = vi.fn().mockResolvedValue(response({
            error: { message: 'You exceeded your current quota, please check your plan and billing details' },
        }, 429));
        const service = new ImageGenerationService({ fetchImpl: fetchMock as typeof fetch, loadConfig: () => officialConfig });

        await expect(service.generateImage({ prompt: 'x' })).rejects.toMatchObject({
            code: 'RATE_LIMIT',
            status: 429,
            message: expect.stringContaining('额度不足'),
        });
    });

    it('reports timeout without retrying or leaking the API key', async () => {
        const abortingFetch = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
            if (init?.signal?.aborted) {
                reject(new DOMException('aborted', 'AbortError'));
                return;
            }
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        })) as unknown as typeof fetch;
        const service = new ImageGenerationService({
            fetchImpl: abortingFetch,
            loadConfig: () => ({ ...officialConfig, timeoutMs: 180_000 }),
        });
        const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: TimerHandler) => {
            queueMicrotask(() => typeof handler === 'function' && handler());
            return 1 as unknown as ReturnType<typeof setTimeout>;
        }) as unknown as typeof setTimeout);

        try {
            await expect(service.generateImage({ prompt: 'x' })).rejects.toMatchObject({ code: 'TIMEOUT' });
        } finally {
            timeoutSpy.mockRestore();
        }
        expect(abortingFetch).toHaveBeenCalledTimes(1); // 不自动重试，避免重复计费
    });
});



