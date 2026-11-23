import { afterEach, describe, expect, it, vi } from 'vitest';

import { requestGeminiNativeChat } from './geminiNativeChat';
import { ChatParser } from './chatParser';

// 分层对照：上游原始字节 → SSE 重组文本 → 清洗后文本 → 分段后文本。
// 样本全部是脱敏的固定文本，不含任何真实对话 / 密钥。

const SAMPLE = '[[QUOTE: 示例引用]]\n[normal] 今天天气不错，我们去公园散步吧。\n[shy] 其实我有点紧张。\n2026-11-18 10:00';
const enc = new TextEncoder();

const geminiEvent = (text: string, extra: Record<string, unknown> = {}) => ({
  candidates: [{ content: { role: 'model', parts: [{ text }] }, ...extra }],
});

/** 把完整文本按 code point 切成 n 段增量（保证每段都是合法字符串）。 */
const splitDeltas = (text: string, size: number): string[] => {
  const chars = Array.from(text);
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(''));
  return out;
};

const sse = (deltas: string[], sep = '\n\n') =>
  deltas.map((d, index) => `data: ${JSON.stringify(geminiEvent(d, index === deltas.length - 1 ? { finishReason: 'STOP' } : {}))}${sep}`).join('');

/** 在任意字节位置（含 UTF-8 多字节中间）切开。 */
const byteChunks = (payload: string, size: number): Uint8Array[] => {
  const bytes = enc.encode(payload);
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.slice(i, i + size));
  return out;
};

const streamResponse = (chunks: Uint8Array[], contentType = 'text/event-stream') =>
  new Response(new ReadableStream<Uint8Array>({
    start(c) { chunks.forEach(x => c.enqueue(x)); c.close(); },
  }), { headers: { 'content-type': contentType } });

const callWith = async (response: Response) => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  const deltas: string[] = [];
  const data = await requestGeminiNativeChat(
    'https://relay.example/v1beta', 'sk-test', 'gemini-test',
    { messages: [{ role: 'user', content: 'hi' }] },
    { fetchImpl: (async () => response) as unknown as typeof fetch, streamHooks: { onDelta: d => deltas.push(d) } },
  );
  return { text: data.choices[0].message.content as string, deltas };
};

afterEach(() => vi.restoreAllMocks());

describe('Gemini Native SSE 重组：字节边界 / 事件格式', () => {
  const deltas = splitDeltas(SAMPLE, 3);

  it.each([1, 2, 3, 5, 7, 64])('字节切分 %i 字节：重组文本与原文一致', async (size) => {
    const { text } = await callWith(streamResponse(byteChunks(sse(deltas), size)));
    expect(text).toBe(SAMPLE);
  });

  it('CRLF 事件分隔', async () => {
    const { text } = await callWith(streamResponse(byteChunks(sse(deltas, '\r\n\r\n'), 5)));
    expect(text).toBe(SAMPLE);
  });

  it('`data:` 后无空格', async () => {
    const payload = sse(deltas).replace(/^data: /gm, 'data:');
    const { text } = await callWith(streamResponse(byteChunks(payload, 4)));
    expect(text).toBe(SAMPLE);
  });

  it('事件之间缺少空行（只有单个换行）时不丢也不重', async () => {
    const { text } = await callWith(streamResponse(byteChunks(sse(deltas, '\n'), 6)));
    expect(text).toBe(SAMPLE);
  });

  it('混入 SSE 注释 / event: / id: 字段行', async () => {
    const payload = ': keep-alive\n\n'
      + deltas.map((d, i) => `id: ${i}\nevent: message\ndata: ${JSON.stringify(geminiEvent(d))}\n\n`).join('')
      + 'data: {"candidates":[{"finishReason":"STOP"}]}\n\n'
      + 'data: [DONE]\n\n';
    const { text } = await callWith(streamResponse(byteChunks(payload, 5)));
    expect(text).toBe(SAMPLE);
  });

  it('流末尾没有结尾空行', async () => {
    const { text } = await callWith(streamResponse(byteChunks(sse(deltas, '\n\n').trimEnd(), 5)));
    expect(text).toBe(SAMPLE);
  });

  it('onDelta 的增量拼起来等于最终文本（无重复拼接）', async () => {
    const r = await callWith(streamResponse(byteChunks(sse(deltas), 5)));
    expect(r.deltas.join('')).toBe(r.text);
  });

  it('错标 content-type 的整包 JSON 数组', async () => {
    const body = JSON.stringify(deltas.map(d => geminiEvent(d)));
    const { text } = await callWith(streamResponse(byteChunks(body, 7), 'application/json'));
    expect(text).toBe(SAMPLE);
  });

  it('一个 event 里多个 parts：直接拼接，不插入分隔', async () => {
    const payload = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: '今天天' }, { text: '气不错' }] }, finishReason: 'STOP' }] })}\n\n`;
    const { text } = await callWith(streamResponse(byteChunks(payload, 9)));
    expect(text).toBe('今天天气不错');
  });
});

describe('分层定位：清洗与分段是否会把标签/词语拆开', () => {
  it('sanitize(keepCitations) 不改动正常中文与标签', () => {
    const cleaned = ChatParser.sanitize(SAMPLE, { keepCitations: true });
    for (const frag of ['今天天气不错，我们去公园散步吧。', '其实我有点紧张。', '[[QUOTE: 示例引用]]']) {
      expect(cleaned).toContain(frag);
    }
  });

  it('chunkText 只在显式换行处切分，词语内部不被切断', () => {
    const chunks = ChatParser.chunkText(ChatParser.sanitize(SAMPLE, { keepCitations: true }));
    for (const c of chunks) expect(c).not.toMatch(/^[，。！？、]/);
    expect(chunks.join('')).toContain('今天天气不错，我们去公园散步吧。');
  });
});
