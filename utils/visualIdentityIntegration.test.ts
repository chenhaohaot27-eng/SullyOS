import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DB } from './db';
import { ImageGenerationService } from './imageGenerationService';
import type { CharacterProfile, VisualIdentity, ImageGenerationConfig } from '../types';
import { putImageBlob } from './blobRef';

/** Blob 内容 → base64（inlineData.data 的编码格式） */
const b64 = (s: string) => Buffer.from(s, 'utf-8').toString('base64');

describe('Visual Identity Integration', () => {
    let mockFetch: ReturnType<typeof vi.fn>;
    let service: ImageGenerationService;
    // Node 的 URL.createObjectURL 生成 blob:nodedata:<uuid>（不含 blobref id），
    // 打补丁记录 url → Blob 映射，mock 才能按内容区分不同参考图。
    let urlToBlob: Map<string, Blob>;
    let origCreateObjectURL: typeof URL.createObjectURL;
    const mockConfig: ImageGenerationConfig = {
        enabled: true,
        provider: 'gemini-native',
        baseUrl: 'https://test.api',
        apiKey: 'test-key',
        model: 'test-model',
        defaultResolution: '1K',
        defaultAspectRatio: '1:1',
        allowReferenceImages: true,
        timeoutMs: 30000,
    };

    beforeEach(async () => {
        await DB.deleteDB();
        mockFetch = vi.fn();
        service = new ImageGenerationService({
            fetchImpl: mockFetch,
            loadConfig: () => mockConfig,
        });
        urlToBlob = new Map();
        origCreateObjectURL = URL.createObjectURL;
        URL.createObjectURL = ((blob: Blob) => {
            const url = origCreateObjectURL(blob);
            urlToBlob.set(url, blob);
            return url;
        }) as typeof URL.createObjectURL;
    });

    afterEach(() => {
        URL.createObjectURL = origCreateObjectURL;
    });

    it('generates without visualIdentity when characterId not provided', async () => {
        mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
            candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'base64data' } }] } }],
        }), { status: 200 }));

        const result = await service.generateImage({ prompt: 'test scene' });
        expect(result.images).toHaveLength(1);
        expect(mockFetch).toHaveBeenCalledTimes(1);
        const callArgs = mockFetch.mock.calls[0];
        const body = JSON.parse(callArgs[1].body);
        expect(body.contents[0].parts[0].text).toBe('test scene');
    });

    it('generates without visualIdentity when character has none', async () => {
        await DB.saveCharacter({ id: 'char1', name: 'Test', prompt: 'test' } as any);

        mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
            candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'base64data' } }] } }],
        }), { status: 200 }));

        const result = await service.generateImage({ prompt: 'test scene', characterId: 'char1' });
        expect(result.images).toHaveLength(1);
        const callArgs = mockFetch.mock.calls[0];
        const body = JSON.parse(callArgs[1].body);
        expect(body.contents[0].parts[0].text).toBe('test scene');
    });

    it('generates without visualIdentity when enabled is false', async () => {
        const vi: VisualIdentity = {
            enabled: false,
            mode: 'simple',
            references: [
                { id: 'ref1', role: 'primary-face', blobRef: 'blobref:test', isPrimary: true, createdAt: Date.now() },
            ],
        };
        await DB.saveCharacter({ id: 'char2', name: 'Test', prompt: 'test', visualIdentity: vi } as any);

        mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
            candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'base64data' } }] } }],
        }), { status: 200 }));

        const result = await service.generateImage({ prompt: 'test scene', characterId: 'char2' });
        expect(result.images).toHaveLength(1);
        const callArgs = mockFetch.mock.calls[0];
        const body = JSON.parse(callArgs[1].body);
        expect(body.contents[0].parts[0].text).toBe('test scene');
    });

    it('injects simple mode identity prompt', async () => {
        const blob = new Blob(['fake'], { type: 'image/png' });
        const blobRef = await putImageBlob(blob);

        const vi: VisualIdentity = {
            enabled: true,
            mode: 'simple',
            references: [
                { id: 'ref1', role: 'primary-face', blobRef, isPrimary: true, createdAt: Date.now() },
            ],
        };
        await DB.saveCharacter({ id: 'char3', name: 'Test', prompt: 'test', visualIdentity: vi } as any);

        mockFetch.mockImplementation(async (url: string) => {
            if (url.startsWith('blob:')) {
                return new Response(blob);
            }
            return new Response(JSON.stringify({
                candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'base64data' } }] } }],
            }), { status: 200 });
        });

        const result = await service.generateImage({ prompt: 'test scene', characterId: 'char3' });
        expect(result.images).toHaveLength(1);

        const apiCall = mockFetch.mock.calls.find((call: any) => !call[0].startsWith('blob:'));
        expect(apiCall).toBeDefined();
        const body = JSON.parse(apiCall[1].body);
        const fullPrompt = body.contents[0].parts[0].text;
        expect(fullPrompt).toContain('参考图定义的是同一角色身份');
        expect(fullPrompt).toContain('test scene');
    });

    it('injects advanced mode with all fields', async () => {
        const blob = new Blob(['fake'], { type: 'image/png' });
        const blobRef = await putImageBlob(blob);

        const vi: VisualIdentity = {
            enabled: true,
            mode: 'advanced',
            appearanceSummary: '黑色长发，蓝色眼睛',
            fixedTraits: ['黑色长发', '蓝色眼睛'],
            variableTraits: ['服装风格'],
            identityStrength: 'balanced',
            references: [
                { id: 'ref1', role: 'primary-face', blobRef, isPrimary: true, createdAt: Date.now() },
            ],
        };
        await DB.saveCharacter({ id: 'char4', name: 'Test', prompt: 'test', visualIdentity: vi } as any);

        mockFetch.mockImplementation(async (url: string) => {
            if (url.startsWith('blob:')) return new Response(blob);
            return new Response(JSON.stringify({
                candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'base64data' } }] } }],
            }), { status: 200 });
        });

        const result = await service.generateImage({ prompt: 'test scene', characterId: 'char4' });
        expect(result.images).toHaveLength(1);

        const apiCall = mockFetch.mock.calls.find((call: any) => !call[0].startsWith('blob:'));
        const body = JSON.parse(apiCall[1].body);
        const fullPrompt = body.contents[0].parts[0].text;
        expect(fullPrompt).toContain('角色外观总结：黑色长发，蓝色眼睛');
        expect(fullPrompt).toContain('必须保持的固定特征：黑色长发、蓝色眼睛');
        expect(fullPrompt).toContain('可随情节变化的特征：服装风格');
        expect(fullPrompt).toContain('保持核心身份特征，允许自然变化');
        expect(fullPrompt).toContain('test scene');
    });

    it('merges references with correct priority: primary > temp > other', async () => {
        const blob1 = new Blob(['primary'], { type: 'image/png' });
        const blob2 = new Blob(['other'], { type: 'image/png' });
        const blobRef1 = await putImageBlob(blob1);
        const blobRef2 = await putImageBlob(blob2);

        const vi: VisualIdentity = {
            enabled: true,
            mode: 'simple',
            references: [
                { id: 'ref1', role: 'primary-face', blobRef: blobRef1, isPrimary: true, createdAt: Date.now() },
                { id: 'ref2', role: 'full-body', blobRef: blobRef2, isPrimary: false, createdAt: Date.now() },
            ],
        };
        await DB.saveCharacter({ id: 'char5', name: 'Test', prompt: 'test', visualIdentity: vi } as any);

        mockFetch.mockImplementation(async (url: string) => {
            if (url.startsWith('blob:')) {
                return new Response(urlToBlob.get(url) ?? new Blob(['unknown'], { type: 'image/png' }));
            }
            return new Response(JSON.stringify({
                candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'base64data' } }] } }],
            }), { status: 200 });
        });

        const tempRef = 'data:image/png;base64,aGVsbG8=';
        await service.generateImage({
            prompt: 'test',
            characterId: 'char5',
            referenceImages: [tempRef],
        });

        const apiCall = mockFetch.mock.calls.find((call: any) => !call[0].startsWith('blob:'));
        const body = JSON.parse(apiCall[1].body);
        const parts = body.contents[0].parts;

        // Should have: 1 primary identity + 1 temp + 1 other identity = 3 images
        const imageParts = parts.filter((p: any) => p.inlineData);
        expect(imageParts.length).toBe(3);

        // 顺序：主参考图 → 临时参考图 → 其他长期参考图
        // （name 不进 API payload，用 blob 内容的 base64 区分顺序）
        expect(parts[1].inlineData.data).toBe(b64('primary'));
        expect(parts[2].inlineData.data).toBe('aGVsbG8=');
        expect(parts[3].inlineData.data).toBe(b64('other'));
    });

    it('truncates references to 5 max', async () => {
        const refs = await Promise.all(
            Array.from({ length: 7 }, async (_, i) => {
                const blob = new Blob([`ref${i}`], { type: 'image/png' });
                const blobRef = await putImageBlob(blob);
                return { id: `ref${i}`, role: 'other' as const, blobRef, createdAt: Date.now() };
            })
        );

        const vi: VisualIdentity = {
            enabled: true,
            mode: 'simple',
            references: refs,
        };
        await DB.saveCharacter({ id: 'char6', name: 'Test', prompt: 'test', visualIdentity: vi } as any);

        mockFetch.mockImplementation(async (url: string) => {
            if (url.startsWith('blob:')) return new Response(new Blob(['fake'], { type: 'image/png' }));
            return new Response(JSON.stringify({
                candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'base64data' } }] } }],
            }), { status: 200 });
        });

        await service.generateImage({ prompt: 'test', characterId: 'char6' });

        const apiCall = mockFetch.mock.calls.find((call: any) => !call[0].startsWith('blob:'));
        const body = JSON.parse(apiCall[1].body);
        const imageParts = body.contents[0].parts.filter((p: any) => p.inlineData);
        expect(imageParts.length).toBeLessThanOrEqual(5);
    });

    it('skips references for openai-images but keeps identity prompt', async () => {
        const blob = new Blob(['fake'], { type: 'image/png' });
        const blobRef = await putImageBlob(blob);

        const vi: VisualIdentity = {
            enabled: true,
            mode: 'simple',
            references: [
                { id: 'ref1', role: 'primary-face', blobRef, isPrimary: true, createdAt: Date.now() },
            ],
        };
        await DB.saveCharacter({ id: 'char7', name: 'Test', prompt: 'test', visualIdentity: vi } as any);

        const openAiConfig = { ...mockConfig, provider: 'openai-images' as const };
        const openAiService = new ImageGenerationService({
            fetchImpl: mockFetch,
            loadConfig: () => openAiConfig,
        });

        mockFetch.mockImplementation(async (url: string) => {
            if (url.startsWith('blob:')) return new Response(blob);
            return new Response(JSON.stringify({
                data: [{ url: 'https://example.com/image.png' }],
            }), { status: 200 });
        });

        const result = await openAiService.generateImage({ prompt: 'test scene', characterId: 'char7' });
        expect(result.images).toHaveLength(1);

        const apiCall = mockFetch.mock.calls.find((call: any) => !call[0].startsWith('blob:'));
        const body = JSON.parse(apiCall[1].body);

        // OpenAI should not receive image references
        expect(body.image).toBeUndefined();

        // But prompt should still contain identity constraint
        expect(body.prompt).toContain('参考图定义的是同一角色身份');
        expect(body.prompt).toContain('test scene');
    });

    it('does not mix identities between different characters', async () => {
        const blob1 = new Blob(['char1'], { type: 'image/png' });
        const blob2 = new Blob(['char2'], { type: 'image/png' });
        const blobRef1 = await putImageBlob(blob1);
        const blobRef2 = await putImageBlob(blob2);

        const vi1: VisualIdentity = {
            enabled: true,
            mode: 'simple',
            references: [{ id: 'ref1', role: 'primary-face', blobRef: blobRef1, isPrimary: true, createdAt: Date.now() }],
        };
        const vi2: VisualIdentity = {
            enabled: true,
            mode: 'simple',
            references: [{ id: 'ref2', role: 'primary-face', blobRef: blobRef2, isPrimary: true, createdAt: Date.now() }],
        };

        await DB.saveCharacter({ id: 'char8', name: 'Char1', prompt: 'p1', visualIdentity: vi1 } as any);
        await DB.saveCharacter({ id: 'char9', name: 'Char2', prompt: 'p2', visualIdentity: vi2 } as any);

        mockFetch.mockImplementation(async (url: string) => {
            if (url.startsWith('blob:')) {
                return new Response(urlToBlob.get(url) ?? new Blob(['x'], { type: 'image/png' }));
            }
            return new Response(JSON.stringify({
                candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'base64data' } }] } }],
            }), { status: 200 });
        });

        await service.generateImage({ prompt: 'scene1', characterId: 'char8' });
        let apiCall = mockFetch.mock.calls.find((c: any) => !c[0].startsWith('blob:'));
        let body = JSON.parse(apiCall[1].body);
        let datas = body.contents[0].parts.filter((p: any) => p.inlineData).map((p: any) => p.inlineData.data);
        expect(datas).toContain(b64('char1'));
        expect(datas).not.toContain(b64('char2'));

        mockFetch.mockClear();
        await service.generateImage({ prompt: 'scene2', characterId: 'char9' });
        apiCall = mockFetch.mock.calls.find((c: any) => !c[0].startsWith('blob:'));
        body = JSON.parse(apiCall[1].body);
        datas = body.contents[0].parts.filter((p: any) => p.inlineData).map((p: any) => p.inlineData.data);
        expect(datas).toContain(b64('char2'));
        expect(datas).not.toContain(b64('char1'));
    });
});
