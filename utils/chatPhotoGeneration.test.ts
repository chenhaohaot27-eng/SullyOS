import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DB } from './db';
import type { CharacterProfile, Message } from '../types';
import { isBlobRef } from './blobRef';
import { IMAGE_GENERATION_CONFIG_STORAGE_KEY } from './imageGenerationConfig';
import { ImageGenerationError, generateImage, generatedImageToBlob } from './imageGenerationService';
import { executeChatPhotoIntent, retryChatPhotoMessage } from './chatPhotoGeneration';
import { resetChatPhotoTurnClaimsForTests } from './chatPhotoIntent';
import { applyAssistantPostProcessing, type PostProcessCtx, type XhsCaches } from './applyAssistantPostProcessing';

vi.mock('./imageGenerationService', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./imageGenerationService')>();
    return { ...actual, generateImage: vi.fn(), generatedImageToBlob: vi.fn() };
});

const mockedGenerate = vi.mocked(generateImage);
const mockedToBlob = vi.mocked(generatedImageToBlob);

const makeCharId = () => `photo-char-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
let CHAR_ID = makeCharId();
let CHAR = { id: CHAR_ID, name: '测试角色', avatar: 'data:image/png;base64,aGVsbG8=' } as unknown as CharacterProfile;

const INTENT = {
    prompt: 'a cozy desk with a warm lamp at night',
    caption: '给你看看我的桌子～',
    includeCharacter: false,
    style: 'soft light',
};

const setConfig = (patch: Record<string, unknown> = {}) => {
    localStorage.setItem(IMAGE_GENERATION_CONFIG_STORAGE_KEY, JSON.stringify({
        enabled: true,
        provider: 'gemini-native',
        baseUrl: 'https://img.test',
        apiKey: 'sk-test-secret-123',
        model: 'img-model',
        ...patch,
    }));
};

const listMessages = async (): Promise<Message[]> => DB.getMessagesByCharId(CHAR_ID, true);

beforeEach(() => {
    // 每个用例独立角色：fake-indexeddb 在整个文件里共享，同 charId 会串消息。
    CHAR_ID = makeCharId();
    CHAR = { id: CHAR_ID, name: '测试角色', avatar: 'data:image/png;base64,aGVsbG8=' } as unknown as CharacterProfile;
    localStorage.clear();
    setConfig();
    resetChatPhotoTurnClaimsForTests();
    mockedGenerate.mockReset();
    mockedToBlob.mockReset();
    mockedToBlob.mockResolvedValue(new Blob(['fake-image'], { type: 'image/png' }));
});

afterEach(() => {
    vi.restoreAllMocks();
});

const okResult = () => ({
    provider: 'gemini-native' as const,
    model: 'm',
    images: [{ source: 'data-uri' as const, url: 'data:image/png;base64,QQ', mimeType: 'image/png' }],
    createdAt: 1,
});

describe('executeChatPhotoIntent', () => {
    it('成功生成真实图片消息：blobref 落库 + caption + ready 状态', async () => {
        mockedGenerate.mockResolvedValue(okResult());

        await executeChatPhotoIntent({
            char: CHAR,
            intent: INTENT,
            persistMessage: msg => DB.saveMessage(msg),
        });

        const msgs = await listMessages();
        expect(msgs).toHaveLength(1);
        const photo = msgs[0];
        expect(photo.role).toBe('assistant');
        expect(photo.type).toBe('image');
        expect(isBlobRef(photo.content)).toBe(true);
        expect(photo.metadata?.chatPhoto?.status).toBe('ready');
        expect(photo.metadata?.chatPhoto?.caption).toBe('给你看看我的桌子～');
        // 凭据纪律：metadata 不落 Key
        expect(JSON.stringify(photo.metadata)).not.toContain('sk-test-secret-123');
    });

    it('includeCharacter=false 不传参考图；true 时附加角色参考图', async () => {
        mockedGenerate.mockResolvedValue(okResult());

        await executeChatPhotoIntent({ char: CHAR, intent: INTENT, persistMessage: msg => DB.saveMessage(msg) });
        expect(mockedGenerate.mock.calls[0][0].referenceImages).toEqual([]);

        resetChatPhotoTurnClaimsForTests();
        await executeChatPhotoIntent({
            char: CHAR,
            intent: { ...INTENT, prompt: 'selfie in the mirror', includeCharacter: true },
            persistMessage: msg => DB.saveMessage(msg),
        });
        expect(mockedGenerate.mock.calls[1][0].referenceImages).toEqual(['data:image/png;base64,aGVsbG8=']);
    });

    it('生图服务一轮只调用一次：同一意图重复执行被 claim 短路', async () => {
        mockedGenerate.mockResolvedValue(okResult());

        const args = { char: CHAR, intent: INTENT, persistMessage: (msg: any) => DB.saveMessage(msg) } as const;
        await executeChatPhotoIntent({ ...args });
        // StrictMode / 重渲染 / 流式重放会造成同轮重复调用
        await executeChatPhotoIntent({ ...args });
        await executeChatPhotoIntent({ ...args });

        expect(mockedGenerate).toHaveBeenCalledTimes(1);
        expect(await listMessages()).toHaveLength(1);
    });

    it('失败落简短原因（Key 不泄露），可手动重试', async () => {
        mockedGenerate.mockRejectedValueOnce(new Error('boom with sk-test-secret-123 inside'));
        const toast = vi.fn();
        await executeChatPhotoIntent({ char: CHAR, intent: INTENT, persistMessage: msg => DB.saveMessage(msg), onToast: toast });

        let msgs = await listMessages();
        expect(msgs[0].metadata?.chatPhoto?.status).toBe('failed');
        expect(msgs[0].content).toBe('');
        expect(msgs[0].metadata?.chatPhoto?.reason).not.toContain('sk-test-secret-123');
        expect(msgs[0].metadata?.chatPhoto?.reason).toContain('[REDACTED]');
        expect(toast).toHaveBeenCalledWith(expect.stringContaining('照片生成失败'), 'error');

        // 手动重试成功 → 同一条消息变成 ready + blobref
        mockedGenerate.mockResolvedValueOnce(okResult());
        const outcome = await retryChatPhotoMessage(CHAR, msgs[0].id);
        expect(outcome?.status).toBe('ready');
        msgs = await listMessages();
        expect(msgs).toHaveLength(1);
        expect(msgs[0].metadata?.chatPhoto?.status).toBe('ready');
        expect(isBlobRef(msgs[0].content)).toBe(true);
    });

    it('生图 API 未启用：不调用服务，落明确提示', async () => {
        setConfig({ enabled: false });
        const toast = vi.fn();
        await executeChatPhotoIntent({ char: CHAR, intent: INTENT, persistMessage: msg => DB.saveMessage(msg), onToast: toast });

        expect(mockedGenerate).not.toHaveBeenCalled();
        const msgs = await listMessages();
        expect(msgs[0].metadata?.chatPhoto?.status).toBe('failed');
        expect(msgs[0].metadata?.chatPhoto?.reason).toContain('生图 API 未启用');
        expect(toast).toHaveBeenCalled();
    });

    it('不支持参考图的接口降级去掉参考图再生成（仍只成功出图一次）', async () => {
        mockedGenerate
            .mockRejectedValueOnce(new ImageGenerationError('REFERENCE_NOT_SUPPORTED', '当前接口模式不支持参考图'))
            .mockResolvedValueOnce({
                provider: 'openai-images' as const,
                model: 'm',
                images: [{ source: 'url' as const, url: 'https://cdn.test/img.png', mimeType: 'image/png' }],
                createdAt: 1,
            });

        await executeChatPhotoIntent({
            char: CHAR,
            intent: { ...INTENT, includeCharacter: true },
            persistMessage: msg => DB.saveMessage(msg),
        });

        expect(mockedGenerate).toHaveBeenCalledTimes(2);
        expect(mockedGenerate.mock.calls[1][0].referenceImages).toEqual([]);
        const msgs = await listMessages();
        expect(msgs[0].metadata?.chatPhoto?.status).toBe('ready');
    });
});

describe('applyAssistantPostProcessing 集成（普通聊天链路）', () => {
    const makeCtx = (): PostProcessCtx => {
        const xhsCaches: XhsCaches = {
            xsecTokenCache: new Map(),
            noteTitleCache: new Map(),
            commentUserIdCache: new Map(),
            commentAuthorNameCache: new Map(),
            commentParentIdCache: new Map(),
        };
        return {
            char: CHAR,
            userProfile: { name: '用户' } as any,
            emojis: [],
            contextMsgs: [],
            fullMessages: [{ role: 'user', content: '拍给我看看' }],
            initialData: {},
            historyMsgCount: 1,
            xhsCaches,
            api: {
                baseUrl: 'https://llm.test/v1',
                headers: {},
                effectiveApi: { baseUrl: 'https://llm.test/v1', apiKey: '', model: 'test' },
            },
            hooks: { setMessages: vi.fn(), addToast: vi.fn() },
            instantRender: true,
        };
    };

    it('拦截意图 → 正文照常渲染 + 真实图片消息；意图控制内容不显示', async () => {
        mockedGenerate.mockResolvedValue(okResult());

        await applyAssistantPostProcessing(
            '稍等，我拍给你\n[[SEND_PHOTO: {"prompt":"night view from my window","caption":"你看","includeCharacter":false}]]',
            makeCtx(),
        );

        const msgs = await listMessages();
        const texts = msgs.filter(m => m.type === 'text').map(m => m.content);
        const photos = msgs.filter(m => m.type === 'image');
        expect(texts).toEqual(['稍等，我拍给你']);
        expect(photos).toHaveLength(1);
        expect(isBlobRef(photos[0].content)).toBe(true);
        expect(photos[0].metadata?.chatPhoto?.status).toBe('ready');
        // 意图标签 / JSON 形态不落任何消息正文；metadata.chatPhoto.prompt 是有意冻存
        // 供手动重试用的（不含任何凭据），与“意图控制内容不显示”不冲突。
        expect(JSON.stringify(msgs)).not.toContain('SEND_PHOTO');
        expect(JSON.stringify(msgs.map(m => m.content))).not.toContain('night view from my window');
        expect(mockedGenerate).toHaveBeenCalledTimes(1);
    });

    it('普通聊天不触发：没有标签时不会产生 image 消息、不调生图服务', async () => {
        await applyAssistantPostProcessing('今天也要加油呀', makeCtx());
        const msgs = await listMessages();
        expect(msgs.filter(m => m.type === 'image')).toHaveLength(0);
        expect(mockedGenerate).not.toHaveBeenCalled();
    });

    it('模型未选择发图（纯文字轮）：记录阶段日志，与解析失败/生图失败区分', async () => {
        const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            // 生图配置已启用（beforeEach setConfig）但模型本轮没输出 SEND_PHOTO → 属正常
            await applyAssistantPostProcessing('今天上班好累，改天聊', makeCtx());
            const loggedInfo = infoSpy.mock.calls.map(c => c.join(' ')).join('\n');
            expect(loggedInfo).toContain('模型未选择发图');
            expect(loggedInfo).not.toContain('标签检测');
            expect(warnSpy).not.toHaveBeenCalled();
            expect(mockedGenerate).not.toHaveBeenCalled();
        } finally {
            infoSpy.mockRestore();
            warnSpy.mockRestore();
        }
    });

    it('非法标签（无法安全解析）：标签剥掉、不产生假图片消息、不调生图服务，正文保留', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
        try {
            await applyAssistantPostProcessing(
                '我发了一张照片给你看\n[[SEND_PHOTO: not json at all]]',
                makeCtx(),
            );
            const msgs = await listMessages();
            // 不产生任何 image 消息（禁止文字/[图片] 占位伪装生图成功）
            expect(msgs.filter(m => m.type === 'image')).toHaveLength(0);
            expect(mockedGenerate).not.toHaveBeenCalled();
            // 正文照常落库，标签与 JSON 不进气泡
            const texts = msgs.filter(m => m.type === 'text').map(m => m.content);
            expect(texts).toContain('我发了一张照片给你看');
            expect(JSON.stringify(msgs)).not.toContain('SEND_PHOTO');
            // 可观测性：解析失败有 warn 留痕
            expect(warnSpy).toHaveBeenCalled();
        } finally {
            warnSpy.mockRestore();
            infoSpy.mockRestore();
        }
    });

    it('全角引号标签（中文模型高频格式误差）端到端仍能拍出真实图片消息', async () => {
        const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
        try {
            mockedGenerate.mockResolvedValue(okResult());
            await applyAssistantPostProcessing(
                '拍好了～\n[[SEND_PHOTO: {"prompt":"my desk at night", "caption":"给你",}]]',
                makeCtx(),
            );
            expect(mockedGenerate).toHaveBeenCalledTimes(1);
            const msgs = await listMessages();
            const photos = msgs.filter(m => m.type === 'image');
            expect(photos).toHaveLength(1);
            expect(isBlobRef(photos[0].content)).toBe(true);
            expect(photos[0].metadata?.chatPhoto?.status).toBe('ready');
            // 标签检测日志有留痕（安全脱敏：不含 prompt 原文）
            const logged = infoSpy.mock.calls.map(c => c.join(' ')).join('\n');
            expect(logged).toContain('SEND_PHOTO 标签检测');
            expect(logged).not.toContain('my desk at night');
        } finally {
            infoSpy.mockRestore();
        }
    });

    it('角色自主发图（玩家本轮未要求照片）：SEND_PHOTO 标签同样执行、出真实图片消息', async () => {
        // contextMsgs 为空 = 本轮没有任何玩家请求；解除提示词限制后，模型自主输出的
        // SEND_PHOTO 与玩家请求走同一条 Step 7 链路（无 24h 冷却/高成本门控拦截）。
        mockedGenerate.mockResolvedValue(okResult());
        await applyAssistantPostProcessing(
            '刚到家，给你看看我的猫\n[[SEND_PHOTO: {"prompt":"a fluffy cat sleeping on a sofa, warm lamp light","caption":"它今天赖我床上一整天","includeCharacter":false}]]',
            makeCtx(),
        );
        expect(mockedGenerate).toHaveBeenCalledTimes(1);
        const msgs = await listMessages();
        const photos = msgs.filter(m => m.type === 'image');
        expect(photos).toHaveLength(1);
        expect(isBlobRef(photos[0].content)).toBe(true);
        expect(photos[0].metadata?.chatPhoto?.status).toBe('ready');
        expect(photos[0].metadata?.chatPhoto?.caption).toBe('它今天赖我床上一整天');
    });

    it('生图失败不产生假照片：失败消息 status=failed + 脱敏原因，正文无 [图片] 占位', async () => {
        mockedGenerate.mockRejectedValue(new Error('boom sk-test-secret-123'));
        await executeChatPhotoIntent({
            char: CHAR,
            intent: INTENT,
            persistMessage: msg => DB.saveMessage(msg),
        });
        const msgs = await listMessages();
        const photos = msgs.filter(m => m.type === 'image');
        expect(photos).toHaveLength(1);
        expect(photos[0].metadata?.chatPhoto?.status).toBe('failed');
        expect(photos[0].metadata?.chatPhoto?.reason).not.toContain('sk-test-secret');
        expect(photos[0].content).not.toContain('[图片]');
        expect(isBlobRef(photos[0].content)).toBe(false); // 失败时不落任何 blobref，content 保持空串
    });

    it('生图成功后重新读取：消息可从 DB 再次载入且 ready 状态保持', async () => {
        mockedGenerate.mockResolvedValue(okResult());
        await executeChatPhotoIntent({
            char: CHAR,
            intent: INTENT,
            persistMessage: msg => DB.saveMessage(msg),
        });
        // 重新读取（模拟刷新/重开页面后的载入路径）
        const reread = await DB.getMessagesByCharId(CHAR_ID, true);
        const photo = reread.find(m => m.type === 'image');
        expect(photo).toBeDefined();
        expect(isBlobRef(photo!.content)).toBe(true);
        expect(photo!.metadata?.chatPhoto?.status).toBe('ready');
        expect(photo!.metadata?.chatPhoto?.caption).toBe(INTENT.caption);
    });
});
