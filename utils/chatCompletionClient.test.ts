import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildAssistantToolFollowUpMessage, completeChat } from './chatCompletionClient';
import { buildGeminiNativeRequest } from './geminiNativeChat';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('completeChat', () => {
  it('keeps legacy configs on the existing OpenAI-compatible URL and body', async () => {
    const body = {
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hello' }],
      temperature: 0.6,
      stream: false,
    };
    const responseBody = { choices: [{ message: { role: 'assistant', content: 'hi' } }] };
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>): Promise<Response> => new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await completeChat({
      baseUrl: 'https://api.example.com/v1/', apiKey: 'legacy-key', model: 'gpt-test',
    }, body);

    expect(result).toEqual(responseBody);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/chat/completions');
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer legacy-key' },
    });
    expect(JSON.parse(String(init?.body))).toEqual(body);
  });

  it('treats an illegal apiFormat as OpenAI-compatible and fills a missing model', async () => {
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>): Promise<Response> => new Response(JSON.stringify({ choices: [] }), {
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await completeChat({
      baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'configured-model', apiFormat: 'bad' as any,
    }, { messages: [] });

    expect(String(fetchMock.mock.calls[0][0])).toContain('/chat/completions');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).model).toBe('configured-model');
  });

  it('dispatches Gemini Native without leaking OpenAI-only request fields', async () => {
    const fetchImpl = vi.fn(async (..._args: Parameters<typeof fetch>): Promise<Response> => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'native' }] }, finishReason: 'STOP' }],
    }), { headers: { 'content-type': 'application/json' } }));
    const result = await completeChat({
      baseUrl: 'https://api.relayrouter.ai/',
      apiKey: 'native-key',
      model: 'gemini-2.5-pro',
      apiFormat: 'gemini-native',
    }, {
      model: 'gemini-2.5-pro',
      messages: [{ role: 'system', content: '规则' }, { role: 'user', content: '你好' }],
      temperature: 1,
      top_p: 0.9,
      max_tokens: 1024,
      stream: true,
      reasoning_effort: 'high',
      extra_body: { thinking: true },
    }, { fetchImpl: fetchImpl as typeof fetch });

    expect(result.choices[0].message.content).toBe('native');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.relayrouter.ai/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse');
    expect(init?.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer native-key',
    });
    const sent = JSON.parse(String(init?.body));
    expect(sent).toEqual({
      contents: [{ role: 'user', parts: [{ text: '你好' }] }],
      systemInstruction: { parts: [{ text: '规则' }] },
      generationConfig: { temperature: 1, topP: 0.9, maxOutputTokens: 1024 },
    });
  });

  it('keeps Gemini provider state intact across a tool follow-up', async () => {
    const fetchImpl = vi.fn(async (..._args: Parameters<typeof fetch>): Promise<Response> => new Response(JSON.stringify({
      candidates: [{ content: { role: 'model', parts: [{
        functionCall: { id: 'call_1', name: 'lookup', args: { q: 'x' } },
        thoughtSignature: 'signature-only-in-memory',
      }] } }],
    }), { headers: { 'content-type': 'application/json' } }));
    const first = await completeChat({
      baseUrl: 'https://api.relayrouter.ai', apiKey: 'k', model: 'gemini-2.5-pro', apiFormat: 'gemini-native',
    }, {
      messages: [{ role: 'user', content: '查找' }],
      tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
    }, { fetchImpl: fetchImpl as typeof fetch });

    const responseMessage = first.choices[0].message;
    const followUpAssistant = buildAssistantToolFollowUpMessage(responseMessage, responseMessage.tool_calls);
    expect(followUpAssistant).toBe(responseMessage);
    expect(JSON.stringify(followUpAssistant)).not.toContain('signature-only-in-memory');

    const nativeFollowUp = buildGeminiNativeRequest({ messages: [
      { role: 'user', content: '查找' },
      followUpAssistant,
      { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' },
    ] });
    expect(nativeFollowUp.contents[1].parts[0].thoughtSignature).toBe('signature-only-in-memory');
    expect(nativeFollowUp.contents[2].parts[0]).toEqual({
      functionResponse: { id: 'call_1', name: 'lookup', response: { ok: true } },
    });
  });

  it('keeps the existing OpenAI assistant tool-message shape', () => {
    const toolCalls = [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } }];
    expect(buildAssistantToolFollowUpMessage({ role: 'assistant', content: '', tool_calls: toolCalls }, toolCalls)).toEqual({
      role: 'assistant',
      content: '(调用工具中)',
      tool_calls: toolCalls,
    });
  });
});
