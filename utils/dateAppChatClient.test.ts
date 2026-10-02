import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { completeChat } from './chatCompletionClient';
import { extractContent } from './safeApi';

const dateAppSource = readFileSync(
  fileURLToPath(new URL('../apps/DateApp.tsx', import.meta.url)),
  'utf-8',
);

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

// 与 DatePrompts 产出的见面消息同形：system 场景 + user/assistant 历史 + 最新 user 输入
const DATE_MESSAGES: Array<{ role: string; content: string }> = [
  { role: 'system', content: '你们正在白沙湾的海边散步，时间是傍晚。' },
  { role: 'user', content: '你看向远处的灯塔' },
  { role: 'assistant', content: '她顺着你的目光望去，轻声说：「每次涨潮它都会亮。」' },
  { role: 'user', content: '你握住她的手' },
];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Date / 见面 · OpenAI-compatible 回归', () => {
  it('见面请求仍走 chat/completions，model/messages/temperature/max_tokens/stream 原样透传，单次请求', async () => {
    const responseBody = {
      choices: [{ message: { role: 'assistant', content: '她的手指微微一颤，随后回握住你。' } }],
    };
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>): Promise<Response> => jsonResponse(responseBody));
    vi.stubGlobal('fetch', fetchMock);

    const result = await completeChat({
      baseUrl: 'https://api.example.com/v1/', apiKey: 'sk-date', model: 'gpt-date',
    }, {
      model: 'gpt-date',
      messages: DATE_MESSAGES,
      temperature: 0.85,
      max_tokens: 8000,
      stream: false,
    }, { maxRetries: 0 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/chat/completions');
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'gpt-date',
      messages: DATE_MESSAGES,
      temperature: 0.85,
      max_tokens: 8000,
      stream: false,
    });
    expect(extractContent(result)).toBe('她的手指微微一颤，随后回握住你。');
  });
});

describe('Date / 见面 · Gemini Native', () => {
  const nativeConfig = {
    baseUrl: 'https://api.relayrouter.ai/',
    apiKey: 'native-key',
    model: 'gemini-2.5-pro',
    apiFormat: 'gemini-native' as const,
  };

  it('system/user/assistant 自动转换：systemInstruction + user/model contents，中文回复正常取出', async () => {
    const fetchImpl = vi.fn(async (..._args: Parameters<typeof fetch>): Promise<Response> => jsonResponse({
      candidates: [{ content: { role: 'model', parts: [{ text: '她没有抽回手，只是抬眼看你，耳尖泛红。' }] }, finishReason: 'STOP' }],
    }));
    const result = await completeChat(nativeConfig, {
      model: 'gemini-2.5-pro',
      messages: DATE_MESSAGES,
      temperature: 0.85,
      max_tokens: 8000,
      stream: false,
    }, { fetchImpl: fetchImpl as typeof fetch, maxRetries: 0 });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.relayrouter.ai/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse');
    const sent = JSON.parse(String(init?.body));
    expect(sent.systemInstruction).toEqual({ parts: [{ text: '你们正在白沙湾的海边散步，时间是傍晚。' }] });
    expect(sent.contents).toEqual([
      { role: 'user', parts: [{ text: '你看向远处的灯塔' }] },
      { role: 'model', parts: [{ text: '她顺着你的目光望去，轻声说：「每次涨潮它都会亮。」' }] },
      { role: 'user', parts: [{ text: '你握住她的手' }] },
    ]);
    expect(sent.generationConfig).toEqual({ temperature: 0.85, maxOutputTokens: 8000 });
    expect(extractContent(result)).toBe('她没有抽回手，只是抬眼看你，耳尖泛红。');
  });

  it('Native 429 单次失败，保留上游原始 error.message，不自动重发', async () => {
    const fetchImpl = vi.fn(async (..._args: Parameters<typeof fetch>): Promise<Response> =>
      jsonResponse({ error: { message: '当前分组上游负载已饱和' } }, 429));

    await expect(completeChat(nativeConfig, {
      model: 'gemini-2.5-pro',
      messages: DATE_MESSAGES,
      temperature: 0.85,
      stream: false,
    }, { fetchImpl: fetchImpl as typeof fetch }))
      .rejects.toThrow(/当前分组上游负载已饱和/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('组件接线：callLLM 统一走 completeChat，不再硬编码 chat/completions，也没有第二套 Gemini 实现', () => {
    expect(dateAppSource).toContain("from '../utils/chatCompletionClient'");
    expect(dateAppSource).toMatch(/completeChat\(apiConfig,/);
    expect(dateAppSource).toContain('maxRetries: 0');
    expect(dateAppSource).not.toContain('/chat/completions');
    expect(dateAppSource).not.toContain('v1beta');
    expect(dateAppSource).not.toContain('streamGenerateContent');
  });
});
