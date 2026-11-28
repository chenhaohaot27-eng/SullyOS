// S2 客户端编排测试：云端提交挂账、按 taskId 补收幂等（一条消息/一份相册）、
// 失败/未知收敛、默认关闭不影响本地生图路径。ActiveMsgClient 网络层整体 mock。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DB } from './db';
import { ActiveMsgStore } from './activeMsgStore';
import type { CharacterProfile, Message } from '../types';
import { IMAGE_GENERATION_CONFIG_STORAGE_KEY } from './imageGenerationConfig';
import { buildCloudImageGenRequestTemplate } from './imageGenerationService';

vi.mock('./activeMsgClient', () => ({
  ActiveMsgClient: {
    submitImageGenTask: vi.fn(),
    queryImageGenTask: vi.fn(),
    downloadImageGenResult: vi.fn(),
    cancelImageGenTask: vi.fn(),
    fetchWorkerConfigCheck: vi.fn(),
    probeImageGenRoute: vi.fn(),
  },
}));

import { ActiveMsgClient } from './activeMsgClient';
import { retryChatPhotoMessage, executeChatPhotoIntent, settleStalePendingChatPhotos } from './chatPhotoGeneration';
import {
    loadCloudImageGenConfig,
    saveCloudImageGenConfig,
    isCloudImageGenActive,
    probeCloudImageGenCapability,
    submitCloudPhotoTask,
    settleCloudPhotoMessage,
    recoverCloudPhotoMessages,
    CLOUD_PHOTO_SETTLED_EVENT,
    stopCloudPhotoPoller,
    CLOUD_IMAGE_UNKNOWN_SETTLE_MS,
} from './cloudImageGen';

const mockedSubmit = vi.mocked(ActiveMsgClient.submitImageGenTask);
const mockedQuery = vi.mocked(ActiveMsgClient.queryImageGenTask);
const mockedDownload = vi.mocked(ActiveMsgClient.downloadImageGenResult);

let CHAR_ID = `cloud-char-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const CHAR = { id: CHAR_ID, name: '云端测试角色' } as unknown as CharacterProfile;
const INTENT = { prompt: 'a quiet street', caption: '看路', includeCharacter: false, style: '' };

const pendingMessage = async (taskId: string | undefined, createdAt = Date.now()): Promise<number> => {
  const messageId = await DB.saveMessage({
    charId: CHAR_ID, role: 'assistant', type: 'image', content: '',
    metadata: { cloudImageTaskId: taskId, chatPhoto: { status: 'pending', caption: '看路', includeCharacter: false, style: '', prompt: 'a quiet street', createdAt } },
  } as never);
  return messageId;
};

const loadMessage = async (messageId: number): Promise<Message | undefined> => {
  const messages = await DB.getMessagesByCharId(CHAR_ID, true);
  return messages.find(m => m.id === messageId);
};

beforeEach(() => {
  CHAR_ID = `cloud-char-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  (CHAR as { id: string }).id = CHAR_ID;
  localStorage.clear();
  localStorage.setItem(IMAGE_GENERATION_CONFIG_STORAGE_KEY, JSON.stringify({
    enabled: true, provider: 'gemini-native', baseUrl: 'https://img.test', apiKey: 'sk-test', model: 'img-model',
  }));
  mockedSubmit.mockReset();
  mockedQuery.mockReset();
  mockedDownload.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('开关与默认行为', () => {
  it('keeps a retry on the cloud route, deduplicates double taps and recovers its result', async () => {
    const id = await pendingMessage(undefined);
    await DB.updateMessageMetadata(id, prev => ({ ...prev, chatPhoto: { ...prev.chatPhoto, status: 'failed', reason: '生图请求超过 90 秒' } }));
    saveCloudImageGenConfig({ enabled: true });
    vi.spyOn(ActiveMsgStore, 'getGlobalConfig').mockResolvedValue({
      workerUrl: 'https://worker.test', userId: 'owner', masterKey: 'fixture', serverToken: 'fixture',
    } as Awaited<ReturnType<typeof ActiveMsgStore.getGlobalConfig>>);
    mockedSubmit.mockResolvedValue({ created: true, status: 'queued' });
    await Promise.all([retryChatPhotoMessage(CHAR, id), retryChatPhotoMessage(CHAR, id)]);
    expect(mockedSubmit).toHaveBeenCalledTimes(1);
    const message = (await loadMessage(id))!;
    expect(message.metadata?.cloudImageTaskId).toBe(mockedSubmit.mock.calls[0][0]);
    mockedQuery.mockResolvedValue({ status: 'running' });
    expect(await settleStalePendingChatPhotos([message], Date.now() + 16 * 60_000)).toBe(0);
    expect(await retryChatPhotoMessage(CHAR, id)).toEqual({ status: 'pending' });
    expect(mockedSubmit).toHaveBeenCalledTimes(1);
    mockedQuery.mockResolvedValue({ status: 'completed' });
    mockedDownload.mockResolvedValue(new Blob(['image'], { type: 'image/png' }));
    expect(await recoverCloudPhotoMessages([message])).toBe(1);
    expect((await loadMessage(id))?.metadata?.chatPhoto.status).toBe('ready');
  });
  it('fails visibly when cloud mode is selected but pairing is unavailable', async () => {
    saveCloudImageGenConfig({ enabled: true });
    vi.spyOn(ActiveMsgStore, 'getGlobalConfig').mockRejectedValue(new Error('fixture'));
    await executeChatPhotoIntent({ char: CHAR, intent: INTENT as never, persistMessage: msg => DB.saveMessage(msg) });
    const [msg] = await DB.getMessagesByCharId(CHAR_ID, true);
    expect(msg.metadata?.chatPhoto.reason).toContain('配对');
    expect(mockedSubmit).not.toHaveBeenCalled();
  });
  it('distinguishes replacement bundles, auth failure and a fresh ready report', async () => {
    vi.spyOn(ActiveMsgStore, 'getGlobalConfig').mockResolvedValue({
      workerUrl: 'https://worker.test', userId: 'owner', serverToken: 'configured', masterKey: 'configured',
    } as Awaited<ReturnType<typeof ActiveMsgStore.getGlobalConfig>>);
    const configCheck = vi.mocked(ActiveMsgClient.fetchWorkerConfigCheck);
    const routeCheck = vi.mocked(ActiveMsgClient.probeImageGenRoute);
    routeCheck.mockClear();
    configCheck.mockResolvedValueOnce(null).mockResolvedValueOnce({ instantChat: true, workerVersion: '2026-11-19' });
    await expect(probeCloudImageGenCapability()).resolves.toMatchObject({ ok: false, reason: 'unreachable' });
    await expect(probeCloudImageGenCapability()).resolves.toMatchObject({ ok: false, reason: 'unsupported', version: '2026-11-19' });
    expect(routeCheck).not.toHaveBeenCalled();
    configCheck.mockResolvedValue({ imageGen: true, serverTokenEnforced: true, imageStorage: 'r2' });
    routeCheck.mockResolvedValueOnce('unauthenticated').mockResolvedValueOnce('ready');
    await expect(probeCloudImageGenCapability()).resolves.toMatchObject({ ok: false, reason: 'unauthenticated' });
    await expect(probeCloudImageGenCapability()).resolves.toMatchObject({ ok: true, storage: 'r2' });
    configCheck.mockResolvedValue({ imageGen: true, imageAuth: 'owner-token', imageStorage: 'r2' });
    routeCheck.mockResolvedValueOnce('ready');
    await expect(probeCloudImageGenCapability()).resolves.toMatchObject({ ok: true, storage: 'r2' });
  });

  it('默认关闭；isCloudImageGenActive 关着时恒 false（本地生图路径不受影响）', async () => {
    expect(loadCloudImageGenConfig().enabled).toBe(false);
    expect(await isCloudImageGenActive()).toBe(false);
    saveCloudImageGenConfig({ enabled: true });
    expect(loadCloudImageGenConfig().enabled).toBe(true);
    // 开了但没有 amsg 配置（getGlobalConfig 拿不到完整四元组）也不会走云端
    expect(await isCloudImageGenActive()).toBe(false);
  });
});

describe('submitCloudPhotoTask：提交与挂账', () => {
  it('云端提交携带两份主图并在同一消息记录序号', async () => {
    await DB.saveUserProfile({ name: '玩家甲', bio: '', avatar: '', visualIdentity: {
      enabled: true, mode: 'simple', references: [{ id: 'me', role: 'front', blobRef: 'data:image/png;base64,cA==', createdAt: 0 }],
    } });
    const messageId = await pendingMessage(undefined);
    mockedSubmit.mockResolvedValue({ created: true, status: 'queued' });
    const submitted = await submitCloudPhotoTask({
      char: { ...CHAR, avatar: 'data:image/png;base64,Yw==' },
      intent: { ...INTENT, includePlayer: true, includeCharacter: true }, messageId,
    });
    expect(submitted).toBeTruthy();
    const template = mockedSubmit.mock.calls[0][1] as { bodyJson: { contents: { parts: { inlineData?: { data: string }; text?: string }[] }[] } };
    const parts = template.bodyJson.contents[0].parts;
    expect(parts.slice(1).map(p => p.inlineData?.data)).toEqual(['Yw==', 'cA==']);
    expect(parts[0].text).toContain('玩家「玩家甲」：仅图 2');
    expect((await loadMessage(messageId))?.metadata?.chatPhoto.references).toHaveLength(2);
    stopCloudPhotoPoller(submitted!.taskId);
  });
  it('成功：taskId 写进消息 metadata；失败：消息翻 failed 且带原因（不留悬空 pending）', async () => {
    mockedSubmit.mockResolvedValue({ status: 'queued', created: true });
    const okId = await pendingMessage(undefined);
    const submitted = await submitCloudPhotoTask({ char: CHAR, intent: INTENT as never, messageId: okId });
    expect(submitted?.taskId).toBeTruthy();
    const okMessage = await loadMessage(okId);
    expect(okMessage?.metadata?.cloudImageTaskId).toBe(submitted?.taskId);
    expect((okMessage?.metadata?.chatPhoto as { status: string }).status).toBe('pending');

    mockedSubmit.mockRejectedValue(new Error('Worker 连接失败'));
    const failId = await pendingMessage(undefined);
    const failed = await submitCloudPhotoTask({ char: CHAR, intent: INTENT as never, messageId: failId });
    expect(failed).toBeNull();
    const failMessage = await loadMessage(failId);
    expect((failMessage?.metadata?.chatPhoto as { status: string }).status).toBe('failed');
    expect((failMessage?.metadata?.chatPhoto as { reason: string }).reason).toContain('Worker 连接失败');
  });
});

describe('补收与幂等（一条消息、一份相册记录）', () => {
  it('resumes a running task after reopening and updates the open bubble on completion', async () => {
    const id = await pendingMessage('task-after-reload', Date.now() - 151_000);
    const events = new EventTarget();
    vi.stubGlobal('window', events);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      mockedQuery.mockResolvedValueOnce({ status: 'running' }).mockResolvedValueOnce({ status: 'completed' });
      mockedDownload.mockResolvedValue(new Blob(['result'], { type: 'image/png' }));
      await recoverCloudPhotoMessages([(await loadMessage(id))!]);
      const settled = new Promise<Message>(resolve => events.addEventListener(CLOUD_PHOTO_SETTLED_EVENT,
        e => resolve((e as CustomEvent<Message>).detail), { once: true }));
      vi.advanceTimersByTime(10_000);
      const updated = await settled;
      expect(updated.id).toBe(id);
      expect(updated.metadata?.chatPhoto.status).toBe('ready');
      expect(updated.content).toMatch(/^blobref:/);
      expect(mockedSubmit).not.toHaveBeenCalled();
    } finally {
      stopCloudPhotoPoller('task-after-reload');
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
  it('completed → 下载 → blobref → ready；重复补收幂等跳过', async () => {
    const messageId = await pendingMessage('task-ok');
    mockedQuery.mockResolvedValue({ status: 'completed', result: { contentType: 'image/png', byteSize: 12 } });
    mockedDownload.mockResolvedValue(new Blob(['png'], { type: 'image/png' }));

    const message = await loadMessage(messageId);
    expect(await settleCloudPhotoMessage(message as Message)).toBe('settled');
    const settled = await loadMessage(messageId);
    expect((settled?.metadata?.chatPhoto as { status: string }).status).toBe('ready');
    expect(String(settled?.content)).toMatch(/^blobref:/);

    // 第二次补收：消息已 ready → skip，不再下载/写库（幂等）
    expect(await settleCloudPhotoMessage(settled as Message)).toBe('skip');
    expect(mockedDownload).toHaveBeenCalledTimes(1);
  });

  it('failed → 原因落库；unknown 窗口内保持 pending、超窗后「结果待确认」', async () => {
    const failedId = await pendingMessage('task-failed');
    mockedQuery.mockResolvedValue({ status: 'failed', error: '上游返回 HTTP 500：boom' });
    expect(await settleCloudPhotoMessage(await loadMessage(failedId) as Message)).toBe('settled');
    const failedMessage = await loadMessage(failedId);
    expect((failedMessage?.metadata?.chatPhoto as { status: string }).status).toBe('failed');
    expect((failedMessage?.metadata?.chatPhoto as { reason: string }).reason).toContain('HTTP 500');

    const youngId = await pendingMessage('task-young-unknown', Date.now() - 60_000);
    mockedQuery.mockResolvedValue({ status: 'unknown' });
    expect(await settleCloudPhotoMessage(await loadMessage(youngId) as Message)).toBe('pending');

    const oldId = await pendingMessage('task-old-unknown', Date.now() - CLOUD_IMAGE_UNKNOWN_SETTLE_MS - 1000);
    expect(await settleCloudPhotoMessage(await loadMessage(oldId) as Message)).toBe('settled');
    const oldMessage = await loadMessage(oldId);
    expect((oldMessage?.metadata?.chatPhoto as { status: string }).status).toBe('failed');
    expect((oldMessage?.metadata?.chatPhoto as { reason: string }).reason).toContain('结果待确认');
  });

  it('recoverCloudPhotoMessages：批量补收只结算云任务，本地 pending 不碰', async () => {
    const cloudId = await pendingMessage('task-recover');
    const localId = await DB.saveMessage({
      charId: CHAR_ID, role: 'assistant', type: 'image', content: '',
      metadata: { chatPhoto: { status: 'pending', caption: '', includeCharacter: false, style: '', prompt: 'x', createdAt: Date.now() } },
    } as never);
    mockedQuery.mockResolvedValue({ status: 'completed', result: { contentType: 'image/png', byteSize: 12 } });
    mockedDownload.mockResolvedValue(new Blob(['png'], { type: 'image/png' }));

    const messages = await DB.getMessagesByCharId(CHAR_ID, true);
    const settled = await recoverCloudPhotoMessages(messages);
    expect(settled).toBe(1);
    const cloudMessage = await loadMessage(cloudId);
    expect((cloudMessage?.metadata?.chatPhoto as { status: string }).status).toBe('ready');
    // 本地 pending（无 cloudImageTaskId）保持 pending，交给本地 stale 结算
    const localMessage = await loadMessage(localId);
    expect((localMessage?.metadata?.chatPhoto as { status: string }).status).toBe('pending');
  });
});

describe('上游请求模板（与本地适配器同构）', () => {
  const config = {
    version: 1 as const, enabled: true, provider: 'gemini-native' as const,
    baseUrl: 'https://relay.example', apiKey: 'sk-test', model: 'gemini-img',
    defaultResolution: '2K' as const, defaultAspectRatio: '1:1' as const,
    allowReferenceImages: true, timeoutMs: 90000, authMode: 'api-key' as const,
  };

  it('gemini-native：generateContent + x-goog-api-key；openai-images：images/generations + Bearer；gpt-images 官方模型 output_format', () => {
    const gemini = buildCloudImageGenRequestTemplate(config, { prompt: 'a cat', style: 'soft' });
    expect(gemini.url).toContain('models/gemini-img:generateContent');
    expect(gemini.authHeaders['x-goog-api-key']).toBe('sk-test');
    expect((gemini.bodyJson as { contents: unknown[] }).contents).toBeTruthy();

    const openai = buildCloudImageGenRequestTemplate({ ...config, provider: 'openai-images' }, { prompt: 'a cat' });
    expect(openai.url).toContain('/images/generations');
    expect(openai.authHeaders.Authorization).toBe('Bearer sk-test');

    const gpt = buildCloudImageGenRequestTemplate({ ...config, provider: 'gpt-images', model: 'gpt-image-2.5-flare' }, { prompt: 'a cat' });
    expect((gpt.bodyJson as { output_format: string }).output_format).toBe('png');
  });

  it('不支持参考图的 provider 传参考图：明确抛错，绝不静默丢弃', () => {
    expect(() => buildCloudImageGenRequestTemplate(
      { ...config, provider: 'openai-images' },
      { prompt: 'a cat' },
      [{ mimeType: 'image/png', base64: 'AAAA' }],
    )).toThrowError(/参考图/);
  });
});

