import { afterEach, describe, expect, it, vi } from 'vitest';
import { completeChat } from './chatCompletionClient';
import { buildGeminiNativeEndpoint } from './geminiNativeChat';
import { ChatParser } from './chatParser';

// 流式 / 非流式、OpenAI 兼容 / Gemini Native 四条路径对同一份脱敏样本的一致性，
// 以及 geminiNonStream 开关「默认不改变现有行为、不影响其他 API」。

const SAMPLE = '[[QUOTE: 示例引用]]\n[normal] 今天天气不错，我们去公园散步吧。\n[shy] 其实我有点紧张。\n這是繁體字：今天天氣不錯。';
const enc = new TextEncoder();

const chars = (text: string, size: number) => {
  const all = Array.from(text);
  const out: string[] = [];
  for (let i = 0; i < all.length; i += size) out.push(all.slice(i, i + size).join(''));
  return out;
};

const bytes = (payload: string, size: number): Uint8Array[] => {
  const raw = enc.encode(payload);
  const out: Uint8Array[] = [];
  for (let i = 0; i < raw.length; i += size) out.push(raw.slice(i, i + size));
  return out;
};

const body = (chunks: Uint8Array[]) => new ReadableStream<Uint8Array>({
  start(c) { chunks.forEach(x => c.enqueue(x)); c.close(); },
});

const geminiEvent = (text: string) => ({ candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }] });
const geminiSse = () => new Response(
  body(bytes(chars(SAMPLE, 3).map(d => `data: ${JSON.stringify(geminiEvent(d))}\n\n`).join(''), 5)),
  { headers: { 'content-type': 'text/event-stream' } },
);
const geminiJson = () => new Response(JSON.stringify(geminiEvent(SAMPLE)), { headers: { 'content-type': 'application/json' } });

const openAiSse = () => new Response(
  body(bytes(chars(SAMPLE, 3).map(d => `data: ${JSON.stringify({ choices: [{ delta: { content: d } }] })}\n\n`).join('') + 'data: [DONE]\n\n', 4)),
  { headers: { 'content-type': 'text/event-stream' } },
);
const openAiJson = () => new Response(
  JSON.stringify({ choices: [{ message: { role: 'assistant', content: SAMPLE }, finish_reason: 'stop' }] }),
  { headers: { 'content-type': 'application/json' } },
);

const pipeline = (raw: string) => {
  const cleaned = ChatParser.sanitize(raw, { keepCitations: true });
  return ChatParser.splitResponse(cleaned).flatMap(p => (p.type === 'text' ? ChatParser.chunkText(p.content) : []));
};

const gemini = { baseUrl: 'https://relay.example/v1beta', apiKey: 'sk-test', model: 'gemini-test', apiFormat: 'gemini-native' as const };
const openai = { baseUrl: 'https://relay.example/v1', apiKey: 'sk-test', model: 'm-test' };
const chatBody = { messages: [{ role: 'user', content: 'hi' }] };

const textOf = (data: any): string => data.choices[0].message.content;

describe('relay completion and chat protocol', () => {
  const prose = '保留会议时间 [2026-11-23 13:06] 和 12,345。';
  const raw = '[2026-1\n1-2\n3 13:0\n6] [2026-11-23 13:06] 你好。\n'
    + '[SEND_EM\nOJI: 恼火]\n' + prose + '\n[[SEND_EMOJI: 残缺';

  it.each([true, false])('preserves the complete reply (stream=%s)', async (stream) => {
    const events: object[] = chars(raw, 2)
      .map(content => ({ choices: [{ delta: { content } }] }));
    // Some relays send the complete message after their deltas.
    events.push({ choices: [{ message: { content: raw } }] });
    const sse = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
    const fetchImpl = vi.fn(async () => stream
      ? new Response(body(bytes(sse, 3)), { headers: { 'content-type': 'text/event-stream' } })
      : new Response(JSON.stringify({ choices: [{ message: { content: raw } }] }), { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchImpl);
    const result = await completeChat(openai, { ...chatBody, stream });
    const text = textOf(result);
    expect(text).toBe(raw);
    const parts = ChatParser.splitResponse(ChatParser.sanitize(text));
    expect(parts.map(p => p.type === 'emoji' ? p.content : ChatParser.chunkText(p.content))).toEqual([
      ['你好。'], '恼火', [prose],
    ]);
  });
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('buildGeminiNativeEndpoint', () => {
  it('默认仍是 streamGenerateContent?alt=sse', () => {
    expect(buildGeminiNativeEndpoint('https://r.example', 'gemini-x'))
      .toBe('https://r.example/v1beta/models/gemini-x:streamGenerateContent?alt=sse');
  });

  it('nonStream=true 才切到 generateContent（不带 alt=sse）', () => {
    expect(buildGeminiNativeEndpoint('https://r.example/v1beta', 'models/gemini-x', true))
      .toBe('https://r.example/v1beta/models/gemini-x:generateContent');
  });
});

describe('completeChat × Gemini Native：流式 / 非流式对照', () => {
  const run = async (config: Record<string, unknown>, response: () => Response) => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => response());
    const data = await completeChat({ ...gemini, ...config }, { ...chatBody }, { fetchImpl: fetchImpl as unknown as typeof fetch });
    return { data, url: String((fetchImpl.mock.calls[0] as unknown[])[0]) };
  };

  it('未设置 geminiNonStream：走流式端点（现有行为不变）', async () => {
    const { url, data } = await run({}, geminiSse);
    expect(url).toContain(':streamGenerateContent?alt=sse');
    expect(textOf(data)).toBe(SAMPLE);
  });

  it('geminiNonStream=false：同样走流式端点', async () => {
    const { url } = await run({ geminiNonStream: false }, geminiSse);
    expect(url).toContain(':streamGenerateContent');
  });

  it('geminiNonStream=true：走 generateContent，文本与流式逐字一致', async () => {
    const { url, data } = await run({ geminiNonStream: true }, geminiJson);
    expect(url).toMatch(/:generateContent$/);
    expect(textOf(data)).toBe(SAMPLE);
  });

  it('流式与非流式经清洗 + 分段后的气泡完全相同', async () => {
    const streamed = textOf((await run({}, geminiSse)).data);
    const whole = textOf((await run({ geminiNonStream: true }, geminiJson)).data);
    expect(pipeline(streamed)).toEqual(pipeline(whole));
    expect(pipeline(whole)).toEqual([
      '[[QUOTE: 示例引用]]',
      '今天天气不错，我们去公园散步吧。',
      '其实我有点紧张。',
      '這是繁體字：今天天氣不錯。',
    ]);
  });

  it('非流式 429 仍以上游错误抛出，不自动重试', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429 }));
    await expect(completeChat({ ...gemini, geminiNonStream: true }, { ...chatBody }, { fetchImpl: fetchImpl as unknown as typeof fetch }))
      .rejects.toMatchObject({ status: 429 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('completeChat × OpenAI 兼容：不受 geminiNonStream 影响', () => {
  const run = async (config: Record<string, unknown>, response: () => Response, stream: boolean) => {
    const fetchMock = vi.fn(async () => response());
    vi.stubGlobal('fetch', fetchMock);
    const data = await completeChat({ ...openai, ...config }, { ...chatBody, stream }, { maxRetries: 0 });
    return { data, url: String((fetchMock.mock.calls[0] as unknown[])[0]) };
  };

  it('SSE 按任意字节切开（含 UTF-8 多字节中间）：重组文本与原文一致', async () => {
    const { data, url } = await run({}, openAiSse, true);
    expect(url).toBe('https://relay.example/v1/chat/completions');
    expect(textOf(data)).toBe(SAMPLE);
  });

  it('整包 JSON 与 SSE 重组后的气泡完全相同', async () => {
    const streamed = textOf((await run({}, openAiSse, true)).data);
    const whole = textOf((await run({}, openAiJson, false)).data);
    expect(pipeline(streamed)).toEqual(pipeline(whole));
  });

  it('即便 geminiNonStream=true，OpenAI 兼容仍请求 /chat/completions', async () => {
    const { url } = await run({ geminiNonStream: true }, openAiJson, false);
    expect(url).toBe('https://relay.example/v1/chat/completions');
  });
});
