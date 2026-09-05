import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DB, openDB } from './db';
import {
    createGiftRecord,
    deleteGiftRecord,
    getGiftRecord,
    getGiftRecordByEventKey,
    listGiftRecords,
    listGiftRecordsByChar,
    updateGiftRecord,
    type CreateGiftRecordInput,
} from './giftStore';

// fake-indexeddb 已通过 test-setup.ts 注入（同 db.test.ts / livingWorld/store.test.ts）。
beforeEach(async () => {
    await DB.deleteDB();
});

afterEach(() => {
    vi.restoreAllMocks();
});

const USER = { type: 'user' as const, id: 'user-main', nameSnapshot: '玩家' };
const CHAR_A = { type: 'character' as const, id: 'char-a', nameSnapshot: '小星' };
const CHAR_B = { type: 'character' as const, id: 'char-b', nameSnapshot: '阿月' };

function makeInput(overrides: Partial<CreateGiftRecordInput> = {}): CreateGiftRecordInput {
    return {
        eventKey: 'gift:player_to_char:char-a:t1',
        charId: 'char-a',
        sender: USER,
        recipient: CHAR_A,
        source: 'gift_app',
        gift: { name: '星星手链', description: '一条很闪的手链', note: '送给你' },
        status: 'pending',
        ...overrides,
    };
}

// 让 createdAt/updatedAt 可预测：每次 Date.now() 递增 10ms（不同礼物天然时间不同）。
function useDeterministicClock(start = 1_000_000): void {
    let t = start;
    vi.spyOn(Date, 'now').mockImplementation(() => (t += 10));
}

describe('giftStore — gift_records 数据底座', () => {
    it('fresh DB 升级后存在 gift_records store（DB_VERSION v73）', async () => {
        const db = await openDB();
        expect(db.objectStoreNames.contains('gift_records')).toBe(true);
        const store = db.transaction('gift_records', 'readonly').objectStore('gift_records');
        expect(store.indexNames.contains('eventKey')).toBe(true);
        expect(store.indexNames.contains('charId')).toBe(true);
        expect(store.indexNames.contains('createdAt')).toBe(true);
    });

    it('Test 1 — create/read：按 id 读取，字段保持完整', async () => {
        const { record, created } = await createGiftRecord(makeInput({
            image: { imageRef: 'blobref:test-gift-image', origin: 'gallery', status: 'ready' },
            chat: { triggerMessageId: 'm-1', cardMessageId: 'm-2' },
        }));
        expect(created).toBe(true);
        expect(record.id).toBeTruthy();
        expect(record.schemaVersion).toBe(1);

        const loaded = await getGiftRecord(record.id);
        expect(loaded).not.toBeNull();
        expect(loaded!.eventKey).toBe('gift:player_to_char:char-a:t1');
        expect(loaded!.charId).toBe('char-a');
        expect(loaded!.sender).toEqual(USER);
        expect(loaded!.recipient).toEqual(CHAR_A);
        expect(loaded!.source).toBe('gift_app');
        expect(loaded!.gift).toEqual({ name: '星星手链', description: '一条很闪的手链', note: '送给你' });
        expect(loaded!.image.imageRef).toBe('blobref:test-gift-image');
        expect(loaded!.chat).toEqual({ triggerMessageId: 'm-1', cardMessageId: 'm-2' });
        expect(loaded!.createdAt).toBe(record.createdAt);
        expect(loaded!.updatedAt).toBe(record.updatedAt);
    });

    it('Test 2 — eventKey 顺序去重：第二次 created=false，库中只剩一条', async () => {
        const first = await createGiftRecord(makeInput());
        const second = await createGiftRecord(makeInput({ gift: { name: '另一份礼物' } }));
        expect(first.created).toBe(true);
        expect(second.created).toBe(false);
        // 幂等命中返回的是既有记录，不采用第二次的载荷
        expect(second.record.id).toBe(first.record.id);
        expect(second.record.gift.name).toBe('星星手链');

        expect(await listGiftRecords()).toHaveLength(1);
    });

    it('Test 3 — eventKey 并发去重：Promise.all 双写最终只落一条，无未处理 ConstraintError', async () => {
        const input = makeInput({ eventKey: 'gift:player_to_char:char-a:concurrent' });
        const results = await Promise.all([
            createGiftRecord(input),
            createGiftRecord({ ...input }),
        ]);
        expect(results.filter(r => r.created)).toHaveLength(1);
        expect(results.filter(r => !r.created)).toHaveLength(1);
        // 两条结果指向同一条记录
        expect(new Set(results.map(r => r.record.id)).size).toBe(1);
        expect(await listGiftRecords()).toHaveLength(1);
    });

    it('Test 4 — 不同 eventKey 正常生成不同记录', async () => {
        const a = await createGiftRecord(makeInput({ eventKey: 'gift:e1' }));
        const b = await createGiftRecord(makeInput({ eventKey: 'gift:e2' }));
        expect(a.created).toBe(true);
        expect(b.created).toBe(true);
        expect(a.record.id).not.toBe(b.record.id);
        expect(await getGiftRecordByEventKey('gift:e1')).not.toBeNull();
        expect(await getGiftRecordByEventKey('gift:e2')).not.toBeNull();
        expect(await listGiftRecords()).toHaveLength(2);
    });

    it('Test 5 — update：status/reaction/image 可更新，id/eventKey/createdAt 不可变，updatedAt 刷新', async () => {
        useDeterministicClock();
        const { record } = await createGiftRecord(makeInput());
        const updated = await updateGiftRecord(record.id, {
            status: 'delivered',
            deliveredAt: Date.now(),
            reaction: { review: '她很喜欢', acceptance: 'accepted' },
            image: { imageRef: 'blobref:test-gift-image', origin: 'gallery', status: 'ready' },
            // 以下三项试图篡改，必须被忽略
            id: 'hacked-id',
            eventKey: 'hacked-event-key',
            createdAt: 0,
        } as Parameters<typeof updateGiftRecord>[1]);

        expect(updated).not.toBeNull();
        expect(updated!.id).toBe(record.id);
        expect(updated!.eventKey).toBe(record.eventKey);
        expect(updated!.createdAt).toBe(record.createdAt);
        expect(updated!.status).toBe('delivered');
        expect(updated!.reaction?.acceptance).toBe('accepted');
        expect(updated!.image.status).toBe('ready');
        expect(updated!.updatedAt).toBeGreaterThan(record.createdAt);

        // 落库后的值同样不可变
        const persisted = await getGiftRecord(record.id);
        expect(persisted!.id).toBe(record.id);
        expect(persisted!.eventKey).toBe(record.eventKey);
        expect(persisted!.createdAt).toBe(record.createdAt);

        // 不存在的记录返回 null，绝不静默创建
        expect(await updateGiftRecord('gift:no-such', { status: 'failed' })).toBeNull();
    });

    it('Test 6 — list 按 createdAt DESC 排序', async () => {
        useDeterministicClock();
        const first = await createGiftRecord(makeInput({ eventKey: 'gift:oldest', charId: 'char-a', recipient: CHAR_A }));
        const second = await createGiftRecord(makeInput({ eventKey: 'gift:middle', charId: 'char-a', recipient: CHAR_A }));
        const third = await createGiftRecord(makeInput({ eventKey: 'gift:newest', charId: 'char-a', recipient: CHAR_A }));
        const list = await listGiftRecords();
        expect(list.map(r => r.eventKey)).toEqual(['gift:newest', 'gift:middle', 'gift:oldest']);
        expect(list[0].createdAt).toBeGreaterThan(list[2].createdAt);
        expect(first.record.createdAt).toBeLessThan(second.record.createdAt);
        expect(second.record.createdAt).toBeLessThan(third.record.createdAt);
    });

    it('Test 7 — charId 过滤只返回目标角色', async () => {
        await createGiftRecord(makeInput({ eventKey: 'gift:a1', charId: 'char-a', recipient: CHAR_A }));
        await createGiftRecord(makeInput({ eventKey: 'gift:a2', charId: 'char-a', recipient: CHAR_A }));
        await createGiftRecord(makeInput({
            eventKey: 'gift:b1', charId: 'char-b', sender: CHAR_A, recipient: CHAR_B,
        }));

        expect(await listGiftRecords({ charId: 'char-a' })).toHaveLength(2);
        expect(await listGiftRecordsByChar('char-b')).toHaveLength(1);
        expect((await listGiftRecordsByChar('char-b'))[0].charId).toBe('char-b');
        expect(await listGiftRecords()).toHaveLength(3);
    });

    it('Test 8 — imageRef 作为不透明字符串原样持久化（本阶段不解析 blob）', async () => {
        const ref = 'blobref:test-gift-image';
        const { record } = await createGiftRecord(makeInput({
            image: { imageRef: ref, origin: 'camera', status: 'ready' },
        }));
        const loaded = await getGiftRecordByEventKey(record.eventKey);
        expect(loaded?.image.imageRef).toBe(ref);
        expect(loaded?.image.origin).toBe('camera');
    });

    it('delete 只删记录本身，重复删除返回 false', async () => {
        const { record } = await createGiftRecord(makeInput());
        expect(await deleteGiftRecord(record.id)).toBe(true);
        expect(await getGiftRecord(record.id)).toBeNull();
        expect(await listGiftRecords()).toHaveLength(0);
        expect(await deleteGiftRecord(record.id)).toBe(false);
    });

    it('create 校验必填字段，缺 eventKey / gift.name 直接抛错', async () => {
        await expect(createGiftRecord(makeInput({ eventKey: '' }))).rejects.toThrow('eventKey');
        await expect(createGiftRecord(makeInput({ gift: { name: '' } }))).rejects.toThrow('gift.name');
        await expect(createGiftRecord(makeInput({ sender: { type: 'user', id: '', nameSnapshot: 'x' } }))).rejects.toThrow('sender.id');
        await expect(createGiftRecord(makeInput({ recipient: { type: 'character', id: '', nameSnapshot: 'x' } }))).rejects.toThrow('recipient.id');
    });
});
