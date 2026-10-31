import { describe, it, expect, vi, beforeEach } from 'vitest';
import { applyAssistantPostProcessing, PostProcessCtx, XhsCaches } from './applyAssistantPostProcessing';
import { executeChatPhotoIntent } from './chatPhotoGeneration';
import { ChatParser } from './chatParser';
import { DB } from './db';
import { IMAGE_GENERATION_CONFIG_STORAGE_KEY } from './imageGenerationConfig';

// 本文件覆盖两条链路的端到端行为（DB 走 fake-indexeddb，生图执行 mock，不触发真实付费 API）：
//  A. 表情包「只有文字不发图」修复：全角冒号 [[SEND_EMOJI：x]] 与自然语言表情指令
//     必须真正落成 type='emoji' 的图片消息，而不是残留文字气泡。
//  B. 主动发图「口头承诺落实」：正文里明确说拍给你看时兜底走真实 SEND_PHOTO 链路。

vi.mock('./chatPhotoGeneration', () => ({
    executeChatPhotoIntent: vi.fn().mockResolvedValue(undefined),
}));

const makeCtx = (charId: string, contextMsgs: any[], emojis: any[] = []): PostProcessCtx => {
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
        contextMsgs,
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

const enablePhoto = () => {
    localStorage.setItem(IMAGE_GENERATION_CONFIG_STORAGE_KEY, JSON.stringify({ enabled: true }));
};
const disablePhoto = () => {
    localStorage.removeItem(IMAGE_GENERATION_CONFIG_STORAGE_KEY);
};

const assistantMsgs = async (charId: string) =>
    (await DB.getRecentMessagesByCharId(charId, 50)).filter(m => m.role === 'assistant');

beforeEach(() => {
    vi.mocked(executeChatPhotoIntent).mockClear();
    disablePhoto();
});

describe('表情包真正发送链路（修复：只有文字不发图）', () => {
    it('splitResponse 容全角冒号：[[SEND_EMOJI：名字]] 拆成 emoji part 而不是漏成文字', () => {
        const parts = ChatParser.splitResponse('哼，不理你了\n[[SEND_EMOJI：委屈]]\n睡觉去了');
        expect(parts).toEqual([
            { type: 'text', content: '哼，不理你了' },
            { type: 'emoji', content: '委屈' },
            { type: 'text', content: '睡觉去了' },
        ]);
        // 半角冒号既有行为不回归
        expect(ChatParser.splitResponse('[[SEND_EMOJI: 开心]]')).toEqual([
            { type: 'emoji', content: '开心' },
        ]);
    });

    it('全角冒号表情标签端到端落成 emoji 图片消息，原始标签不再漏进气泡', async () => {
        const charId = `c-emoji-fq-${Date.now()}`;
        const emojis = [{ name: '委屈', url: 'https://cdn.example/wuqu.gif', categoryId: 'sys' }];
        await applyAssistantPostProcessing('哼，不理你了\n[[SEND_EMOJI：委屈]]', makeCtx(charId, [], emojis));
        const msgs = await assistantMsgs(charId);
        const emojiMsgs = msgs.filter(m => m.type === 'emoji');
        expect(emojiMsgs).toHaveLength(1);
        expect(emojiMsgs[0].content).toBe('https://cdn.example/wuqu.gif');
        // 关键回归：任何文字气泡里都不应再出现 SEND_EMOJI 字样
        const textMsgs = msgs.filter(m => m.type === 'text');
        expect(textMsgs.map(m => m.content).join('\n')).not.toContain('SEND_EMOJI');
    }, 20000);

    it('自然语言表情指令（给你丢个猫猫表情）端到端落成 emoji 图片消息', async () => {
        const charId = `c-emoji-nl-${Date.now()}`;
        const emojis = [{ name: '猫猫', url: 'https://cdn.example/cat.gif', categoryId: 'sys' }];
        await applyAssistantPostProcessing('被你说中啦\n给你丢个猫猫表情', makeCtx(charId, [], emojis));
        const msgs = await assistantMsgs(charId);
        const emojiMsgs = msgs.filter(m => m.type === 'emoji');
        expect(emojiMsgs).toHaveLength(1);
        expect(emojiMsgs[0].content).toBe('https://cdn.example/cat.gif');
    }, 20000);

    it('普通含"表情"字样的叙述不会被误落成贴图', async () => {
        const charId = `c-emoji-neg-${Date.now()}`;
        const emojis = [{ name: '猫猫', url: 'https://cdn.example/cat.gif', categoryId: 'sys' }];
        await applyAssistantPostProcessing('这个表情包太好笑了，我存了很久', makeCtx(charId, [], emojis));
        const msgs = await assistantMsgs(charId);
        expect(msgs.filter(m => m.type === 'emoji')).toHaveLength(0);
        expect(msgs.filter(m => m.type === 'text').length).toBeGreaterThan(0);
    }, 20000);
});

describe('口头视觉分享承诺落实为真实 SEND_PHOTO（主动发图自然化）', () => {
    it('正文明确说"拍给你看"且无标签 → 兜底进入真实生图链路', async () => {
        enablePhoto();
        const charId = `c-photo-verb-${Date.now()}`;
        await applyAssistantPostProcessing(
            '到我这边啦，等我一下\n我拍给你看，刚做好的午饭',
            makeCtx(charId, [], []),
        );
        expect(executeChatPhotoIntent).toHaveBeenCalledTimes(1);
        const arg = vi.mocked(executeChatPhotoIntent).mock.calls[0][0];
        expect(arg.char.id).toBe(charId);
        expect(arg.intent.prompt).toContain('拍给你看');
        expect(arg.intent.caption).toBe('');
    }, 20000);

    it('明确的 SEND_PHOTO 标签优先级最高：标签意图直通，口头兜底不叠加', async () => {
        enablePhoto();
        const charId = `c-photo-tag-${Date.now()}`;
        await applyAssistantPostProcessing(
            '好呀，等我一下\n[[SEND_PHOTO: {"prompt":"homemade lunch on a wooden desk","caption":"锵锵～","includeCharacter":false}]]\n我再拍一张给你看哦',
            makeCtx(charId, [], []),
        );
        expect(executeChatPhotoIntent).toHaveBeenCalledTimes(1);
        const intent = vi.mocked(executeChatPhotoIntent).mock.calls[0][0].intent;
        expect(intent.prompt).toBe('homemade lunch on a wooden desk');
        expect(intent.caption).toBe('锵锵～');
    }, 20000);

    it('刚发过图（上下文里有 assistant image）不自动补拍——避免连续/重复发图', async () => {
        enablePhoto();
        const charId = `c-photo-recent-${Date.now()}`;
        const contextMsgs = [
            { id: 1, charId, role: 'user', type: 'text', content: '看看你那边', timestamp: Date.now() - 2000 },
            { id: 2, charId, role: 'assistant', type: 'image', content: 'blobref:x', timestamp: Date.now() - 1000 },
        ];
        await applyAssistantPostProcessing('嘿嘿，我再拍给你看一张', makeCtx(charId, contextMsgs, []));
        expect(executeChatPhotoIntent).not.toHaveBeenCalled();
    }, 20000);

    it('普通聊天与远期承诺不触发生图；生图关闭时口头承诺也不触发', async () => {
        const charId = `c-photo-none-${Date.now()}`;
        // 生图关闭：无标签、无动作
        await applyAssistantPostProcessing('今天好累啊，改天拍给你看我的新桌子', makeCtx(charId, [], []));
        expect(executeChatPhotoIntent).not.toHaveBeenCalled();
        // 生图开启但只是普通聊天/远期承诺
        enablePhoto();
        await applyAssistantPostProcessing('嗯嗯我也觉得\n下次拍给你看', makeCtx(charId, [], []));
        expect(executeChatPhotoIntent).not.toHaveBeenCalled();
    }, 20000);
});

