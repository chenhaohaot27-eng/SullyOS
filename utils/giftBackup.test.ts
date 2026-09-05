import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DB, openDB } from './db';
import { getBlobForRef } from './blobRef';
import { createGiftRecord, listGiftRecords } from './giftStore';
import type { GiftRecord } from './giftTypes';
import {
    isValidGiftBackupRecord,
    normalizeGiftRecordsAfterRestore,
    normalizeGiftStatusAfterRestore,
} from './giftBackup';

// ─── 恢复路径绝不允许触发的副作用（§25/§55）：全部 mock 并断言 0 次调用 ─────────
const generateImageMock = vi.hoisted(() => vi.fn());
vi.mock('./imageGenerationService', () => ({
    generateImage: generateImageMock,
    generatedImageToBlob: vi.fn(),
    ImageGenerationError: class ImageGenerationError extends Error {},
}));
const visionMock = vi.hoisted(() => vi.fn());
vi.mock('./visionApi', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./visionApi')>();
    return { ...actual, describeImageWithVisionApi: visionMock };
});
const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('./safeApi', () => ({ safeFetchJson: fetchMock }));
const memoryIngestMock = vi.hoisted(() => vi.fn());
vi.mock('./memoryPalace/curatedIngestion', () => ({
    submitCuratedMemoryCandidate: memoryIngestMock,
}));

const TINY_PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const USER = { type: 'user' as const, id: 'user', nameSnapshot: '玩家' };
const CHAR = { type: 'character' as const, id: 'c1', nameSnapshot: '小星' };

beforeEach(async () => {
    await DB.deleteDB();
    generateImageMock.mockClear();
    visionMock.mockClear();
    fetchMock.mockClear();
    memoryIngestMock.mockClear();
});

afterEach(() => {
    vi.restoreAllMocks();
});

async function seedPlayerGift(over: Record<string, unknown> = {}): Promise<GiftRecord> {
    const { record } = await createGiftRecord({
        eventKey: `gift:user:c1:${Math.random().toString(36).slice(2, 8)}`,
        charId: 'c1',
        sender: USER,
        recipient: CHAR,
        source: 'gift_app',
        gift: { name: '手织围巾', description: '第一次织的', note: '记得戴' },
        image: { origin: 'none', status: 'none' },
        status: 'delivered',
        ...over,
    } as any);
    return record;
}

async function seedAiGift(over: Record<string, unknown> = {}): Promise<GiftRecord> {
    const { record } = await createGiftRecord({
        eventKey: `gift:char:c1:send:${Math.random().toString(36).slice(2, 8)}`,
        charId: 'c1',
        sender: CHAR,
        recipient: USER,
        source: 'chat_action',
        gift: { name: '海浪胸针', description: '深蓝丝绒盒', note: '给你' },
        image: { origin: 'ai_generated', status: 'ready', imageRef: 'blobref:placeholder', prompt: 'a wave brooch' },
        status: 'delivered',
        deliveredAt: 12345,
        ...over,
    } as any);
    return record;
}

describe('normalizeGiftStatusAfterRestore — pending 规范化', () => {
    const base: GiftRecord = {
        schemaVersion: 1, id: 'g1', eventKey: 'e1', charId: 'c1',
        sender: CHAR, recipient: USER, source: 'chat_action',
        gift: { name: '海浪胸针' },
        image: { origin: 'ai_generated', status: 'pending', prompt: 'p' },
        status: 'pending', createdAt: 1, updatedAt: 1,
    };

    it('AI pending → interrupted（双层状态），prompt/name/eventKey 全保留', () => {
        const out = normalizeGiftStatusAfterRestore({ ...base });
        expect(out.status).toBe('interrupted');
        expect(out.image.status).toBe('interrupted');
        expect(out.image.prompt).toBe('p');
        expect(out.gift.name).toBe('海浪胸针');
        expect(out.id).toBe('g1');
        expect(out.eventKey).toBe('e1');
    });

    it('delivered/ready、failed、玩家图原样不变', () => {
        expect(normalizeGiftStatusAfterRestore({ ...base, status: 'delivered', image: { ...base.image, status: 'ready' } }).status).toBe('delivered');
        expect(normalizeGiftStatusAfterRestore({ ...base, status: 'failed', image: { ...base.image, status: 'failed' } }).status).toBe('failed');
        const player = normalizeGiftStatusAfterRestore({
            ...base, sender: USER, recipient: CHAR,
            image: { origin: 'gallery', status: 'ready', imageRef: 'blobref:x' } as any, status: 'delivered',
        });
        expect(player.status).toBe('delivered');
    });
});

describe('normalizeGiftRecordsAfterRestore — 数据规范化', () => {
    it('损坏单条跳过、不整包失败；未知 schemaVersion 剔除', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const good = { schemaVersion: 1, id: 'g', eventKey: 'e', charId: 'c1', sender: CHAR, recipient: USER, gift: { name: 'x' }, image: { origin: 'none', status: 'none' }, status: 'delivered', createdAt: 1, updatedAt: 1 };
        const out = await normalizeGiftRecordsAfterRestore([
            good,
            { schemaVersion: 1, eventKey: 'e', charId: 'c1', sender: CHAR, recipient: USER, gift: { name: 'x' }, image: { origin: 'none', status: 'none' }, status: 'delivered', createdAt: 1, updatedAt: 1 },
            { schemaVersion: 2, id: 'future', eventKey: 'e2', charId: 'c1', sender: CHAR, recipient: USER, gift: { name: 'x' }, image: { origin: 'none', status: 'none' }, status: 'delivered', createdAt: 1, updatedAt: 1 },
            'not an object',
        ]);
        expect(out).toHaveLength(1);
        expect(out[0].id).toBe('g');
        expect(warnSpy).toHaveBeenCalled();
        warnSpy.mockRestore();
    });

    it('data: imageRef 重新入库换回 blobref，MIME/内容一致；同 data URL 只存一份', async () => {
        const make = (id: string): GiftRecord => ({
            schemaVersion: 1, id, eventKey: `e-${id}`, charId: 'c1',
            sender: CHAR, recipient: USER, source: 'chat_action',
            gift: { name: '海浪胸针' },
            image: { origin: 'ai_generated', status: 'ready', imageRef: TINY_PNG_DATA_URL, prompt: 'p' },
            status: 'delivered', createdAt: 1, updatedAt: 1,
        });
        const out = await normalizeGiftRecordsAfterRestore([make('a'), make('b')]);
        expect(out[0].image.imageRef).toMatch(/^blobref:/);
        expect(out[1].image.imageRef).toBe(out[0].image.imageRef);
        const blob = await getBlobForRef(out[0].image.imageRef!);
        expect(blob).not.toBeNull();
        expect(blob!.type).toBe('image/png');
        expect(blob!.size).toBeGreaterThan(0);
    });

    it('beforeWrite 逐条调用（assets/ 路径还原后再入 blob）', async () => {
        const beforeWrite = vi.fn(async (root: any) => {
            if (root?.image?.imageRef === 'assets/p.png') root.image.imageRef = TINY_PNG_DATA_URL;
        });
        const rec: any = {
            schemaVersion: 1, id: 'g', eventKey: 'e', charId: 'c1', sender: CHAR, recipient: USER,
            gift: { name: 'x' }, image: { origin: 'ai_generated', status: 'ready', imageRef: 'assets/p.png', prompt: 'p' },
            status: 'delivered', createdAt: 1, updatedAt: 1,
        };
        const out = await normalizeGiftRecordsAfterRestore([rec], beforeWrite);
        expect(beforeWrite).toHaveBeenCalledTimes(1);
        expect(out[0].image.imageRef).toMatch(/^blobref:/);
    });

    it('isValidGiftBackupRecord 基础判定', () => {
        expect(isValidGiftBackupRecord(null)).toBe(false);
        expect(isValidGiftBackupRecord({ id: 'g' })).toBe(false);
        expect(isValidGiftBackupRecord({
            schemaVersion: 1, id: 'g', eventKey: 'e', charId: 'c1',
            sender: CHAR, recipient: USER, gift: { name: 'x' },
        })).toBe(true);
    });
});

describe('exportFullData → importFullData 全链路 roundtrip', () => {
    it('纯文字礼物：字段/reaction/effects/memory/chat 链接全量一致', async () => {
        const g = await seedPlayerGift({
            reaction: { review: '嘴上嫌熬夜', disposition: '戴上了', acceptance: 'accepted' },
            effects: { affinityImpact: 'positive', moodImpact: ['温暖'], reason: '戴上了' },
            memory: { importance: 'meaningful', summary: '她第一次织东西给我。', status: 'committed', memoryId: 'mn_1' },
            chat: { triggerMessageId: '11', cardMessageId: '12', reactionMessageIds: ['13'] },
        });
        const exported = await DB.exportFullData();
        expect(exported.gifts).toHaveLength(1);
        expect(exported.gifts![0].id).toBe(g.id);
        expect(exported.gifts![0].eventKey).toBe(g.eventKey);

        await DB.deleteDB();
        await openDB();
        await DB.importFullData(exported as any);

        const restored = (await listGiftRecords())[0];
        expect(restored.id).toBe(g.id);
        expect(restored.eventKey).toBe(g.eventKey);
        expect(restored.createdAt).toBe(g.createdAt);
        expect(restored.chat).toEqual({ triggerMessageId: '11', cardMessageId: '12', reactionMessageIds: ['13'] });
        expect(restored.reaction?.acceptance).toBe('accepted');
        expect(restored.reaction?.review).toBe('嘴上嫌熬夜');
        expect(restored.effects?.affinityImpact).toBe('positive');
        expect(restored.effects?.moodImpact).toEqual(['温暖']);
        expect(restored.effects?.appliedAt).toBeUndefined();
        expect(restored.memory?.status).toBe('committed');
        expect(restored.memory?.memoryId).toBe('mn_1');
    });

    it('玩家图片礼物：blobref 导出成 data:、导入换回可解析的新 blobref', async () => {
        const { putImageBlob, dataUrlToBlob } = await import('./blobRef');
        const imageRef = await putImageBlob(dataUrlToBlob(TINY_PNG_DATA_URL));
        const g = await seedPlayerGift({
            image: { imageRef, origin: 'gallery', status: 'ready', visualSummary: '一条深蓝色针织围巾。' },
        });
        const exported = await DB.exportFullData();
        // 导出侧：令牌 → data URL（自包含可移植）
        expect(exported.gifts![0].image.imageRef).toBe(TINY_PNG_DATA_URL);

        await DB.deleteDB();
        await openDB();
        await DB.importFullData(exported as any);

        const restored = (await listGiftRecords())[0];
        expect(restored.id).toBe(g.id);
        expect(restored.image.imageRef).toMatch(/^blobref:/);
        expect(restored.image.imageRef).not.toBe(imageRef); // 新设备新令牌
        const blob = await getBlobForRef(restored.image.imageRef!);
        expect(blob).not.toBeNull();
        expect(blob!.type).toBe('image/png');
        expect(restored.image.visualSummary).toBe('一条深蓝色针织围巾。');
        expect(restored.image.origin).toBe('gallery');
    });

    it('AI 礼物 delivered 原样恢复；pending → interrupted；failed 原样；全程 0 API', async () => {
        const { putImageBlob, dataUrlToBlob } = await import('./blobRef');
        const imageRef = await putImageBlob(dataUrlToBlob(TINY_PNG_DATA_URL));
        await seedAiGift({ image: { origin: 'ai_generated', status: 'ready', imageRef, prompt: 'a wave brooch' } });
        await seedAiGift({
            eventKey: 'gift:char:c1:send:pendingcase',
            image: { origin: 'ai_generated', status: 'pending', prompt: 'generating' }, status: 'pending',
        });
        await seedAiGift({
            eventKey: 'gift:char:c1:send:failedcase',
            image: { origin: 'ai_generated', status: 'failed', prompt: 'boom', failureReason: '生图 API 未启用' }, status: 'failed',
        });

        const exported = await DB.exportFullData();
        await DB.deleteDB();
        await openDB();
        await DB.importFullData(exported as any);

        const restored = await listGiftRecords();
        expect(restored).toHaveLength(3);
        const ready = restored.find(r => r.image.status === 'ready');
        expect(ready?.status).toBe('delivered');
        expect(ready?.image.prompt).toBe('a wave brooch');
        expect(ready?.deliveredAt).toBeGreaterThan(0);
        const interrupted = restored.find(r => r.status === 'interrupted');
        expect(interrupted?.image.status).toBe('interrupted');
        expect(interrupted?.image.prompt).toBe('generating');
        const failed = restored.find(r => r.status === 'failed');
        expect(failed?.image.status).toBe('failed');
        expect(failed?.image.failureReason).toBe('生图 API 未启用');
        // 恢复全程零副作用
        expect(generateImageMock).not.toHaveBeenCalled();
        expect(visionMock).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
        expect(memoryIngestMock).not.toHaveBeenCalled();
    });

    it('legacy 备份（无 gifts 字段）：导入成功且礼物为 0；有 gifts: [] 也不报错', async () => {
        await seedPlayerGift();
        await DB.deleteDB();
        await openDB();
        await DB.importFullData({ timestamp: Date.now(), version: 3 } as any);
        expect(await listGiftRecords()).toHaveLength(0);

        await DB.importFullData({ timestamp: Date.now(), version: 3, gifts: [] } as any);
        expect(await listGiftRecords()).toHaveLength(0);
        expect(generateImageMock).not.toHaveBeenCalled();
    });
});
