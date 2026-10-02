import { describe, expect, it, beforeEach } from 'vitest';
import {
    buildChatPhotoTagGuide,
    claimChatPhotoTurn,
    chatPhotoIntentKey,
    extractChatPhotoIntent,
    isChatPhotoTagEnabled,
    resetChatPhotoTurnClaimsForTests,
} from './chatPhotoIntent';
import { IMAGE_GENERATION_CONFIG_STORAGE_KEY } from './imageGenerationConfig';

const TAG = (payload: string) => `[[SEND_PHOTO: ${payload}]]`;

describe('extractChatPhotoIntent', () => {
    it('明确拍照请求的合法标签 → 解析出完整意图并从正文剥掉', () => {
        const out = extractChatPhotoIntent(
            '好呀，等我一下\n' + TAG('{"prompt":"cozy night city street, neon reflections, light rain","caption":"楼下刚下过雨～","includeCharacter":true,"style":"cinematic"}'),
        );
        expect(out.intent).toEqual({
            prompt: 'cozy night city street, neon reflections, light rain',
            caption: '楼下刚下过雨～',
            includeCharacter: true,
            style: 'cinematic',
        });
        expect(out.cleanedContent).toBe('好呀，等我一下');
        expect(out.invalidTagFound).toBe(false);
    });

    it('普通聊天不触发：无标签时内容原样返回、意图为空', () => {
        const out = extractChatPhotoIntent('今天好累啊\n明天再聊吧');
        expect(out.intent).toBeNull();
        expect(out.cleanedContent).toBe('今天好累啊\n明天再聊吧');
        expect(out.invalidTagFound).toBe(false);
    });

    it('意图控制内容不显示：解析失败/非法 payload 的标签同样整段剥掉', () => {
        const out = extractChatPhotoIntent('看看这个\n' + TAG('{"caption":"没有prompt"}') + '\n还有这个\n' + TAG('not json at all'));
        expect(out.intent).toBeNull();
        expect(out.invalidTagFound).toBe(true);
        expect(out.cleanedContent).toBe('看看这个\n还有这个');
        expect(out.cleanedContent).not.toContain('SEND_PHOTO');
        expect(out.cleanedContent).not.toContain('caption');
    });

    it('容全角冒号与 ```json 围栏', () => {
        const full = extractChatPhotoIntent('[[SEND_PHOTO：{"prompt":"a cat"}]]');
        expect(full.intent?.prompt).toBe('a cat');
        const fenced = extractChatPhotoIntent('[[SEND_PHOTO: ```json\n{"prompt":"a dog"}\n```]]');
        expect(fenced.intent?.prompt).toBe('a dog');
    });

    it('includeCharacter 缺省为 false；超长字段被截断；非布尔值不当作 true', () => {
        const out = extractChatPhotoIntent(TAG('{"prompt":"x","includeCharacter":"yes"}'));
        expect(out.intent?.includeCharacter).toBe(false);
        const long = 'p'.repeat(5000);
        const capped = extractChatPhotoIntent(TAG(JSON.stringify({ prompt: long, caption: long, style: long })));
        expect(capped.intent?.prompt.length).toBe(1200);
        expect(capped.intent?.caption.length).toBe(200);
        expect(capped.intent?.style.length).toBe(400);
    });

    it('多个标签只认第一个合法的（一轮只拍一次）', () => {
        const out = extractChatPhotoIntent(TAG('{"prompt":"first"}') + '\n中间的话\n' + TAG('{"prompt":"second"}'));
        expect(out.intent?.prompt).toBe('first');
        expect(out.cleanedContent).toBe('中间的话');
    });
});

describe('claimChatPhotoTurn（一轮一次防重复扣费）', () => {
    beforeEach(() => resetChatPhotoTurnClaimsForTests());

    it('同一 key 第二次 claim 被拒绝，TTL 过期后放行', () => {
        const key = 'char-1:abc';
        expect(claimChatPhotoTurn(key, 1_000)).toBe(true);
        expect(claimChatPhotoTurn(key, 2_000)).toBe(false);
        expect(claimChatPhotoTurn(key, 1_000 + 90_001)).toBe(true);
    });

    it('不同 prompt / 不同角色是不同的 key', () => {
        const a = chatPhotoIntentKey('char-a', { prompt: 'p1', caption: '', includeCharacter: false, style: '' });
        const b = chatPhotoIntentKey('char-a', { prompt: 'p2', caption: '', includeCharacter: false, style: '' });
        const c = chatPhotoIntentKey('char-b', { prompt: 'p1', caption: '', includeCharacter: false, style: '' });
        expect(new Set([a, b, c]).size).toBe(3);
    });
});

describe('提示词注入门控', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('生图配置未启用时不教标签，启用后才教', () => {
        expect(isChatPhotoTagEnabled()).toBe(false);
        localStorage.setItem(IMAGE_GENERATION_CONFIG_STORAGE_KEY, JSON.stringify({ enabled: true }));
        expect(isChatPhotoTagEnabled()).toBe(true);
    });

    it('指南包含协议必备字段与防伪造约束', () => {
        const guide = buildChatPhotoTagGuide();
        expect(guide).toContain('SEND_PHOTO');
        expect(guide).toContain('includeCharacter');
        expect(guide).toContain('最多一个');
        expect(guide).toContain('严禁');
    });
});
