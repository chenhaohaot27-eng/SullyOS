import { describe, expect, it, beforeEach } from 'vitest';
import {
    buildChatPhotoAutonomyPrompt,
    buildChatPhotoTagGuide,
    claimChatPhotoTurn,
    chatPhotoIntentKey,
    extractChatPhotoIntent,
    isChatPhotoTagEnabled,
    resetChatPhotoTurnClaimsForTests,
} from './chatPhotoIntent';
import { IMAGE_GENERATION_CONFIG_STORAGE_KEY } from './imageGenerationConfig';
import { ChatPrompts } from './chatPrompts';

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

    it('容全角引号 / 全角冒号键 / 尾逗号（中文模型高频错误，修复“只说发了一张照片”退化）', () => {
        // 全角双引号包键值
        const fq = extractChatPhotoIntent('[[SEND_PHOTO: {"prompt":"窗外的夜景", "caption":"你看", "includeCharacter":false,}]]');
        expect(fq.intent).toEqual({ prompt: '窗外的夜景', caption: '你看', includeCharacter: false, style: '' });
        // 全角冒号键分隔
        const fc = extractChatPhotoIntent('[[SEND_PHOTO: {"prompt":"a desk"}]]');
        expect(fc.intent?.prompt).toBe('a desk');
        // 数组里的尾逗号 + 围栏
        const trail = extractChatPhotoIntent('[[SEND_PHOTO: ```json\n{"prompt":"a room", "style":"soft",}\n```]]');
        expect(trail.intent?.style).toBe('soft');
    });

    it('tagCount 记录标签出现次数（诊断用）', () => {
        expect(extractChatPhotoIntent('没有标签').tagCount).toBe(0);
        expect(extractChatPhotoIntent(TAG('{"prompt":"x"}') + TAG('bad')).tagCount).toBe(2);
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

    it('指南允许角色自主发图（解除"只有明确要求才可"限制），显式请求仍被保留', () => {
        const guide = buildChatPhotoTagGuide();
        // 不再限制为只有玩家明确要求才可使用
        expect(guide).not.toContain('只有当对方');
        // 自主授权 + 自然场景 + 无机械频率
        expect(guide).toContain('自主决定');
        expect(guide).toContain('自拍');
        expect(guide).toContain('生活日常');
        expect(guide).toContain('宠物');
        expect(guide).toContain('不设固定频率');
        // 玩家明确要求依旧有效
        expect(guide).toContain('明确要求');
        // 防伪造与协议约束保留
        expect(guide).toContain('严禁');
        expect(guide).not.toContain('假装发了照片——没被要求'); // 旧文案已更新为新语义
    });

    it('自主视觉分享判断入口：每轮思考、依据自身情境而非关键词、不必先问、禁止编造', () => {
        const autonomy = buildChatPhotoAutonomyPrompt();
        // 决策入口：每轮都要想
        expect(autonomy).toContain('每次回复前想一想');
        // 判断材料：自身性格/状态/近期经历 + 场景，不依赖玩家关键词
        expect(autonomy).toContain('性格');
        expect(autonomy).toContain('近期经历');
        expect(autonomy).toContain('不是');
        expect(autonomy).toContain('照片');   // "不是对方最后一句话有没有提到'照片'"
        // 自然场景类别
        for (const scene of ['自拍', '风景', '宠物', '正在吃的东西', '个人物品', '环境']) {
            expect(autonomy).toContain(scene);
        }
        // 直接发、不必先问；不强制、无频率
        expect(autonomy).toContain('不必先问对方想不想看');
        expect(autonomy).toContain('不要求每轮都发');
        expect(autonomy).toContain('没有任何频率指标');
        // 防编造：必须与世界观/当前状态一致
        expect(autonomy).toContain('严禁编造');
        expect(autonomy).toContain('世界观');
    });

    it('最终组装的 system prompt：启用时决策入口与协议教学同时进入，未启用/打包时不进入', async () => {
        const char = { id: 'char-auto', name: '阿照' } as any;
        const userProfile = { name: '小明' } as any;
        const buildStable = async (promptOptions?: { forFirePack?: boolean }) => {
            const parts = await ChatPrompts.buildSystemPromptParts(
                char, userProfile, [], [], [], [],
                undefined, undefined, undefined, undefined, undefined, undefined, undefined,
                promptOptions,
            );
            return parts.stable;
        };
        // 启用：两块都进最终 prompt（玩家只聊日常生活时同样注入——与玩家是否提到照片无关）
        localStorage.setItem(IMAGE_GENERATION_CONFIG_STORAGE_KEY, JSON.stringify({ enabled: true }));
        const enabled = await buildStable();
        expect(enabled).toContain('自主视觉分享');
        expect(enabled).toContain('每次回复前想一想');
        expect(enabled).toContain('[[SEND_PHOTO');
        // 未启用：两块都不进
        localStorage.removeItem(IMAGE_GENERATION_CONFIG_STORAGE_KEY);
        const disabled = await buildStable();
        expect(disabled).not.toContain('自主视觉分享');
        expect(disabled).not.toContain('[[SEND_PHOTO');
        // fire_pack（后台主动消息模板）：不进（后台生图能力是独立待办）
        localStorage.setItem(IMAGE_GENERATION_CONFIG_STORAGE_KEY, JSON.stringify({ enabled: true }));
        const packed = await buildStable({ forFirePack: true });
        expect(packed).not.toContain('自主视觉分享');
        expect(packed).not.toContain('[[SEND_PHOTO');
    });
});
