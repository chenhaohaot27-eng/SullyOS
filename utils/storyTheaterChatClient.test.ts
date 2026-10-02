import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { completeChat } from './chatCompletionClient';
import { appendStoryUserTurn, buildStoryPrefillInstruction, type StoryApiMessage } from './storyTheater';
import { buildGeminiNativeRequest } from './geminiNativeChat';
import { extractContent } from './safeApi';

const storySessionSource = readFileSync(
  fileURLToPath(new URL('../components/date/story/StoryTheaterSession.tsx', import.meta.url)),
  'utf-8',
);

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

const streamResponse = (chunks: Uint8Array[]) => new Response(new ReadableStream<Uint8Array>({
  start(controller) {
    chunks.forEach(chunk => controller.enqueue(chunk));
    controller.close();
  },
}), { headers: { 'content-type': 'text/event-stream' } });

const STORY_MESSAGES: Array<{ role: string; content: string }> = [
  { role: 'system', content: '### 剧场规则\n以中文撰写剧情正文。' },
  { role: 'user', content: '夜色渐深，两人走进白沙湾。' },
  { role: 'assistant', content: '海风把她的发丝吹乱……' },
  { role: 'user', content: '继续' },
];

const STORY_SETTINGS = {
  temperature: 0.9,
  top_p: 0.95,
  frequency_penalty: 0.1,
  presence_penalty: 0.05,
  max_tokens: 1600,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Story Theater · OpenAI-compatible 回归', () => {
  it('剧情请求仍走 chat/completions，body 原样透传，usage 回填 prompt tokens，单次请求', async () => {
    const responseBody = {
      choices: [{ message: { role: 'assistant', content: ' 夜色继续。' } }],
      usage: { prompt_tokens: 1234, completion_tokens: 88, total_tokens: 1322 },
    };
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>): Promise<Response> => jsonResponse(responseBody));
    vi.stubGlobal('fetch', fetchMock);

    const data = await completeChat({
      baseUrl: 'https://api.example.com/v1/', apiKey: 'sk-story', model: 'gpt-story',
    }, {
      model: 'gpt-story',
      messages: STORY_MESSAGES,
      stream: false,
      ...STORY_SETTINGS,
    }, { maxRetries: 0 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/chat/completions');
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'gpt-story',
      messages: STORY_MESSAGES,
      stream: false,
      ...STORY_SETTINGS,
    });

    // 与组件 callCompletion 相同的 usage / 正文处理
    const onPromptTokens = vi.fn();
    const reported = Number(data?.usage?.prompt_tokens);
    if (Number.isFinite(reported) && reported > 0) onPromptTokens?.(reported);
    expect(onPromptTokens).toHaveBeenCalledWith(1234);
    expect(extractContent(data).trim()).toBe('夜色继续。');
  });

  it('OpenAI 429 在 maxRetries=0 下同样只发一次请求', async () => {
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>): Promise<Response> =>
      jsonResponse({ error: { message: '当前分组上游负载已饱和' } }, 429));
    vi.stubGlobal('fetch', fetchMock);

    await expect(completeChat({
      baseUrl: 'https://api.example.com/v1', apiKey: 'sk-story', model: 'gpt-story',
    }, { model: 'gpt-story', messages: STORY_MESSAGES, stream: false }, { maxRetries: 0 }))
      .rejects.toThrow(/429/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('Story Theater · Gemini Native', () => {
  const nativeConfig = {
    baseUrl: 'https://api.relayrouter.ai/',
    apiKey: 'native-key',
    model: 'gemini-2.5-pro',
    apiFormat: 'gemini-native' as const,
  };

  it('普通剧情请求自动改走 streamGenerateContent：system 抽取、角色映射、generationConfig 转换', async () => {
    const fetchImpl = vi.fn(async (..._args: Parameters<typeof fetch>): Promise<Response> => jsonResponse({
      candidates: [{ content: { role: 'model', parts: [{ text: '她抬头望向灯塔，光在海面上碎成一片银。' }] }, finishReason: 'STOP' }],
    }));
    const result = await completeChat(nativeConfig, {
      model: 'gemini-2.5-pro',
      messages: STORY_MESSAGES,
      stream: false,
      ...STORY_SETTINGS,
    }, { fetchImpl: fetchImpl as typeof fetch, maxRetries: 0 });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.relayrouter.ai/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse');
    const sent = JSON.parse(String(init?.body));
    expect(sent.systemInstruction).toEqual({ parts: [{ text: '### 剧场规则\n以中文撰写剧情正文。' }] });
    expect(sent.contents).toEqual([
      { role: 'user', parts: [{ text: '夜色渐深，两人走进白沙湾。' }] },
      { role: 'model', parts: [{ text: '海风把她的发丝吹乱……' }] },
      { role: 'user', parts: [{ text: '继续' }] },
    ]);
    expect(sent.generationConfig).toEqual({ temperature: 0.9, topP: 0.95, maxOutputTokens: 1600 });
    expect(extractContent(result).trim()).toBe('她抬头望向灯塔，光在海面上碎成一片银。');
  });

  it('Native SSE：中文跨 chunk 拼装、thought 不进入正文、usageMetadata 归一为 OpenAI usage', async () => {
    const firstEvent = {
      candidates: [{
        content: {
          role: 'model',
          parts: [
            { text: '晚风拂过' },
            { thought: true, text: '内心规划不得外泄' },
            { text: '海面', thoughtSignature: 'sig-should-not-leak' },
          ],
        },
      }],
    };
    const secondEvent = {
      candidates: [{
        content: { role: 'model', parts: [{ text: '，灯塔亮起。' }] },
        finishReason: 'STOP',
      }],
      usageMetadata: { promptTokenCount: 321, candidatesTokenCount: 45, totalTokenCount: 366 },
    };
    const raw = new TextEncoder().encode(
      `data: ${JSON.stringify(firstEvent)}\n\ndata: ${JSON.stringify(secondEvent)}\n\n`,
    );
    // 故意在第 1 个事件的 UTF-8 多字节字符中间切开，验证跨 chunk 中文
    const fetchImpl = vi.fn(async (..._args: Parameters<typeof fetch>): Promise<Response> =>
      streamResponse([raw.slice(0, 60), raw.slice(60)]));

    const result = await completeChat(nativeConfig, {
      model: 'gemini-2.5-pro',
      messages: STORY_MESSAGES,
      stream: false,
    }, { fetchImpl: fetchImpl as typeof fetch });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const content = extractContent(result);
    expect(content).toBe('晚风拂过海面，灯塔亮起。');
    expect(content).not.toContain('内心规划');
    expect(JSON.stringify(result)).not.toContain('sig-should-not-leak');
    expect(result.usage).toEqual({ prompt_tokens: 321, completion_tokens: 45, total_tokens: 366 });
  });

  it('Native 429 单次失败，保留 RelayRouter 原始 error.message，不自动重发', async () => {
    const fetchImpl = vi.fn(async (..._args: Parameters<typeof fetch>): Promise<Response> =>
      jsonResponse({ error: { message: '当前分组上游负载已饱和' } }, 429));

    await expect(completeChat(nativeConfig, {
      model: 'gemini-2.5-pro',
      messages: STORY_MESSAGES,
      stream: false,
    }, { fetchImpl: fetchImpl as typeof fetch }))
      .rejects.toThrow(/当前分组上游负载已饱和/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('Story Theater · assistant prefill 兼容', () => {
  it('Native 复用既有 400 兼容路径：预填改写为 system 约束、最终消息保持 user', () => {
    const prefill: StoryApiMessage = { role: 'assistant', content: '<scene_header>\n夜 · 白沙湾' };
    const payload = appendStoryUserTurn(
      [{ role: 'system', content: '规则' }, { role: 'user', content: '第一幕' }],
      '继续',
      prefill,
      true,
    );

    expect(payload[payload.length - 1]).toEqual({ role: 'user', content: '继续' });
    expect(payload).toContainEqual(buildStoryPrefillInstruction(prefill));

    // 转成 Native 请求后：contents 不含以预填结尾的 model turn，最终 role 仍是 user
    const nativeRequest = buildGeminiNativeRequest({ messages: payload });
    const last = nativeRequest.contents[nativeRequest.contents.length - 1];
    expect(last.role).toBe('user');
    expect(JSON.stringify(nativeRequest.contents)).not.toContain('白沙湾');
  });

  it('返回正文缺失预填前缀时按组件逻辑本地补齐，续写语义不变', () => {
    const prefill = '<scene_header>';
    const backfill = (generated: string) => (prefill && !generated.startsWith(prefill) ? `${prefill}${generated}` : generated);
    expect(backfill('夜色继续。')).toBe('<scene_header>夜色继续。');
    expect(backfill('<scene_header>她转过身。')).toBe('<scene_header>她转过身。');
  });

  it('组件接线：统一走 completeChat，Native 强制 user-last，且保留本地前缀补齐', () => {
    expect(storySessionSource).toContain("from '../../../utils/chatCompletionClient'");
    expect(storySessionSource).toMatch(/completeChat\(apiConfig,/);
    expect(storySessionSource).toMatch(/normalizeChatApiFormat\(apiConfig\.apiFormat\) === 'gemini-native'/);
    expect(storySessionSource).toMatch(/promptEntry\.forceUserLastMessage === true/);
    expect(storySessionSource).toMatch(/generated\.startsWith\(prefill\)/);
    expect(storySessionSource).not.toContain('/chat/completions');
    expect(storySessionSource).not.toContain('v1beta');
  });
});

