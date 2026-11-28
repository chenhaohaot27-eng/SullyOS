import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logs = vi.hoisted(() => ({ recordApiCall: vi.fn() }));
vi.mock('./apiCallLog', async importOriginal => ({
  ...await importOriginal<typeof import('./apiCallLog')>(),
  recordApiCall: logs.recordApiCall,
}));

import { buildAssistantToolFollowUpMessage, completeCharacterChat } from './chatCompletionClient';
import { buildGeminiNativeRequest } from './geminiNativeChat';

type Mode = 'openai-compatible' | 'gemini-native';
const requestId = 'api-character-diagnostic-fixture';
const meta = { appName: '消息', purpose: '聊天回复' };
const body = { model: 'fixture-model', stream: false,
  messages: [{ role: 'system', content: 'PRIVATE_SYSTEM_PROMPT' }, { role: 'user', content: '你好' }] };

function config(mode: Mode) {
  return { baseUrl: 'https://fixture.test/v1', apiKey: 'PRIVATE_KEY', model: body.model,
    apiFormat: mode, geminiNonStream: true };
}

function response(mode: Mode, content: string): Response {
  return mode === 'gemini-native'
    ? Response.json({ modelVersion: 'reported-model', candidates: [{ content: { parts: [
      { thought: true, text: 'PRIVATE_PROVIDER_THOUGHT' }, { text: content },
    ] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 5, totalTokenCount: 17 } })
    : Response.json({ model: 'reported-model', choices: [{ message: {
      role: 'assistant', content, reasoning_content: 'PRIVATE_PROVIDER_THOUGHT',
    }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } });
}

beforeEach(() => logs.recordApiCall.mockReset());
afterEach(() => vi.unstubAllGlobals());

describe.each(['openai-compatible', 'gemini-native'] as const)('%s character reply diagnostics', mode => {
  it('merges final validation into the same HTTP request ID and retains reported usage', async () => {
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => response(mode, '晚上好。'));
    vi.stubGlobal('fetch', fetchMock);
    const result = await completeCharacterChat(config(mode), body, { requestId, meta });
    expect(result.choices[0].message.content).toBe('晚上好。');
    const entries = logs.recordApiCall.mock.calls.map(([entry]) => entry);
    expect(entries).toHaveLength(2);
    expect(entries.every(entry => entry.requestId === requestId)).toBe(true);
    expect(entries.find(entry => entry.ok === true)).toBeDefined();
    const validation = entries.find(entry => entry.replyValidation === 'passed');
    expect(validation).toMatchObject({ requestId, meta, response: {
      model: 'reported-model', usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
    } });
    expect(validation).not.toHaveProperty('ok');
    expect(validation).not.toHaveProperty('errorDetail');
    expect(validation.body).toEqual({ model: body.model });
    expect(JSON.stringify(validation)).not.toContain('PRIVATE_');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    if (mode === 'openai-compatible') {
      expect(fetchMock.mock.calls[0][1]).toMatchObject({ __sullyApiCallId: requestId });
      expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).not.toHaveProperty('requestId');
    }
  });

  it('records HTTP-successful boundary rejection without replacing transport status or usage', async () => {
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => response(mode, 'PRIVATE_PREAMBLE<reply-wrong>PRIVATE_REPLY'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(completeCharacterChat(config(mode), body, { requestId, meta }))
      .rejects.toMatchObject({ code: 'LLM_REPLY_BOUNDARY' });
    const entries = logs.recordApiCall.mock.calls.map(([entry]) => entry);
    expect(entries).toHaveLength(2);
    expect(entries.every(entry => entry.requestId === requestId)).toBe(true);
    expect(entries.find(entry => entry.ok === true)).toBeDefined();
    const validation = entries.find(entry => entry.replyValidation === 'failed');
    expect(validation).toMatchObject({ requestId, meta, response: {
      usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
    } });
    expect(validation).not.toHaveProperty('ok');
    expect(validation).not.toHaveProperty('status');
    expect(validation.errorDetail).toBe('正文校验失败（LLM_REPLY_BOUNDARY），本轮正文与动作未释放。');
    expect(validation.response).not.toHaveProperty('content');
    expect(validation.response.choices[0]).toEqual({ finish_reason: 'stop' });
    expect(JSON.stringify(validation)).not.toContain('PRIVATE_');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('also associates a boundary error thrown by the lower response parser without inventing HTTP or usage', async () => {
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => response(mode, 'PRIVATE_TEXT</think>'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(completeCharacterChat(config(mode), body, { requestId, meta }))
      .rejects.toMatchObject({ code: 'LLM_REPLY_BOUNDARY' });
    expect(logs.recordApiCall).toHaveBeenCalledTimes(1);
    const validation = logs.recordApiCall.mock.calls[0][0];
    expect(validation).toMatchObject({ requestId, replyValidation: 'failed', meta });
    expect(validation).not.toHaveProperty('ok');
    expect(validation).not.toHaveProperty('status');
    expect(validation.response).toBeUndefined();
    expect(JSON.stringify(validation)).not.toContain('PRIVATE_');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not relabel a network failure as a reply boundary failure or retry it', async () => {
    const error = new TypeError('network unavailable');
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => { throw error; });
    vi.stubGlobal('fetch', fetchMock);
    await expect(completeCharacterChat(config(mode), body, { requestId, meta })).rejects.toBe(error);
    expect(logs.recordApiCall).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not relabel or retry an upstream HTTP error', async () => {
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => Response.json({ error: { message: 'upstream unavailable' } }, { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(completeCharacterChat(config(mode), body, { requestId, meta })).rejects.toThrow('503');
    expect(logs.recordApiCall).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

it('preserves Gemini tool signatures while adding the final validation record', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ candidates: [{ content: { parts: [{
    functionCall: { id: 'call_lookup', name: 'lookup', args: { q: 'x' } },
    thoughtSignature: 'PRIVATE_TOOL_SIGNATURE',
  }] }, finishReason: 'STOP' }] })));
  const result = await completeCharacterChat(config('gemini-native'), body, { requestId, meta });
  const message = result.choices[0].message;
  const followUp = buildAssistantToolFollowUpMessage(message, message.tool_calls);
  expect(followUp).toBe(message);
  const native = buildGeminiNativeRequest({ messages: [
    { role: 'user', content: '查找' }, followUp,
    { role: 'tool', tool_call_id: 'call_lookup', content: '{"ok":true}' },
  ] });
  expect(native.contents[1].parts[0].thoughtSignature).toBe('PRIVATE_TOOL_SIGNATURE');
  const validation = logs.recordApiCall.mock.calls.map(([entry]) => entry)
    .find(entry => entry.replyValidation === 'passed');
  expect(JSON.stringify(validation)).not.toContain('PRIVATE_');
});
