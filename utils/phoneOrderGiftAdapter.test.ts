import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DB } from './db';
import { listGiftRecords } from './giftStore';
import type { PhoneEvidence } from '../types';
import {
    bridgePhoneOrderGift,
    detectPhoneOrderGiftIntent,
    type PhoneOrderGiftBridgeInput,
} from './phoneOrderGiftAdapter';

// 「adapter 失败不影响刷新」用例：可开关地让 recordGiftEvent 抛错（其余走真实链路）。
const mockState = vi.hoisted(() => ({ failRecordGiftEvent: false }));
vi.mock('./giftEventHub', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./giftEventHub')>();
    return {
        ...actual,
        recordGiftEvent: vi.fn(async (input: import('./giftEventHub').GiftEventInput, opts?: import('./giftEventHub').RecordGiftEventOptions) => {
            if (mockState.failRecordGiftEvent) throw new Error('hub down');
            return actual.recordGiftEvent(input, opts);
        }),
    };
});

// fake-indexeddb 已通过 test-setup.ts 注入（同 giftStore.test.ts）。
beforeEach(async () => {
    await DB.deleteDB();
    vi.clearAllMocks();
    mockState.failRecordGiftEvent = false;
});

function makeOrder(overrides: Partial<PhoneEvidence> = {}): PhoneEvidence {
    return {
        id: 'rec-1001',
        type: 'order',
        title: '海鲸项链',
        detail: '买给你的生日礼物',
        value: '¥129.00',
        timestamp: Date.now(),
        ...overrides,
    };
}

function makeBridgeInput(overrides: Partial<PhoneOrderGiftBridgeInput> = {}): PhoneOrderGiftBridgeInput {
    return {
        record: makeOrder(),
        charId: 'char-a',
        charName: '小星',
        userName: '你',
        ...overrides,
    };
}

describe('detectPhoneOrderGiftIntent — 词表判定（纯函数）', () => {
    it('命中：买给你的生日礼物', () => {
        expect(detectPhoneOrderGiftIntent({ title: '海鲸项链', detail: '买给你的生日礼物' }).intent).toBe(true);
    });
    it('命中：送给你的 / 看到这个想到你 / 为你挑的', () => {
        expect(detectPhoneOrderGiftIntent({ title: '围巾', detail: '冬天到了送给你' }).intent).toBe(true);
        expect(detectPhoneOrderGiftIntent({ title: '鲸鱼摆件', detail: '看到这个想到你' }).intent).toBe(true);
        expect(detectPhoneOrderGiftIntent({ title: '手绳', detail: '为你挑的生日礼物' }).intent).toBe(true);
    });
    it('不命中：日常使用 / 自购画材', () => {
        expect(detectPhoneOrderGiftIntent({ title: '画笔套装', detail: '日常使用' }).intent).toBe(false);
        expect(detectPhoneOrderGiftIntent({ title: '画材', detail: '水彩颜料补充装' }).intent).toBe(false);
    });
});

describe('bridgePhoneOrderGift — 淘宝订单 → Gift Event（Phase 2A）', () => {
    it('Test 1 — 明确送玩家：created=true，source=phone_order，origin 反链订单 id', async () => {
        const result = await bridgePhoneOrderGift(makeBridgeInput());
        expect(result.bridged).toBe(true);
        expect(result.created).toBe(true);
        expect(result.record!.source).toBe('phone_order');
        expect(result.record!.triggerSource).toBe('autonomous');
        expect(result.record!.origin).toEqual({ kind: 'order-record', refId: 'rec-1001' });
        expect(result.record!.eventKey).toBe('gift:phone_order:char-a:rec-1001');
        expect(result.record!.sender).toEqual({ type: 'character', id: 'char-a', nameSnapshot: '小星' });
        expect(result.record!.recipient).toEqual({ type: 'user', id: 'user', nameSnapshot: '你' });
        expect(result.record!.gift.note).toBe('¥129.00');
        expect(result.record!.status).toBe('delivered');
    });

    it('Test 2 — 普通订单（角色自购）：不创建 GiftRecord', async () => {
        const result = await bridgePhoneOrderGift(makeBridgeInput({
            record: makeOrder({ id: 'rec-2002', title: '画笔套装', detail: '日常使用' }),
        }));
        expect(result.bridged).toBe(false);
        expect(result.reason).toBe('no_gift_intent');
        expect(await listGiftRecords()).toHaveLength(0);
    });

    it('Test 3 — 幂等：同一订单 id 调用两次，第二次 created=false', async () => {
        const first = await bridgePhoneOrderGift(makeBridgeInput());
        const second = await bridgePhoneOrderGift(makeBridgeInput());
        expect(first.created).toBe(true);
        expect(second.bridged).toBe(true);
        expect(second.created).toBe(false);
        expect(second.record!.id).toBe(first.record!.id);
        expect(await listGiftRecords()).toHaveLength(1);
    });

    it('Test 4 — adapter 失败不抛错：recordGiftEvent 抛异常时返回 error，模拟刷新流程不被阻断', async () => {
        mockState.failRecordGiftEvent = true;
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });
        // adapter 永不 throw —— 调用方（淘宝刷新）拿到的永远是正常返回
        const result = await bridgePhoneOrderGift(makeBridgeInput());
        expect(result.bridged).toBe(false);
        expect(result.reason).toBe('error');
        // 再模拟 CheckPhone 侧的外层 try/catch 双保险路径：直接 await 不应 reject
        await expect(bridgePhoneOrderGift(makeBridgeInput())).resolves.toBeTruthy();
        warnSpy.mockRestore();
        mockState.failRecordGiftEvent = false;
    });

    it('Test 5 — 边界：非 order 记录 / 缺 id / 缺 charId 均静默返回', async () => {
        expect((await bridgePhoneOrderGift(makeBridgeInput({
            record: makeOrder({ type: 'delivery' }),
        }))).reason).toBe('not_order');
        expect((await bridgePhoneOrderGift(makeBridgeInput({
            record: makeOrder({ id: '' }),
        }))).reason).toBe('invalid_input');
        expect((await bridgeOrderGiftWithBadChar()).reason).toBe('invalid_input');
        expect(await listGiftRecords()).toHaveLength(0);
    });

    async function bridgeOrderGiftWithBadChar() {
        return bridgePhoneOrderGift(makeBridgeInput({ charId: ' ' }));
    }
});
