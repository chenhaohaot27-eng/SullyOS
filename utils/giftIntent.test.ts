import { describe, expect, it } from 'vitest';
import {
    buildGiftReactionInstruction,
    buildGiftSendTagGuide,
    extractGiftReactIntent,
    extractGiftSendIntent,
    giftSendIntentKey,
    isGiftSendTagEnabled,
    stripGiftReactIntent,
} from './giftIntent';
import type { GiftRecord } from './giftTypes';

const TAG = (payload: string) => `[[GIFT_REACT: ${payload}]]`;

const VALID = JSON.stringify({
    giftId: 'gift_x1',
    review: '亲手织的，挺意外',
    disposition: '收进抽屉',
    acceptance: 'accepted',
    affinityImpact: 'positive',
    moodImpact: ['意外', '开心'],
    memoryImportance: 'meaningful',
    memorySummary: '她第一次亲手织东西送给我。',
});

const makeGift = (over: Partial<GiftRecord> = {}): GiftRecord => ({
    schemaVersion: 1,
    id: 'gift_x1',
    eventKey: 'gift:user:c1:s1',
    charId: 'c1',
    sender: { type: 'user', id: 'user', nameSnapshot: '玩家' },
    recipient: { type: 'character', id: 'c1', nameSnapshot: '小星' },
    source: 'gift_app',
    gift: { name: '深蓝色围巾', description: '她自己织的。', note: '天气冷了记得戴。' },
    image: { origin: 'gallery', status: 'ready', imageRef: 'blobref:x', visualSummary: '一条深蓝色针织围巾。' },
    status: 'delivered',
    createdAt: 1,
    updatedAt: 1,
    ...over,
});

describe('extractGiftReactIntent — GIFT_REACT 解析', () => {
    it('合法标签：解析出完整意图并从正文剥掉', () => {
        const out = extractGiftReactIntent(`你自己织的？\n\n${TAG(VALID)}`);
        expect(out.intent).toMatchObject({
            giftId: 'gift_x1',
            acceptance: 'accepted',
            affinityImpact: 'positive',
            moodImpact: ['意外', '开心'],
            memoryImportance: 'meaningful',
        });
        expect(out.cleanedContent).toBe('你自己织的？');
        expect(out.cleanedContent).not.toContain('GIFT_REACT');
        expect(out.invalidTagFound).toBe(false);
    });

    it('无标签：原样返回、意图为空', () => {
        const out = extractGiftReactIntent('今天也要加油呀');
        expect(out.intent).toBeNull();
        expect(out.cleanedContent).toBe('今天也要加油呀');
    });

    it('非法 JSON：意图作废，标签仍被剥掉', () => {
        const out = extractGiftReactIntent(`看看\n${TAG('not json at all')}`);
        expect(out.intent).toBeNull();
        expect(out.invalidTagFound).toBe(true);
        expect(out.cleanedContent).toBe('看看');
    });

    it('非法枚举 acceptance：意图作废', () => {
        const bad = JSON.stringify({ giftId: 'gift_x1', acceptance: 'love_it' });
        const out = extractGiftReactIntent(TAG(bad));
        expect(out.intent).toBeNull();
        expect(out.invalidTagFound).toBe(true);
    });

    it('非法 affinityImpact / memoryImportance 枚举：字段丢弃但意图保留', () => {
        const payload = JSON.stringify({
            giftId: 'gift_x1', acceptance: 'rejected',
            affinityImpact: '+999', memoryImportance: 'huge',
        });
        const out = extractGiftReactIntent(TAG(payload));
        expect(out.intent).not.toBeNull();
        expect(out.intent!.acceptance).toBe('rejected');
        expect(out.intent!.affinityImpact).toBeUndefined();
        expect(out.intent!.memoryImportance).toBeUndefined();
    });

    it('数值好感注入 affinityDelta 不进入意图', () => {
        const payload = JSON.stringify({
            giftId: 'gift_x1', acceptance: 'accepted',
            affinityDelta: 5, relationshipScore: 99, '好感度': '+5',
        });
        const out = extractGiftReactIntent(TAG(payload));
        expect(out.intent).not.toBeNull();
        expect(JSON.stringify(out.intent!)).not.toContain('affinityDelta');
        expect(JSON.stringify(out.intent!)).not.toContain('relationshipScore');
    });

    it('超长字段按上限裁剪；moodImpact 最多 4 项', () => {
        const payload = JSON.stringify({
            giftId: 'gift_x1',
            acceptance: 'accepted',
            review: 'r'.repeat(2000),
            disposition: 'd'.repeat(1000),
            moodImpact: ['a', 'b', 'c', 'd', 'e', 'f'],
            memorySummary: 'm'.repeat(2000),
        });
        const out = extractGiftReactIntent(TAG(payload));
        expect(out.intent!.review.length).toBe(500);
        expect(out.intent!.disposition.length).toBe(300);
        expect(out.intent!.moodImpact).toHaveLength(4);
        expect(out.intent!.memorySummary!.length).toBe(500);
    });

    it('多个标签只认第一个合法的（与 SEND_PHOTO 策略一致）', () => {
        const second = JSON.stringify({ giftId: 'gift_x2', acceptance: 'rejected' });
        const out = extractGiftReactIntent(`话\n${TAG('broken')}\n中间\n${TAG(VALID)}\n尾部\n${TAG(second)}`);
        expect(out.intent!.giftId).toBe('gift_x1');
        expect(out.cleanedContent).toBe('话\n中间\n尾部');
    });

    it('stripGiftReactIntent 清理所有标签', () => {
        expect(stripGiftReactIntent(`A\n${TAG(VALID)}\nB`)).toBe('A\nB');
    });

    it('容全角冒号与 ```json 围栏', () => {
        const full = extractGiftReactIntent(`[[GIFT_REACT：${VALID}]]`);
        expect(full.intent?.giftId).toBe('gift_x1');
        const fenced = extractGiftReactIntent(TAG('```json\n' + VALID + '\n```'));
        expect(fenced.intent?.giftId).toBe('gift_x1');
    });
});

describe('buildGiftReactionInstruction — 回应指令', () => {
    it('包含礼物信息、visualSummary、giftId 与协议', () => {
        const text = buildGiftReactionInstruction(makeGift(), { userName: '阿晚' });
        expect(text).toContain('深蓝色围巾');
        expect(text).toContain('一条深蓝色针织围巾。');
        expect(text).toContain('gift_x1');
        expect(text).toContain('GIFT_REACT');
        expect(text).toContain('acceptance');
        expect(text).toContain('不是假设');
    });

    it('无 visualSummary 时明示不可用并禁止编造视觉细节', () => {
        const gift = makeGift({ image: { origin: 'gallery', status: 'ready', imageRef: 'blobref:x' } });
        const text = buildGiftReactionInstruction(gift, { userName: '阿晚' });
        expect(text).toContain('图片识别：不可用');
        expect(text).toContain('不要自行编造');
    });

    it('纯文字礼物不出现图片识别行；禁止数值好感', () => {
        const gift = makeGift({ image: { origin: 'none', status: 'none' } });
        const text = buildGiftReactionInstruction(gift, { userName: '阿晚' });
        expect(text).not.toContain('图片识别');
        expect(text).toContain('严禁输出任何数值好感');
    });
});

describe('extractGiftSendIntent — GIFT_SEND 解析（Phase 4）', () => {
    const SEND_TAG = (payload: string) => `[[GIFT_SEND: ${payload}]]`;
    const VALID_SEND = JSON.stringify({
        name: '深蓝色羊绒围巾',
        description: '一条柔软的深蓝色围巾。',
        note: '外面风大，戴上。',
        imagePrompt: 'A neatly folded deep navy cashmere scarf on a wooden table, soft light',
        includeCharacter: false,
        style: 'realistic',
    });

    it('合法标签：解析白名单字段并从正文剥掉', () => {
        const out = extractGiftSendIntent(`给你买了条围巾。\n${SEND_TAG(VALID_SEND)}`);
        expect(out.intent).toMatchObject({
            name: '深蓝色羊绒围巾',
            description: '一条柔软的深蓝色围巾。',
            note: '外面风大，戴上。',
            includeCharacter: false,
            style: 'realistic',
        });
        expect(out.cleanedContent).toBe('给你买了条围巾。');
        expect(out.cleanedContent).not.toContain('GIFT_SEND');
    });

    it('缺 name：意图作废但标签仍剥掉', () => {
        const bad = JSON.stringify({ imagePrompt: 'a scarf' });
        const out = extractGiftSendIntent(`话\n${SEND_TAG(bad)}`);
        expect(out.intent).toBeNull();
        expect(out.invalidTagFound).toBe(true);
        expect(out.cleanedContent).toBe('话');
    });

    it('缺 imagePrompt：意图作废', () => {
        const bad = JSON.stringify({ name: '围巾' });
        expect(extractGiftSendIntent(SEND_TAG(bad)).intent).toBeNull();
    });

    it('非法 includeCharacter（非布尔）：意图作废', () => {
        const bad = JSON.stringify({ name: '围巾', imagePrompt: 'a scarf', includeCharacter: 'yes' });
        expect(extractGiftSendIntent(SEND_TAG(bad)).intent).toBeNull();
    });

    it('禁止字段（id/giftId/eventKey/sender/status/provider/apiKey/imageRef/affinityDelta）不进入意图', () => {
        const dirty = JSON.stringify({
            name: '围巾', imagePrompt: 'a scarf',
            giftId: 'hack', id: 'hack', eventKey: 'hack',
            senderId: 'hack', recipientId: 'hack', charId: 'hack',
            imageRef: 'blobref:hack', imageUrl: 'https://hack', provider: 'openai',
            baseUrl: 'https://hack', apiKey: 'sk-hack', model: 'hack',
            status: 'delivered', createdAt: 1, deliveredAt: 1,
            affinityDelta: 5, relationshipScore: 99, memoryId: 'hack',
        });
        const out = extractGiftSendIntent(SEND_TAG(dirty));
        expect(out.intent).not.toBeNull();
        const json = JSON.stringify(out.intent!);
        for (const forbidden of ['hack', 'sk-hack', 'affinityDelta', 'relationshipScore', 'memoryId', 'provider', 'status']) {
            expect(json).not.toContain(forbidden);
        }
    });

    it('多个 GIFT_SEND 只认第一个合法的；一条回复最多一份礼物', () => {
        const second = JSON.stringify({ name: '第二份', imagePrompt: 'b' });
        const out = extractGiftSendIntent(`话\n${SEND_TAG(VALID_SEND)}\n中间\n${SEND_TAG(second)}`);
        expect(out.intent!.name).toBe('深蓝色羊绒围巾');
        expect(out.cleanedContent).toBe('话\n中间');
    });

    it('giftSendIntentKey：同角色同意图同 key，不同意图不同 key', () => {
        const intent = extractGiftSendIntent(SEND_TAG(VALID_SEND)).intent!;
        const same = extractGiftSendIntent(SEND_TAG(VALID_SEND)).intent!;
        expect(giftSendIntentKey('c1', intent)).toBe(giftSendIntentKey('c1', same));
        expect(giftSendIntentKey('c2', intent)).not.toBe(giftSendIntentKey('c1', intent));
        expect(giftSendIntentKey('c1', { ...intent, name: '另一份' })).not.toBe(giftSendIntentKey('c1', intent));
    });

    it('isGiftSendTagEnabled / buildGiftSendTagGuide 基本形态', () => {
        // 测试环境无生图配置 → 默认不教
        expect(isGiftSendTagEnabled()).toBe(false);
        const guide = buildGiftSendTagGuide();
        expect(guide).toContain('GIFT_SEND');
        expect(guide).toContain('SEND_PHOTO');
        expect(guide).toContain('不要频繁使用');
    });
});
