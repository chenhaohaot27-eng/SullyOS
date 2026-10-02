import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DB } from './db';
import { getGiftRecord, listGiftRecordsByChar } from './giftStore';
import type { GiftSendIntent } from './giftIntent';
import {
    executeGiftSend,
    resetGiftGenerationClaimsForTests,
    retryCharacterGiftImage,
} from './giftCharacterSend';

// ─── 外部依赖全部 mock：只验证编排（幂等/状态机/路由），不发真实请求 ─────────

const generateMock = vi.hoisted(() => vi.fn(async (_opts: any) => ({
    images: [{ source: 'b64', url: 'data:image/png;base64,aGVsbG8=', mimeType: 'image/png' }],
})));
const toBlobMock = vi.hoisted(() => vi.fn(async () => new Blob([new Uint8Array([1, 2])], { type: 'image/png' })));
vi.mock('./imageGenerationService', () => ({
    generateImage: generateMock,
    generatedImageToBlob: toBlobMock,
    ImageGenerationError: class ImageGenerationError extends Error {
        constructor(public readonly code: string, message: string) { super(message); }
    },
}));

const configMock = vi.hoisted(() => ({ current: { enabled: true, apiKey: 'sk-gen-secret', provider: 'gemini-native', model: 'img-1' } }));
vi.mock('./imageGenerationConfig', () => ({
    loadImageGenerationConfig: () => configMock.current,
}));

const collectRefMock = vi.hoisted(() => vi.fn(async () => ['data:image/png;base64,REF']));
vi.mock('./chatPhotoGeneration', () => ({
    collectCharacterReferenceImages: collectRefMock,
}));

// 全流程绝不调用 vision（AI 生成的礼物不需要识图）。
const describeImageMock = vi.hoisted(() => vi.fn(async () => '不应被调用'));
vi.mock('./visionApi', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./visionApi')>();
    return { ...actual, describeImageWithVisionApi: describeImageMock };
});

const CHAR = { id: 'c1', name: '小星', avatar: '' } as any;

const INTENT: GiftSendIntent = {
    name: '深蓝色羊绒围巾',
    description: '一条柔软的深蓝色围巾。',
    note: '外面风大，戴上。',
    imagePrompt: 'A neatly folded deep navy cashmere scarf, soft light',
    includeCharacter: false,
    style: 'realistic',
};

const run = (over: Partial<Parameters<typeof executeGiftSend>[0]> = {}) =>
    executeGiftSend({ intent: INTENT, char: CHAR, userName: '玩家', ...over });

const cardsOf = async () =>
    (await DB.getMessagesByCharId('c1', true)).filter(m => m.type === 'gift_card');

beforeEach(async () => {
    await DB.deleteDB();
    resetGiftGenerationClaimsForTests();
    generateMock.mockReset().mockImplementation(async (_opts: any) => ({
        images: [{ source: 'b64', url: 'data:image/png;base64,aGVsbG8=', mimeType: 'image/png' }],
    }));
    toBlobMock.mockClear();
    collectRefMock.mockClear();
    describeImageMock.mockClear();
    configMock.current = { enabled: true, apiKey: 'sk-gen-secret', provider: 'gemini-native', model: 'img-1' };
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('executeGiftSend — 角色 → 玩家送礼', () => {
    it('pending-first：生图 resolve 前礼物与聊天卡已存在且为 pending', async () => {
        let release!: (v: any) => void;
        generateMock.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
        const pending = run();
        await vi.waitFor(async () => {
            expect((await listGiftRecordsByChar('c1'))).toHaveLength(1);
        });
        const gift = (await listGiftRecordsByChar('c1'))[0];
        expect(gift.status).toBe('pending');
        expect(gift.image.status).toBe('pending');
        expect(gift.image.origin).toBe('ai_generated');
        expect(gift.image.prompt).toBe(INTENT.imagePrompt);
        expect(gift.source).toBe('chat_action');
        expect(gift.sender).toEqual({ type: 'character', id: 'c1', nameSnapshot: '小星' });
        expect(gift.recipient).toEqual({ type: 'user', id: 'user', nameSnapshot: '玩家' });
        expect(await cardsOf()).toHaveLength(1);
        expect((await cardsOf())[0].role).toBe('assistant');
        release({ images: [{ source: 'b64', url: 'data:image/png;base64,aGVsbG8=', mimeType: 'image/png' }] });
        await pending;
    });

    it('生成成功：唯一一次 generateImage、blobref 落库、delivered/ready、卡片状态同步、零 vision', async () => {
        const res = await run();
        expect(res.created).toBe(true);
        expect(generateMock).toHaveBeenCalledTimes(1);
        expect(toBlobMock).toHaveBeenCalledTimes(1);
        const gift = await getGiftRecord(res.gift!.id);
        expect(gift?.status).toBe('delivered');
        expect(gift?.deliveredAt).toBeGreaterThan(0);
        expect(gift?.image.status).toBe('ready');
        expect(gift?.image.imageRef).toMatch(/^blobref:/);
        expect(JSON.stringify(gift)).not.toContain('base64');
        const card = (await cardsOf())[0];
        expect(card.content).toBe('');
        expect(card.metadata.gift.giftId).toBe(gift?.id);
        expect(card.metadata.gift.status).toBe('ready');
        expect(describeImageMock).not.toHaveBeenCalled();
    });

    it('生图配置未启用：不调 generateImage，礼物 failed、卡仍在', async () => {
        configMock.current = { enabled: false, apiKey: '', provider: 'gemini-native', model: '' };
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const res = await run();
        expect(generateMock).not.toHaveBeenCalled();
        const gift = await getGiftRecord(res.gift!.id);
        expect(gift?.status).toBe('failed');
        expect(gift?.image.status).toBe('failed');
        expect(gift?.image.failureReason).toContain('未启用');
        expect(await cardsOf()).toHaveLength(1);
        warnSpy.mockRestore();
    });

    it('生成失败：无 unhandled rejection、failed、key 脱敏、无第二份礼物、无自动重试', async () => {
        generateMock.mockRejectedValueOnce(new Error('额度不足 sk-gen-secret'));
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const res = await run();
        expect(res.created).toBe(true);
        const gift = await getGiftRecord(res.gift!.id);
        expect(gift?.status).toBe('failed');
        expect(gift?.image.failureReason).not.toContain('sk-gen-secret');
        expect(await listGiftRecordsByChar('c1')).toHaveLength(1);
        expect(generateMock).toHaveBeenCalledTimes(1);
        warnSpy.mockRestore();
    });

    it('同 eventKey 重放：1 礼物 / 1 卡 / 1 次 generateImage', async () => {
        const first = await run();
        const second = await run();
        expect(second.created).toBe(false);
        expect(second.skipped).toBe('already_exists');
        expect(second.gift!.id).toBe(first.gift!.id);
        expect(await listGiftRecordsByChar('c1')).toHaveLength(1);
        expect(await cardsOf()).toHaveLength(1);
        expect(generateMock).toHaveBeenCalledTimes(1);
    });

    it('并发重放（Promise.all）：同样只有 1 礼物 / 1 卡 / 1 次生图', async () => {
        const results = await Promise.all([run(), run()]);
        expect(results.filter(r => r.created)).toHaveLength(1);
        expect(await listGiftRecordsByChar('c1')).toHaveLength(1);
        expect(await cardsOf()).toHaveLength(1);
        expect(generateMock).toHaveBeenCalledTimes(1);
    });

    it('includeCharacter=false：不收集角色参考图', async () => {
        await run();
        expect(collectRefMock).not.toHaveBeenCalled();
        expect(generateMock.mock.calls[0][0].referenceImages).toEqual([]);
    });

    it('includeCharacter=true：收集参考图并传给统一生图服务', async () => {
        await run({ intent: { ...INTENT, includeCharacter: true } });
        expect(collectRefMock).toHaveBeenCalledTimes(1);
        expect(collectRefMock).toHaveBeenCalledWith(CHAR);
        expect(generateMock.mock.calls[0][0].referenceImages).toEqual(['data:image/png;base64,REF']);
    });
});

describe('retryCharacterGiftImage — 手动重试', () => {
    it('失败后 retry：同一 gift.id，第二次生成成功', async () => {
        generateMock.mockRejectedValueOnce(new Error('boom'));
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const created = await run();
        expect((await getGiftRecord(created.gift!.id))?.image.status).toBe('failed');
        const retried = await retryCharacterGiftImage(created.gift!.id, { char: CHAR });
        if (!retried.ok) throw new Error('retry 应当成功');
        expect(retried.gift.id).toBe(created.gift!.id);
        expect(retried.gift.image.status).toBe('ready');
        expect(retried.gift.status).toBe('delivered');
        expect(await listGiftRecordsByChar('c1')).toHaveLength(1);
        expect(generateMock).toHaveBeenCalledTimes(2);
    });

    it('retry 并发点击：最多一次真实生成请求', async () => {
        generateMock.mockRejectedValueOnce(new Error('boom'));
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const created = await run();
        generateMock.mockClear();
        const [a, b] = await Promise.all([
            retryCharacterGiftImage(created.gift!.id, { char: CHAR }),
            retryCharacterGiftImage(created.gift!.id, { char: CHAR }),
        ]);
        expect(generateMock).toHaveBeenCalledTimes(1);
        expect([a.ok, b.ok]).toContain(true);
    });

    it('玩家上传的礼物不可 retry（not_retryable）', async () => {
        const { createGiftRecord } = await import('./giftStore');
        const { record } = await createGiftRecord({
            eventKey: 'gift:user:c1:x',
            charId: 'c1',
            sender: { type: 'user', id: 'user', nameSnapshot: '玩家' },
            recipient: { type: 'character', id: 'c1', nameSnapshot: '小星' },
            source: 'gift_app',
            gift: { name: '手织围巾' },
            image: { imageRef: 'blobref:u', origin: 'gallery', status: 'ready' },
            status: 'delivered',
        });
        const res = await retryCharacterGiftImage(record.id, { char: CHAR });
        if (res.ok) throw new Error('玩家礼物不应可 retry');
        expect(res.reason).toBe('not_retryable');
        expect(generateMock).not.toHaveBeenCalled();
    });

    it('活跃 pending（正在生成）不可重复 retry', async () => {
        let release!: (v: any) => void;
        generateMock.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
        const pending = run();
        await vi.waitFor(async () => { expect((await listGiftRecordsByChar('c1'))).toHaveLength(1); });
        const giftId = (await listGiftRecordsByChar('c1'))[0].id;
        const res = await retryCharacterGiftImage(giftId, { char: CHAR });
        if (res.ok) throw new Error('活跃 pending 不应可 retry');
        expect(res.reason).toBe('already_in_progress');
        release({ images: [{ source: 'b64', url: 'data:image/png;base64,aGVsbG8=', mimeType: 'image/png' }] });
        await pending;
    });
});

describe('cooldown — 角色自主送礼 24h 限频', () => {
    it('第一份自主礼物允许；24h 内第二份被静默跳过', async () => {
        const first = await run();
        expect(first.created).toBe(true);
        const second = await run({ intent: { ...INTENT, name: '第二份礼物', imagePrompt: 'another gift photo' } });
        expect(second.created).toBe(false);
        expect(second.skipped).toBe('cooldown');
        expect(await listGiftRecordsByChar('c1')).toHaveLength(1);
        expect(generateMock).toHaveBeenCalledTimes(1);
    });

    it('explicitGiftRequest=true 绕过 cooldown', async () => {
        await run();
        const second = await run({
            intent: { ...INTENT, name: '点名的礼物', imagePrompt: 'requested gift' },
            explicitGiftRequest: true,
        });
        expect(second.created).toBe(true);
        expect(await listGiftRecordsByChar('c1')).toHaveLength(2);
    });

    it('retry 旧礼物不受 cooldown 影响', async () => {
        generateMock.mockRejectedValueOnce(new Error('boom'));
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const created = await run();
        const retried = await retryCharacterGiftImage(created.gift!.id, { char: CHAR });
        expect(retried.ok).toBe(true);
        expect(await listGiftRecordsByChar('c1')).toHaveLength(1);
    });

    it('玩家送礼不计入 cooldown', async () => {
        const { createGiftRecord } = await import('./giftStore');
        await createGiftRecord({
            eventKey: 'gift:user:c1:y',
            charId: 'c1',
            sender: { type: 'user', id: 'user', nameSnapshot: '玩家' },
            recipient: { type: 'character', id: 'c1', nameSnapshot: '小星' },
            source: 'gift_app',
            gift: { name: '玩家礼物' },
            image: { origin: 'none', status: 'none' },
            status: 'delivered',
        });
        const res = await run();
        expect(res.created).toBe(true);
    });
});
