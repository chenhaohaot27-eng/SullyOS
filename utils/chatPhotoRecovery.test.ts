// 拍照消息后台恢复结算直测（对应需求 E4：锁屏/刷新恢复、任务幂等、失败重试入口）。
// 复用 chatPhotoGeneration.test.ts 的 mock 手法：生图服务整体 mock，走真实 fake-indexeddb。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DB } from './db';
import type { CharacterProfile, Message } from '../types';
import { IMAGE_GENERATION_CONFIG_STORAGE_KEY } from './imageGenerationConfig';
import {
    settleStalePendingChatPhotos,
    CHAT_PHOTO_UNCONFIRMED_REASON,
    CHAT_PHOTO_PENDING_STALE_MS,
    retryChatPhotoMessage,
    runGroupChatPhotoMessage,
} from './chatPhotoGeneration';

vi.mock('./imageGenerationService', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./imageGenerationService')>();
    return { ...actual, generateImage: vi.fn(), generatedImageToBlob: vi.fn() };
});

let CHAR_ID = `recover-char-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
let GROUP_ID = `recover-group-${Date.now()}`;
const CHAR = { id: CHAR_ID, name: '恢复测试角色', avatar: 'data:image/png;base64,aGVsbG8=' } as unknown as CharacterProfile;

const pendingPhotoMessage = (createdAt: number, groupId?: string): Parameters<typeof DB.saveMessage>[0] => ({
    charId: CHAR_ID,
    ...(groupId ? { groupId } : {}),
    role: 'assistant',
    type: 'image',
    content: '',
    metadata: {
        chatPhoto: {
            status: 'pending',
            caption: '随图一句话',
            includeCharacter: false,
            style: '',
            prompt: 'a quiet street at dusk',
            createdAt,
        },
    },
});

beforeEach(() => {
    CHAR_ID = `recover-char-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    GROUP_ID = `recover-group-${Date.now()}`;
    (CHAR as { id: string }).id = CHAR_ID;
    localStorage.clear();
    localStorage.setItem(IMAGE_GENERATION_CONFIG_STORAGE_KEY, JSON.stringify({
        enabled: true, provider: 'gemini-native', baseUrl: 'https://img.test', apiKey: 'sk-test', model: 'img-model',
    }));
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('settleStalePendingChatPhotos（A5：无限转圈/pending 卡死修复）', () => {
    it('超时 pending → failed + 结果待确认 + 可重试；新鲜 pending 与已完结消息不动（幂等）', async () => {
        const now = Date.now();
        const staleId = await DB.saveMessage(pendingPhotoMessage(now - CHAT_PHOTO_PENDING_STALE_MS - 1));
        const freshId = await DB.saveMessage(pendingPhotoMessage(now - 1000));
        const settled = await settleStalePendingChatPhotos(await DB.getMessagesByCharId(CHAR_ID, true), now);
        expect(settled).toBe(1);
        const messages = await DB.getMessagesByCharId(CHAR_ID, true);
        const stale = messages.find(m => m.id === staleId);
        const fresh = messages.find(m => m.id === freshId);
        expect((stale?.metadata?.chatPhoto as { status: string }).status).toBe('failed');
        expect((stale?.metadata?.chatPhoto as { reason: string }).reason).toBe(CHAT_PHOTO_UNCONFIRMED_REASON);
        expect((fresh?.metadata?.chatPhoto as { status: string }).status).toBe('pending');
        // 二次结算幂等
        expect(await settleStalePendingChatPhotos(await DB.getMessagesByCharId(CHAR_ID, true), now)).toBe(0);
    });

    it('普通文本/图片消息不受影响', async () => {
        const now = Date.now();
        await DB.saveMessage({ charId: CHAR_ID, role: 'assistant', type: 'text', content: '普通消息' } as never);
        const userImgId = await DB.saveMessage({ charId: 'user', role: 'user', type: 'image', content: 'data:image/png;base64,xx' } as never);
        expect(await settleStalePendingChatPhotos(await DB.getMessagesByCharId(CHAR_ID, true), now)).toBe(0);
        expect(userImgId).toBeGreaterThan(0);
    });
});

describe('群拍照消息（C 类）：groupId 双关联 + 重试按群线程查找', () => {
    it('retryChatPhotoMessage 带 groupId 时在群线程里找到消息并重置 pending', async () => {
        const now = Date.now();
        const messageId = await DB.saveMessage(pendingPhotoMessage(now - CHAT_PHOTO_PENDING_STALE_MS - 1, GROUP_ID));
        await settleStalePendingChatPhotos(await DB.getGroupMessages(GROUP_ID), now);
        // 重试会调 generateImage——mock 成失败即可（这里只验证查找与状态翻转路径）
        const { generateImage } = await import('./imageGenerationService');
        vi.mocked(generateImage).mockRejectedValue(new Error('mock fail'));
        const outcome = await retryChatPhotoMessage(CHAR, messageId, undefined, GROUP_ID);
        expect(outcome?.status).toBe('failed');
        const messages: Message[] = await DB.getGroupMessages(GROUP_ID);
        const meta = messages.find(m => m.id === messageId)?.metadata?.chatPhoto as { status: string; createdAt: number };
        // 重置过 pending 且时间戳更新（失败后再次落 failed）
        expect(['failed']).toContain(meta.status);
        expect(meta.createdAt).toBeGreaterThan(now);
    });

    it('runGroupChatPhotoMessage 复用统一生成管线（API 未启用时落明确失败，不伪造图片）', async () => {
        localStorage.setItem(IMAGE_GENERATION_CONFIG_STORAGE_KEY, JSON.stringify({ enabled: false }));
        const messageId = await DB.saveMessage(pendingPhotoMessage(Date.now(), GROUP_ID));
        const outcome = await runGroupChatPhotoMessage({
            char: CHAR, groupId: GROUP_ID, intent: { prompt: 'x', caption: '', includeCharacter: false, style: '' }, messageId,
        });
        expect(outcome.status).toBe('failed');
        expect(outcome.reason).toContain('生图 API 未启用');
        const messages = await DB.getGroupMessages(GROUP_ID);
        expect(messages.find(m => m.id === messageId)?.content).toBe(''); // 没有占位文本/假图
    });
});
