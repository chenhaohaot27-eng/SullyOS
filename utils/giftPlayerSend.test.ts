import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DB } from './db';
import { putImageBlob } from './blobRef';
import { getGiftRecord, listGiftRecords } from './giftStore';
import {
    EmptyGiftError,
    GIFT_FALLBACK_NAME,
    sendPlayerGift,
    type SendPlayerGiftInput,
} from './giftPlayerSend';

// processImageToBlob 依赖 Canvas/Image（浏览器），Node 测试里直接透传原文件。
vi.mock('./file', () => ({
    processImageToBlob: async (file: Blob) => file,
}));

// visionApi 走网络，这里只验证路由规则（何时调用/调用几次），不测真实请求。
const describeImageMock = vi.hoisted(() => vi.fn(async () => '一只戴围巾的猫'));
vi.mock('./visionApi', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./visionApi')>();
    return {
        ...actual,
        describeImageWithVisionApi: describeImageMock,
    };
});

beforeEach(async () => {
    await DB.deleteDB();
    describeImageMock.mockClear();
});

afterEach(() => {
    vi.restoreAllMocks();
});

const VISION_ON = { enabled: true, baseUrl: 'https://vision.example.com/v1', apiKey: 'k', model: 'm' };
const PNG_FILE = (): File => new File([new Uint8Array([1, 2, 3])], 'gift.png', { type: 'image/png' });

function makeInput(overrides: Partial<SendPlayerGiftInput> = {}): SendPlayerGiftInput {
    return {
        charId: 'char-a',
        characterName: '小星',
        userName: '玩家',
        name: '星星手链',
        description: '自己做的',
        note: '送给你',
        ...overrides,
    };
}

describe('giftPlayerSend — 玩家送礼服务', () => {
    it('Test 1 — 纯文字礼物：delivered、image none/none', async () => {
        const { record, created, visionPending } = await sendPlayerGift(makeInput({
            imageFile: null, visionConfig: VISION_ON,
        }));
        expect(created).toBe(true);
        expect(visionPending).toBe(false);
        expect(record.status).toBe('delivered');
        expect(record.deliveredAt).toBeGreaterThan(0);
        expect(record.image.origin).toBe('none');
        expect(record.image.status).toBe('none');
        expect(record.sender).toEqual({ type: 'user', id: 'user', nameSnapshot: '玩家' });
        expect(record.recipient).toEqual({ type: 'character', id: 'char-a', nameSnapshot: '小星' });
        expect(describeImageMock).not.toHaveBeenCalled();
    });

    it('Test 2 — 图片礼物：blob 入库、imageRef 为 blobref、不存 base64', async () => {
        const { record } = await sendPlayerGift(makeInput({
            imageFile: PNG_FILE(), imageOrigin: 'camera',
        }));
        expect(record.image.imageRef).toMatch(/^blobref:/);
        expect(record.image.origin).toBe('camera');
        expect(record.image.status).toBe('ready');
        // GiftRecord 里没有任何 base64 / data URL
        expect(JSON.stringify(record)).not.toContain('data:image');
        expect(JSON.stringify(record)).not.toContain('base64');
        // blobref 真能取回 Blob（与未来 Chat 卡同源，无第二份拷贝）
        const { getBlobForRef } = await import('./blobRef');
        expect(await getBlobForRef(record.image.imageRef!)).not.toBeNull();
    });

    it('Test 3 — vision disabled：不调用识图、礼物照常 delivered、无 visualSummary', async () => {
        const { record, visionPending } = await sendPlayerGift(makeInput({
            imageFile: PNG_FILE(),
            visionConfig: { enabled: false, baseUrl: '', apiKey: '', model: '' },
        }));
        expect(record.status).toBe('delivered');
        expect(visionPending).toBe(false);
        expect(describeImageMock).not.toHaveBeenCalled();
        const loaded = await getGiftRecord(record.id);
        expect(loaded?.image.visualSummary).toBeUndefined();
    });

    it('Test 4 — vision success：先创建礼物，成功后回写 visualSummary，只调用一次', async () => {
        const { record, visionPending } = await sendPlayerGift(makeInput({
            imageFile: PNG_FILE(), visionConfig: VISION_ON,
        }));
        expect(record.status).toBe('delivered');
        expect(visionPending).toBe(true);
        // 创建时还没有摘要
        expect(record.image.visualSummary).toBeUndefined();
        // 等后台识图落库
        await vi.waitFor(async () => {
            const loaded = await getGiftRecord(record.id);
            expect(loaded?.image.visualSummary).toBe('一只戴围巾的猫');
        });
        expect(describeImageMock).toHaveBeenCalledTimes(1);
    });

    it('Test 5 — vision failure：礼物仍 delivered、记录仍在、无摘要、无 unhandled rejection', async () => {
        describeImageMock.mockRejectedValueOnce(new Error('boom (无凭据)'));
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { record, visionPending } = await sendPlayerGift(makeInput({
            imageFile: PNG_FILE(), visionConfig: VISION_ON,
        }));
        expect(record.status).toBe('delivered');
        expect(visionPending).toBe(true);
        await vi.waitFor(async () => {
            expect(describeImageMock).toHaveBeenCalledTimes(1);
        });
        const loaded = await getGiftRecord(record.id);
        expect(loaded?.status).toBe('delivered');
        expect(loaded?.image.visualSummary).toBeUndefined();
        expect(loaded?.image.status).toBe('ready');
        // 失败只留一行 warn，不抛 Error Modal、不改礼物状态
        expect(warnSpy).toHaveBeenCalled();
        warnSpy.mockRestore();
    });

    it('Test 6 — 同一 eventKey 重复调用：只落一条记录，二次是幂等命中且不再触发 vision', async () => {
        const key = 'gift:user:char-a:fixed-submission';
        const first = await sendPlayerGift(makeInput({ eventKey: key, imageFile: PNG_FILE() }));
        const second = await sendPlayerGift(makeInput({ eventKey: key, imageFile: PNG_FILE() }));
        expect(first.created).toBe(true);
        expect(second.created).toBe(false);
        expect(second.record.id).toBe(first.record.id);
        expect(await listGiftRecords()).toHaveLength(1);
        // 两次调用 vision 均未触发：第一次未传 visionConfig，第二次是幂等命中（created=false）
        expect(describeImageMock).not.toHaveBeenCalled();
    });

    it('Test 7 — 只有图片：允许发送，name 回退「一份礼物」', async () => {
        const { record } = await sendPlayerGift(makeInput({
            name: '', description: '', imageFile: PNG_FILE(),
        }));
        expect(record.gift.name).toBe(GIFT_FALLBACK_NAME);
        expect(record.status).toBe('delivered');
    });

    it('Test 8 — 全空提交：阻止创建并抛 EmptyGiftError', async () => {
        await expect(sendPlayerGift(makeInput({ name: '', description: '', imageFile: null })))
            .rejects.toThrow(EmptyGiftError);
        expect(await listGiftRecords()).toHaveLength(0);
    });

    it('无图片时 visionConfig 即使启用也不调用识图', async () => {
        await sendPlayerGift(makeInput({ imageFile: null, visionConfig: VISION_ON }));
        expect(describeImageMock).not.toHaveBeenCalled();
        expect(typeof putImageBlob).toBe('function'); // import 冒烟
    });
});
