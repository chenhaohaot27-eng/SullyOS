import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  GeminiNativeAdapterError,
  buildGeminiNativeEndpoint,
  buildGeminiNativeRequest,
  getGeminiProviderState,
  requestGeminiNativeChat,
} from './geminiNativeChat';

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

afterEach(() => vi.restoreAllMocks());

describe('Gemini Native URL and request conversion', () => {
  it('normalizes root/v1beta base URLs and models/ prefixes', () => {
    expect(buildGeminiNativeEndpoint('https://api.relayrouter.ai/', 'gemini-2.5-pro')).toBe(
      'https://api.relayrouter.ai/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse',
    );
    expect(buildGeminiNativeEndpoint('https://api.relayrouter.ai/v1beta/', 'models/gemini 2.5')).toBe(
      'https://api.relayrouter.ai/v1beta/models/gemini%202.5:streamGenerateContent?alt=sse',
    );
    expect(buildGeminiNativeEndpoint('https://api.relayrouter.ai/v1beta/models', 'gemini-x')).toBe(
      'https://api.relayrouter.ai/v1beta/models/gemini-x:streamGenerateContent?alt=sse',
    );
  });

  it('extracts system text, maps roles, merges adjacent roles and converts data images', () => {
    const request = buildGeminiNativeRequest({
      messages: [
        { role: 'system', content: '规则一' },
        { role: 'user', content: '第一句' },
        { role: 'user', content: [
          { type: 'text', text: '第二句' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
        ] },
        { role: 'assistant', content: '回答一' },
        { role: 'assistant', content: '回答二' },
        { role: 'system', content: [{ type: 'text', text: '规则二' }] },
      ],
      temperature: 0.7,
      top_p: 0.8,
      max_tokens: 2048,
      stream: true,
      reasoning_effort: 'high',
    });

    expect(request.systemInstruction).toEqual({ parts: [{ text: '规则一' }, { text: '规则二' }] });
    expect(request.contents).toEqual([
      {
        role: 'user',
        parts: [
          { text: '第一句' },
          { text: '第二句' },
          { inlineData: { mimeType: 'image/png', data: 'QUJD' } },
        ],
      },
      { role: 'model', parts: [{ text: '回答一' }, { text: '回答二' }] },
    ]);
    expect(request.generationConfig).toEqual({ temperature: 0.7, topP: 0.8, maxOutputTokens: 2048 });
    expect(request).not.toHaveProperty('stream');
    expect(request).not.toHaveProperty('reasoning_effort');
  });

  it('fails clearly instead of silently dropping remote/blob images', () => {
    for (const url of ['https://example.com/a.png', 'blob:https://example.com/id']) {
      expect(() => buildGeminiNativeRequest({
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url } }] }],
      })).toThrow(GeminiNativeAdapterError);
    }
  });

  it('converts declarations, common schema, tool choice, calls and multiple responses', () => {
    const request = buildGeminiNativeRequest({
      messages: [
        { role: 'user', content: '查一下' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'call_a', type: 'function', function: { name: 'weather', arguments: '{"city":"上海"}' } },
            { id: 'call_b', type: 'function', function: { name: 'clock', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_a', content: '{"temp":26}' },
        { role: 'tool', tool_call_id: 'call_b', content: '10:30' },
      ],
      tools: [{
        type: 'function',
        function: {
          name: 'weather',
          description: '天气',
          parameters: {
            type: 'object',
            properties: {
              city: { type: 'string', description: '城市' },
              unit: { type: ['string', 'null'], enum: ['c', 'f', null] },
            },
            required: ['city', 'missing'],
            additionalProperties: false,
          },
        },
      }],
      tool_choice: { type: 'function', function: { name: 'weather' } },
    });

    expect(request.tools).toEqual([{ functionDeclarations: [{
      name: 'weather',
      description: '天气',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string', description: '城市' },
          unit: { type: 'string', nullable: true, enum: ['c', 'f'] },
        },
        required: ['city'],
      },
    }] }]);
    expect(request.toolConfig).toEqual({
      functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['weather'] },
    });
    expect(request.contents[1].parts).toHaveLength(2);
    expect(request.contents[2]).toEqual({
      role: 'user',
      parts: [
        { functionResponse: { id: 'call_a', name: 'weather', response: { temp: 26 } } },
        { functionResponse: { id: 'call_b', name: 'clock', response: { result: '10:30' } } },
      ],
    });
  });

  it.each([
    ['auto', 'AUTO'],
    ['none', 'NONE'],
    ['required', 'ANY'],
  ])('maps tool_choice %s', (choice, expected) => {
    expect(buildGeminiNativeRequest({ messages: [], tool_choice: choice }).toolConfig)
      .toEqual({ functionCallingConfig: { mode: expected } });
  });
});

describe('Gemini Native response normalization', () => {
  it('parses split UTF-8 SSE, all parts, thought filtering, usage and provider state', async () => {
    const payload1 = JSON.stringify({
      candidates: [
        { content: { role: 'model', parts: [
          { text: '内部思考', thought: true, thoughtSignature: 'sig-secret' },
          { text: '你' },
          { functionCall: { id: 'call_1', name: 'weather', args: { city: '上海' } }, thoughtSignature: 'sig-call' },
        ] } },
        { content: { role: 'model', parts: [{ text: '第二候选不得出现' }] } },
      ],
      modelVersion: 'gemini-2.5-pro',
    });
    const payload2 = JSON.stringify({
      candidates: [{ content: { role: 'model', parts: [{ text: '好' }, { text: '！' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 },
    });
    const bytes = new TextEncoder().encode(`data: ${payload1}\n\ndata: ${payload2}\n\n`);
    const splitAt = Math.max(1, bytes.findIndex((byte, index) => index > 8 && byte >= 0x80) + 1);
    const deltas: string[] = [];
    const fetchImpl = vi.fn(async () => streamResponse([
      bytes.slice(0, splitAt),
      bytes.slice(splitAt, splitAt + 1),
      bytes.slice(splitAt + 1),
    ]));

    const result = await requestGeminiNativeChat(
      'https://api.relayrouter.ai', 'secret', 'gemini-2.5-pro',
      { messages: [{ role: 'user', content: '开始' }] },
      { fetchImpl: fetchImpl as typeof fetch, streamHooks: { onDelta: delta => deltas.push(delta) } },
    );

    expect(result.choices[0]).toMatchObject({
      finish_reason: 'stop',
      message: {
        role: 'assistant',
        content: '你好！',
        tool_calls: [{
          id: 'call_1', type: 'function', function: { name: 'weather', arguments: '{"city":"上海"}' },
        }],
      },
    });
    expect(deltas).toEqual(['你', '好', '！']);
    expect(result.model).toBe('gemini-2.5-pro');
    expect(result.usage).toEqual({ prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 });
    expect(JSON.stringify(result)).not.toContain('sig-secret');
    expect(JSON.stringify(result)).not.toContain('内部思考');

    const state = getGeminiProviderState(result.choices[0].message);
    expect(state?.parts.map(part => part.thoughtSignature).filter(Boolean)).toEqual(['sig-secret', 'sig-call']);
    const followUp = buildGeminiNativeRequest({ messages: [
      { role: 'user', content: '开始' },
      result.choices[0].message,
      { role: 'tool', tool_call_id: 'call_1', content: '{"temp":26}' },
    ] });
    expect(followUp.contents[1].parts).toEqual(state?.parts);
    expect(followUp.contents[2].parts[0]).toEqual({
      functionResponse: { id: 'call_1', name: 'weather', response: { temp: 26 } },
    });
  });

  it('also accepts a non-streaming JSON response from an SSE endpoint', async () => {
    const result = await requestGeminiNativeChat('https://x', 'k', 'gemini-x', {
      messages: [{ role: 'user', content: 'x' }],
    }, {
      fetchImpl: vi.fn(async () => jsonResponse({
        candidates: [{ content: { parts: [{ text: '完整响应' }] }, finishReason: 'MAX_TOKENS' }],
      })) as typeof fetch,
    });
    expect(result.choices[0].message.content).toBe('完整响应');
    expect(result.choices[0].finish_reason).toBe('length');
  });

  it('keeps the correct function name when Gemini omits a native call id', async () => {
    const result = await requestGeminiNativeChat('https://x', 'k', 'gemini-x', {
      messages: [{ role: 'user', content: 'x' }],
    }, {
      fetchImpl: vi.fn(async () => jsonResponse({
        candidates: [{ content: { parts: [{ functionCall: { name: 'clock', args: {} } }] } }],
      })) as typeof fetch,
    });
    expect(result.choices[0].message.tool_calls[0].id).toBe('call_gemini_0');

    const followUp = buildGeminiNativeRequest({ messages: [
      { role: 'user', content: 'x' },
      result.choices[0].message,
      { role: 'tool', tool_call_id: 'call_gemini_0', content: '10:30' },
    ] });
    expect(followUp.contents[2].parts[0]).toEqual({
      functionResponse: { name: 'clock', response: { result: '10:30' } },
    });
  });

  it.each([400, 401, 429, 500])('preserves HTTP %s error.message and never retries', async status => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { message: `upstream-${status}` } }, status));
    await expect(requestGeminiNativeChat('https://x', 'k', 'gemini-x', {
      messages: [{ role: 'user', content: 'x' }],
    }, { fetchImpl: fetchImpl as typeof fetch })).rejects.toThrow(`upstream-${status}`);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('passes AbortSignal through without wrapping AbortError', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      throw new DOMException('aborted', 'AbortError');
    });
    await expect(requestGeminiNativeChat('https://x', 'k', 'gemini-x', {
      messages: [{ role: 'user', content: 'x' }],
    }, { signal: controller.signal, fetchImpl: fetchImpl as typeof fetch })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
