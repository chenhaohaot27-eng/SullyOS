import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { completeChat } from './chatCompletionClient';
import { extractContent, extractJson } from './safeApi';

const scheduleSource = readFileSync(
  fileURLToPath(new URL('./scheduleGenerator.ts', import.meta.url)),
  'utf-8',
);
const theaterSource = readFileSync(
  fileURLToPath(new URL('./theaterGenerator.ts', import.meta.url)),
  'utf-8',
);
// 只取「日程自动生成」函数体；同文件下方 evolveFlowNarrative（已知死代码）不在本轮迁移范围。
const genFnStart = scheduleSource.indexOf('export async function generateDailyScheduleForChar');
const genFnEnd = scheduleSource.indexOf('export async function evolveFlowNarrative');
const genFnSource = scheduleSource.slice(genFnStart, genFnEnd > 0 ? genFnEnd : undefined);

const SCHEDULE_PROMPT = '你是日程系统。请根据以下角色与聊天记录生成今日日程 JSON：…';
const SCHEDULE_BODY = {
  model: 'schedule-model',
  messages: [{ role: 'user', content: SCHEDULE_PROMPT }],
  temperature: 0.85,
  max_tokens: 8000,
};
const SCHEDULE_JSON = {
  slots: [
    { startTime: '09:00', activity: '晨跑', description: '沿江晨跑', emoji: '🏃', location: '滨江步道' },
    { startTime: '14:00', activity: '工作室', description: '赶设计稿', emoji: '🎨' },
  ],
};

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Schedule 生成 · OpenAI-compatible 回归', () => {
  it('日程请求仍走 chat/completions，body 原样透传（单条 user prompt / 0.85 / 8000 / 零重试）', async () => {
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>): Promise<Response> => jsonResponse({
      choices: [{ message: { role: 'assistant', content: '```json\n' + JSON.stringify(SCHEDULE_JSON) + '\n```' } }],
    }));
    vi.stubGlobal('fetch', fetchMock);

    const data = await completeChat({
      baseUrl: 'https://api.example.com/v1/', apiKey: 'sk-schedule', model: 'schedule-model',
    }, SCHEDULE_BODY, {
      maxRetries: 0,
      meta: { appName: '日程系统', charId: 'c1', charName: '小星', purpose: '生成当日日程' },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/chat/completions');
    expect(JSON.parse(String(init?.body))).toEqual(SCHEDULE_BODY);
    // 与 scheduleGenerator 相同的解析管线：extractContent → extractJson → slots
    const parsed = extractJson(extractContent(data));
    expect(parsed.slots).toHaveLength(2);
    expect(parsed.slots[0]).toMatchObject({ startTime: '09:00', activity: '晨跑' });
  });

  it('OpenAI 429 在 maxRetries=0 下只发一次请求并抛错（调用方包装后返回 null）', async () => {
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>): Promise<Response> =>
      jsonResponse({ error: { message: '当前分组上游负载已饱和' } }, 429));
    vi.stubGlobal('fetch', fetchMock);

    await expect(completeChat({
      baseUrl: 'https://api.example.com/v1', apiKey: 'sk-schedule', model: 'schedule-model',
    }, SCHEDULE_BODY, { maxRetries: 0 }))
      .rejects.toThrow(/429/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('Schedule 生成 · Gemini Native', () => {
  const nativeConfig = {
    baseUrl: 'https://api.relayrouter.ai/',
    apiKey: 'native-key',
    model: 'gemini-2.5-pro',
    apiFormat: 'gemini-native' as const,
  };

  it('自动改走 streamGenerateContent，返回的日程 JSON 走同一解析管线产出 slots', async () => {
    const fetchImpl = vi.fn(async (..._args: Parameters<typeof fetch>): Promise<Response> => jsonResponse({
      candidates: [{
        content: { role: 'model', parts: [{ text: '```json\n' + JSON.stringify(SCHEDULE_JSON) + '\n```' }] },
        finishReason: 'STOP',
      }],
    }));

    const data = await completeChat(nativeConfig, SCHEDULE_BODY, {
      fetchImpl: fetchImpl as typeof fetch,
      maxRetries: 0,
    });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.relayrouter.ai/v1beta/models/schedule-model:streamGenerateContent?alt=sse');
    const sent = JSON.parse(String(init?.body));
    expect(sent.contents).toEqual([{ role: 'user', parts: [{ text: SCHEDULE_PROMPT }] }]);
    expect(sent.generationConfig).toEqual({ temperature: 0.85, maxOutputTokens: 8000 });

    const parsed = extractJson(extractContent(data));
    expect(parsed.slots).toHaveLength(2);
    expect(parsed.slots[1]).toMatchObject({ startTime: '14:00', activity: '工作室' });
  });

  it('Native 429 单次失败并保留上游 message，不自动重试', async () => {
    const fetchImpl = vi.fn(async (..._args: Parameters<typeof fetch>): Promise<Response> =>
      jsonResponse({ error: { message: '当前分组上游负载已饱和' } }, 429));

    await expect(completeChat(nativeConfig, SCHEDULE_BODY, { fetchImpl: fetchImpl as typeof fetch, maxRetries: 0 }))
      .rejects.toThrow(/当前分组上游负载已饱和/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('Schedule 生成 · 接线', () => {
  it('generateDailyScheduleForChar 统一走 completeChat：零重试、保留 meta 标签与解析管线，不再硬编码 chat/completions', () => {
    expect(genFnSource).toContain('completeChat(apiConfig,');
    expect(genFnSource).toContain('maxRetries: 0');
    expect(genFnSource).toContain("appName: '日程系统'");
    expect(genFnSource).toContain('extractContent(data)');
    expect(genFnSource).toContain('extractJson(content)');
    expect(genFnSource).not.toContain('/chat/completions');
    expect(genFnSource).not.toContain('await fetch(');
  });

  it('本轮未迁移 theaterGenerator（其自身调用点保持原样）', () => {
    expect(theaterSource).toContain('/chat/completions');
    expect(theaterSource).not.toContain('chatCompletionClient');
  });
});
