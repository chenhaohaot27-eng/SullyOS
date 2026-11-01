import { describe, expect, it, vi } from 'vitest';
import { normalizeAssistantActionFormatting as normalize } from './assistantActionFormat';
import { resolveEmojiByModelReference, normalizeEmojiModelReference } from './emojiResolver';
import { ChatParser } from './chatParser';
import { applyAssistantPostProcessing, PostProcessCtx, XhsCaches } from './applyAssistantPostProcessing';
import { DB } from './db';
import type { Emoji } from '../types';

// 表情包「只发文字不发图」稳定性修复的行为锁定：
//  1. 意图识别：半/全角标签、情绪标签前缀、独立成行与叙述式、文件名形态（assistantActionFormat）
//  2. 库存匹配：修饰词/扩展名清理、唯一命中、歧义不猜、泛名安全（emojiResolver）
//  3. 发送链路：识别到唯一匹配必须真正落库 type='emoji'，指令文字不重复出现
//     （applyAssistantPostProcessing，DB 走 fake-indexeddb，不调用真实付费 API）
//  4. 双语 / 历史回读路径不分叉

const inventory: Emoji[] = [
    { name: '敲头', url: 'https://cdn.example/knock.gif', categoryId: 'sys' },
    { name: '猫猫', url: 'https://cdn.example/cat.gif', categoryId: 'sys' },
    { name: '委屈', url: 'https://cdn.example/wuqu.gif', categoryId: 'sys' },
];

describe('意图识别：SEND_EMOJI 变体与自然语言发送表达', () => {
    it('标准标签（半角/全角冒号）与单括号掉格式都被归一为 canonical 标签', () => {
        expect(normalize('[[SEND_EMOJI: 敲头]]')).toBe('[[SEND_EMOJI: 敲头]]');
        expect(normalize('[[SEND_EMOJI：敲头]]')).toBe('[[SEND_EMOJI：敲头]]');
        expect(normalize('[SEND_EMOJI: 敲头]')).toBe('[[SEND_EMOJI: 敲头]]');
        expect(normalize('[SEND_EMOJI：敲头]')).toBe('[[SEND_EMOJI: 敲头]]');
    });

    it('自然语言发送表达（独立成行）转 canonical 标签', () => {
        expect(normalize('发送表情包：敲头')).toBe('[[SEND_EMOJI: 敲头]]');
        expect(normalize('发个表情包：敲头')).toBe('[[SEND_EMOJI: 敲头]]');
        expect(normalize('给你丢个敲头表情')).toBe('[[SEND_EMOJI: 敲头]]');
        expect(normalize('用那个敲头表情')).toBe('[[SEND_EMOJI: 敲头]]');
        expect(normalize('（给你发个敲头）')).toBe('[[SEND_EMOJI: 敲头]]');
        expect(normalize('敲头.jpg')).toBe('[[SEND_EMOJI: 敲头]]');
        expect(normalize('（发个表情包：敲头）')).toBe('[[SEND_EMOJI: 敲头]]');
    });

    it('情绪标签之后的发送指令同样被识别', () => {
        expect(normalize('[happy]发送表情包：敲头')).toBe('[[SEND_EMOJI: 敲头]]');
        expect(normalize('[开心]发个表情包：敲头')).toBe('[[SEND_EMOJI: 敲头]]');
        expect(normalize('[happy]给你丢个敲头表情')).toBe('[[SEND_EMOJI: 敲头]]');
    });

    it('普通聊天中提到表情包不得误判', () => {
        expect(normalize('这个表情包太好笑了')).toBe('这个表情包太好笑了');
        expect(normalize('我给你发个表情包')).toBe('我给你发个表情包');
        expect(normalize('我觉得你刚才那个表情很可爱')).toBe('我觉得你刚才那个表情很可爱');
        expect(normalize('她发了一个开心表情')).toBe('她发了一个开心表情');
        // 行内叙述与图片 URL 不动
        expect(normalize('我看你之前发的那张敲头表情挺好笑的')).toBe('我看你之前发的那张敲头表情挺好笑的');
        expect(normalize('https://cdn.example/knock.jpg')).toBe('https://cdn.example/knock.jpg');
        // 无括号包裹且无"表情"后缀的行文风险高，不转标签
        expect(normalize('给你发个红包')).toBe('给你发个红包');
        // 已转换的 canonical 标签幂等，不会被再次改写
        expect(normalize('[[SEND_EMOJI: 敲头]]')).toBe('[[SEND_EMOJI: 敲头]]');
    });

    it('前后正文行不受影响，只转命中的那一行', () => {
        expect(normalize('哼，不理你了\n发送表情包：敲头\n睡觉去了'))
            .toBe('哼，不理你了\n[[SEND_EMOJI: 敲头]]\n睡觉去了');
    });

    it('splitResponse 把半角/全角标签都拆成 emoji part', () => {
        expect(ChatParser.splitResponse('[[SEND_EMOJI: 敲头]]')).toEqual([{ type: 'emoji', content: '敲头' }]);
        expect(ChatParser.splitResponse('[[SEND_EMOJI：敲头]]')).toEqual([{ type: 'emoji', content: '敲头' }]);
    });
});

describe('库存匹配：修饰词/扩展名清理与歧义安全', () => {
    it('修饰词与扩展名被清理后精确命中同一张图', () => {
        const url = inventory[0].url;
        expect(resolveEmojiByModelReference('敲头', inventory).emoji?.url).toBe(url);
        expect(resolveEmojiByModelReference('敲头.jpg', inventory).emoji?.url).toBe(url);
        expect(resolveEmojiByModelReference('发送表情包：敲头', inventory).emoji?.url).toBe(url);
        expect(resolveEmojiByModelReference('那个敲头表情', inventory).emoji?.url).toBe(url);
        expect(resolveEmojiByModelReference('「敲头」', inventory).emoji?.url).toBe(url);
        expect(normalizeEmojiModelReference('（敲头.gif）')).toBe('敲头');
    });

    it('名称前后多修饰词不导致漏配', () => {
        expect(resolveEmojiByModelReference('那张敲头', inventory).emoji?.url).toBe(inventory[0].url);
        expect(normalizeEmojiModelReference('一张敲头')).toBe('敲头');
    });

    it('多个相近候选时不强行猜测（同名冲突不猜）', () => {
        const ambiguous: Emoji[] = [
            { name: '敲头', url: 'a', categoryId: 'sys' },
            { name: '敲头', url: 'b', categoryId: 'sys2' },
        ];
        expect(resolveEmojiByModelReference('敲头', ambiguous)).toMatchObject({
            emoji: null,
            reason: 'ambiguous-exact',
        });
        // 归一化层冲突同样不猜
        const normalizedCollision: Emoji[] = [
            { name: '敲头', url: 'a', categoryId: 'sys' },
            { name: '敲头.GIF', url: 'b', categoryId: 'sys2' },
        ];
        expect(resolveEmojiByModelReference('“敲头.jpg”', normalizedCollision)).toMatchObject({ emoji: null });
    });

    it('泛化名不参与子串兜底', () => {
        expect(resolveEmojiByModelReference('这张图在笑', [{ name: '笑', url: 'x' }])).toMatchObject({ emoji: null });
    });

    it('真实名称不被修饰词清理误伤', () => {
        expect(resolveEmojiByModelReference('那咋了', [{ name: '那咋了', url: 'x' }]).emoji?.url).toBe('x');
    });
});

// ─── 端到端落库链路（fake-indexeddb + 本地 mock 库存，无真实 API） ─────────────

const makeCtx = (charId: string, emojis: Emoji[]): PostProcessCtx => {
    const xhsCaches: XhsCaches = {
        xsecTokenCache: new Map(),
        noteTitleCache: new Map(),
        commentUserIdCache: new Map(),
        commentAuthorNameCache: new Map(),
        commentParentIdCache: new Map(),
    };
    return {
        char: { id: charId, name: '测试角色' } as any,
        userProfile: { name: '我' } as any,
        emojis,
        contextMsgs: [],
        fullMessages: [],
        initialData: {},
        historyMsgCount: 0,
        xhsCaches,
        api: {
            baseUrl: 'http://localhost:0',
            headers: {},
            effectiveApi: { baseUrl: 'http://localhost:0', apiKey: '', model: 'test' },
        },
        hooks: { setMessages: vi.fn(), addToast: vi.fn() },
    } as any;
};

const assistantMsgs = async (charId: string) =>
    (await DB.getRecentMessagesByCharId(charId, 50)).filter(m => m.role === 'assistant');

describe('端到端：识别到唯一匹配必须真正发出图片', () => {
    it.each([
        ['标准半角标签', '不理你了\n[[SEND_EMOJI: 敲头]]'],
        ['标准全角标签', '不理你了\n[[SEND_EMOJI：敲头]]'],
        ['带情绪标签的发送指令', '[happy]发送表情包：敲头'],
        ['叙述式发送表达', '被你说中了\n给你丢个敲头表情'],
        ['文件名形态', '敲头.jpg'],
        ['括号动作包裹', '（给你发个敲头）'],
    ])('%s → 落库 type=emoji 且指令文字不重复出现', async (_label, content) => {
        const charId = `c-emoji-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        await applyAssistantPostProcessing(content, makeCtx(charId, inventory));
        const msgs = await assistantMsgs(charId);
        const emojiMsgs = msgs.filter(m => m.type === 'emoji');
        expect(emojiMsgs).toHaveLength(1);
        expect(emojiMsgs[0].content).toBe('https://cdn.example/knock.gif');
        // 发送成功后原始指令文字不得作为普通气泡重复出现
        const textJoined = msgs.filter(m => m.type === 'text').map(m => m.content).join('\n');
        expect(textJoined).not.toContain('SEND_EMOJI');
        expect(textJoined).not.toContain('发送表情包');
        expect(textJoined).not.toContain('敲头.jpg');
    }, 20000);

    it('无法匹配时保留普通聊天内容且不误发其他图片', async () => {
        const charId = `c-emoji-miss-${Date.now()}`;
        await applyAssistantPostProcessing('哈哈你真好玩\n给你丢个不存在的表情', makeCtx(charId, inventory));
        const msgs = await assistantMsgs(charId);
        expect(msgs.filter(m => m.type === 'emoji')).toHaveLength(0);
        expect(msgs.filter(m => m.type === 'text').map(m => m.content).join('\n')).toContain('哈哈你真好玩');
    }, 20000);

    it('双语翻译路径中混进 <原文> 的全角冒号表情标签也会发出图片', async () => {
        const charId = `c-emoji-bi-${Date.now()}`;
        const content = '<翻译><原文>哼，不理你了\n[[SEND_EMOJI：敲头]]</原文><译文>Hmph.</译文></翻译>';
        await applyAssistantPostProcessing(content, makeCtx(charId, inventory));
        const msgs = await assistantMsgs(charId);
        expect(msgs.filter(m => m.type === 'emoji')).toHaveLength(1);
        expect(msgs.filter(m => m.type === 'emoji')[0].content).toBe('https://cdn.example/knock.gif');
        const textJoined = msgs.filter(m => m.type === 'text').map(m => m.content).join('\n');
        expect(textJoined).toContain('哼，不理你了');
        expect(textJoined).not.toContain('SEND_EMOJI');
    }, 20000);

    it('落库的 emoji 消息经历史回读（重新查询）仍然存在且内容一致', async () => {
        const charId = `c-emoji-reread-${Date.now()}`;
        await applyAssistantPostProcessing('哼\n[[SEND_EMOJI: 敲头]]', makeCtx(charId, inventory));
        const reread = await DB.getRecentMessagesByCharId(charId, 200);
        const emojiMsgs = reread.filter(m => m.charId === charId && m.type === 'emoji');
        expect(emojiMsgs).toHaveLength(1);
        expect(emojiMsgs[0].role).toBe('assistant');
        expect(emojiMsgs[0].content).toBe('https://cdn.example/knock.gif');
    }, 20000);
});


