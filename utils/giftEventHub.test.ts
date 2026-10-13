import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DB } from './db';
import { getGiftRecordByEventKey, listGiftRecords } from './giftStore';
import { buildGiftEventKey, recordGiftEvent, type GiftEventInput } from './giftEventHub';

// giftChatBridge / giftMemory 依赖重（DB + 聊天链 + 记忆宫殿），hub 是动态 import，
// 这里用轻量 mock 拦截并 spy 副作用调用次数。
vi.mock('./giftChatBridge', () => ({
    projectGiftToChat: vi.fn(async () => ({ cardMessageId: 'm-1', created: true })),
}));
vi.mock('./giftMemory', () => ({
    commitGiftMemoryCandidate: vi.fn(async () => ({ status: 'committed' as const })),
}));

// 落库失败透传测试：可开关地让 createGiftRecord 抛错（其余走真实实现）。
const mockState = vi.hoisted(() => ({ failCreateGift: false }));
vi.mock('./giftStore', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./giftStore')>();
    return {
        ...actual,
        createGiftRecord: vi.fn(async (input: import('./giftStore').CreateGiftRecordInput) => {
            if (mockState.failCreateGift) throw new Error('idb down');
            return actual.createGiftRecord(input);
        }),
    };
});

import { projectGiftToChat } from './giftChatBridge';
import { commitGiftMemoryCandidate } from './giftMemory';

// fake-indexeddb 已通过 test-setup.ts 注入（同 giftStore.test.ts）。
beforeEach(async () => {
    await DB.deleteDB();
    vi.clearAllMocks();
    mockState.failCreateGift = false;
});

function makeInput(overrides: Partial<GiftEventInput> = {}): GiftEventInput {
    return {
        charId: 'char-a',
        sender: { type: 'character', id: 'char-a', name: '小星' },
        recipient: { type: 'user', name: '你' },
        gift: { name: '星星手链', description: '一条很闪的手链', note: '¥129.00' },
        source: 'phone_order',
        eventKeyRef: 'rec-1001',
        origin: { kind: 'order-record', refId: 'rec-1001' },
        ...overrides,
    };
}

describe('giftEventHub — 统一礼物事件入口（Phase 1）', () => {
    it('Test 1 — 落库与默认值：status delivered / image none / triggerSource autonomous / origin 透传', async () => {
        const { record, created } = await recordGiftEvent(makeInput());
        expect(created).toBe(true);
        expect(record.schemaVersion).toBe(1);
        expect(record.status).toBe('delivered');
        expect(record.image).toEqual({ origin: 'none', status: 'none' });
        expect(record.triggerSource).toBe('autonomous');
        expect(record.origin).toEqual({ kind: 'order-record', refId: 'rec-1001' });
        // Party 解析：user 缺省 id → 保留 'user'；name 写入 nameSnapshot
        expect(record.sender).toEqual({ type: 'character', id: 'char-a', nameSnapshot: '小星' });
        expect(record.recipient).toEqual({ type: 'user', id: 'user', nameSnapshot: '你' });
        expect(record.source).toBe('phone_order');
    });

    it('Test 2 — eventKey 集中生成：`gift:{source}:{charId}:{ref}` 格式', async () => {
        expect(buildGiftEventKey('phone_order', 'char-a', 'rec-1')).toBe('gift:phone_order:char-a:rec-1');
        const { record } = await recordGiftEvent(makeInput());
        expect(record.eventKey).toBe('gift:phone_order:char-a:rec-1001');
        expect(await getGiftRecordByEventKey('gift:phone_order:char-a:rec-1001')).not.toBeNull();
    });

    it('Test 3 — 显式 eventKey 优先于 eventKeyRef', async () => {
        const { record } = await recordGiftEvent(makeInput({ eventKey: 'gift:test:explicit-key' }));
        expect(record.eventKey).toBe('gift:test:explicit-key');
    });

    it('Test 4 — 幂等：同一 eventKeyRef 重放 created=false，返回既有记录，库中仅一条', async () => {
        const first = await recordGiftEvent(makeInput());
        const second = await recordGiftEvent(makeInput({ gift: { name: '另一个名字' } }));
        expect(first.created).toBe(true);
        expect(second.created).toBe(false);
        expect(second.record.id).toBe(first.record.id);
        // 幂等命中返回的是既有记录，不采用第二次的载荷
        expect(second.record.gift.name).toBe('星星手链');
        expect(await listGiftRecords()).toHaveLength(1);
    });

    it('Test 5 — 副作用只在新落库时执行：重放不重复投影 / 提交记忆', async () => {
        const opts = { chatProjection: { enabled: true }, memoryCommit: { enabled: true } };
        await recordGiftEvent(makeInput(), opts);
        await recordGiftEvent(makeInput(), opts);
        await recordGiftEvent(makeInput(), opts);
        expect(projectGiftToChat).toHaveBeenCalledTimes(1);
        expect(commitGiftMemoryCandidate).toHaveBeenCalledTimes(1);
    });

    it('Test 6 — 副作用默认关闭：不传 opts 不触发投影 / 记忆', async () => {
        await recordGiftEvent(makeInput());
        expect(projectGiftToChat).not.toHaveBeenCalled();
        expect(commitGiftMemoryCandidate).not.toHaveBeenCalled();
    });

    it('Test 7 — 投影失败静默降级：礼物本体已落库，recordGiftEvent 不抛错', async () => {
        vi.mocked(projectGiftToChat).mockRejectedValueOnce(new Error('bridge boom'));
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });
        const { record, created } = await recordGiftEvent(makeInput(), { chatProjection: { enabled: true } });
        expect(created).toBe(true);
        expect(await getGiftRecordByEventKey(record.eventKey)).not.toBeNull();
        expect(warnSpy).toHaveBeenCalled();
        warnSpy.mockRestore();
    });

    it('Test 8 — 记忆提交失败静默降级', async () => {
        vi.mocked(commitGiftMemoryCandidate).mockRejectedValueOnce(new Error('memory boom'));
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });
        const { created } = await recordGiftEvent(makeInput(), { memoryCommit: { enabled: true } });
        expect(created).toBe(true);
        expect(warnSpy).toHaveBeenCalled();
        warnSpy.mockRestore();
    });

    it('Test 9 — 落库失败透传 throw（不被副作用语义吞掉）', async () => {
        mockState.failCreateGift = true;
        await expect(recordGiftEvent(makeInput())).rejects.toThrow('idb down');
        mockState.failCreateGift = false;
    });

    it('Test 10 — 校验错误：缺 gift.name / 缺 charId / character 无 id / eventKey 与 eventKeyRef 全缺', async () => {
        await expect(recordGiftEvent(makeInput({ gift: { name: ' ' } }))).rejects.toThrow('gift.name');
        await expect(recordGiftEvent(makeInput({ charId: '' }))).rejects.toThrow('charId');
        await expect(recordGiftEvent(makeInput({
            sender: { type: 'character', name: '小星' },
        }))).rejects.toThrow('sender.id');
        await expect(recordGiftEvent(makeInput({ eventKey: undefined, eventKeyRef: undefined })))
            .rejects.toThrow('eventKeyRef');
        await expect(recordGiftEvent(makeInput({ source: 'unknown_source' as GiftEventInput['source'] })))
            .rejects.toThrow('unknown');
        // 校验失败不应落任何库
        expect(await listGiftRecords()).toHaveLength(0);
    });

    it('Test 11 — 三种方向：玩家→角色 / 角色→玩家 / 角色→角色（未来扩展位）', async () => {
        const playerToChar = await recordGiftEvent(makeInput({
            sender: { type: 'user', name: '你' },
            recipient: { type: 'character', id: 'char-a', name: '小星' },
            source: 'gift_app',
            eventKeyRef: 's1',
        }));
        expect(playerToChar.record.sender.type).toBe('user');
        expect(playerToChar.record.recipient.type).toBe('character');

        const charToChar = await recordGiftEvent(makeInput({
            sender: { type: 'character', id: 'char-a', name: '小星' },
            recipient: { type: 'character', id: 'char-b', name: '阿月' },
            source: 'story',
            eventKeyRef: 's2',
        }));
        expect(charToChar.record.sender.id).toBe('char-a');
        expect(charToChar.record.recipient.id).toBe('char-b');
        // 本用例内新建 2 条（beforeEach 已清库）
        expect(await listGiftRecords()).toHaveLength(2);
    });

    it('Test 12 — 空 gift.description/note 归一为 undefined（不落空字符串）', async () => {
        const { record } = await recordGiftEvent(makeInput({
            gift: { name: '围巾', description: '  ', note: '' },
            eventKeyRef: 's3',
        }));
        expect(record.gift.description).toBeUndefined();
        expect(record.gift.note).toBeUndefined();
    });
});
