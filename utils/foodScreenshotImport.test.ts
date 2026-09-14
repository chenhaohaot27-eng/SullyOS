import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    processImageToBlob: vi.fn(),
    safeFetchJson: vi.fn(),
}));

vi.mock('./file', () => ({ processImageToBlob: mocks.processImageToBlob }));
vi.mock('./safeApi', async importOriginal => {
    const actual = await importOriginal<typeof import('./safeApi')>();
    return { ...actual, safeFetchJson: mocks.safeFetchJson };
});

import { parseFoodVisionResponse, prepareFoodScreenshotImport } from './foodScreenshotImport';

const enabled = { enabled: true, baseUrl: 'https://vision.example/v1', apiKey: 'key', model: 'vision-model' };
const file = { type: 'image/png', size: 10 } as File;

afterEach(() => { vi.clearAllMocks(); });

describe('foodScreenshotImport — 独立 Vision 路由', () => {
    it('Vision disabled：不调用 API，仍返回待确认 Blob', async () => {
        const blob = new Blob(['image'], { type: 'image/png' });
        mocks.processImageToBlob.mockResolvedValue(blob);
        const result = await prepareFoodScreenshotImport(file, { ...enabled, enabled: false });
        expect(result).toMatchObject({ imageBlob: blob, visionAttempted: false, extraction: {} });
        expect(mocks.safeFetchJson).not.toHaveBeenCalled();
    });

    it('Vision success：返回结构化白名单字段', async () => {
        mocks.processImageToBlob.mockResolvedValue(new Blob(['image'], { type: 'image/png' }));
        mocks.safeFetchJson.mockResolvedValue({ choices: [{ message: { content: '```json\n{"merchantName":"小月食堂","itemName":"咖喱饭","price":28.9,"description":"微辣","visualSummary":"商品详情页"}\n```' } }] });
        const result = await prepareFoodScreenshotImport(file, enabled);
        expect(result.visionAttempted).toBe(true);
        expect(result.extraction).toEqual({ merchantName: '小月食堂', itemName: '咖喱饭', price: 28.9, description: '微辣', visualSummary: '商品详情页' });
    });

    it('malformed JSON：原始有用说明降级为 visualSummary', () => {
        expect(parseFoodVisionResponse('画面里是一份牛肉饭，价格区域有些模糊')).toEqual({ visualSummary: '画面里是一份牛肉饭，价格区域有些模糊' });
    });

    it('Vision failure：非阻断，Blob 仍保留', async () => {
        const blob = new Blob(['image'], { type: 'image/png' });
        mocks.processImageToBlob.mockResolvedValue(blob);
        mocks.safeFetchJson.mockRejectedValue(new Error('network down'));
        const result = await prepareFoodScreenshotImport(file, enabled);
        expect(result.imageBlob).toBe(blob);
        expect(result.extraction).toEqual({});
        expect(result.error).toContain('可以继续手动填写');
    });

    it('每次导入最多调用一次 Vision', async () => {
        mocks.processImageToBlob.mockResolvedValue(new Blob(['image'], { type: 'image/png' }));
        mocks.safeFetchJson.mockResolvedValue({ choices: [{ message: { content: '{}' } }] });
        await prepareFoodScreenshotImport(file, enabled);
        expect(mocks.safeFetchJson).toHaveBeenCalledTimes(1);
    });

    it('只走配置中的独立 Vision endpoint，不带主聊天内容', async () => {
        mocks.processImageToBlob.mockResolvedValue(new Blob(['image'], { type: 'image/png' }));
        mocks.safeFetchJson.mockResolvedValue({ choices: [{ message: { content: '{}' } }] });
        await prepareFoodScreenshotImport(file, enabled);
        expect(mocks.safeFetchJson.mock.calls[0][0]).toBe('https://vision.example/v1/chat/completions');
        const body = JSON.parse(mocks.safeFetchJson.mock.calls[0][1].body as string);
        expect(body.messages).toHaveLength(1);
        expect(body.messages[0].content[1].type).toBe('image_url');
    });

    it('不接入主 Chat client', () => {
        const source = readFileSync(new URL('./foodScreenshotImport.ts', import.meta.url), 'utf8');
        expect(source).not.toMatch(/chatCompletionClient|geminiNativeChat|useChatAI/);
    });

    it('不接入 Image Generation API', () => {
        const source = readFileSync(new URL('./foodScreenshotImport.ts', import.meta.url), 'utf8');
        expect(source).not.toMatch(/imageGeneration|generateImage|image_gen/);
    });

    it('不完整 Vision 配置不调用 API，允许手工继续', async () => {
        mocks.processImageToBlob.mockResolvedValue(new Blob(['image'], { type: 'image/png' }));
        const result = await prepareFoodScreenshotImport(file, { ...enabled, apiKey: '' });
        expect(result.visionAttempted).toBe(false);
        expect(result.error).toContain('手动填写');
        expect(mocks.safeFetchJson).not.toHaveBeenCalled();
    });
});
