import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    buildApiConnectionTestBody,
    classifyApiConnectionTestResponse,
    formatApiConnectionTestResult,
    runApiConnectionTest,
} from './apiConnectionTest';

const config = {
    baseUrl: 'https://fixture.test/v1',
    apiKey: 'fixture-key',
    model: 'fixture-model',
};
const privateThought = 'PRIVATE_PROVIDER_THOUGHT';

function completion(content: unknown, finishReason?: string) {
    return { choices: [{ message: { role: 'assistant', content, reasoning_content: privateThought }, finish_reason: finishReason }] };
}

function sse(events: unknown[], done = true) {
    return new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('')
        + (done ? 'data: [DONE]\n\n' : ''), { headers: { 'content-type': 'text/event-stream' } });
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('connection test request and result contract', () => {
    it.each([false, true])('uses a bounded synthetic request and keeps explicit stream=%s', stream => {
        const body = buildApiConnectionTestBody(config.model, stream);
        expect(body).toEqual({
            model: config.model,
            messages: [{ role: 'user', content: 'Reply with exactly OK.' }],
            max_tokens: 1024,
            stream,
        });
        for (const field of ['temperature', 'top_p', 'tools', 'thinking', 'reasoning_effort', 'extra_body', 'stream_options']) {
            expect(body).not.toHaveProperty(field);
        }
    });

    it('accepts only usable public text, including legacy replies without a finish reason', () => {
        const result = classifyApiConnectionTestResponse(completion([
            { type: 'thinking', thinking: privateThought },
            { thought: true, text: privateThought },
            { type: 'text', text: '<think>' + privateThought + '</think> OK ' },
        ], 'stop'));
        expect(result).toEqual({ status: 'success', reply: 'OK', finishReason: 'stop' });
        expect(JSON.stringify(result)).not.toContain(privateThought);
        expect(classifyApiConnectionTestResponse(completion(' OK '))).toMatchObject({ status: 'success', reply: 'OK' });
    });

    it.each(['partial reply', ''])('reports a limit even when returned content is %j', content => {
        const result = classifyApiConnectionTestResponse(completion(content, 'length'));
        expect(result).toEqual({ status: 'limit', reply: content, finishReason: 'length' });
        const message = formatApiConnectionTestResult(result);
        expect(message).toContain('接口已响应，但达到输出上限');
        expect(message).not.toContain('连接成功');
        if (!content) expect(message).toContain('未取得可用正文');
    });

    it.each([
        completion(' \n ', 'stop'),
        completion([{ type: 'thinking', thinking: privateThought }], 'stop'),
        { choices: [] },
    ])('does not call an empty or reasoning-only response successful', data => {
        const result = classifyApiConnectionTestResponse(data);
        expect(result).toMatchObject({ status: 'empty', reply: '' });
        expect(formatApiConnectionTestResult(result)).toContain('未取得可用正文');
        expect(formatApiConnectionTestResult(result)).not.toContain('连接成功');
    });

    it('rejects an interrupted response or malformed thought boundary without displaying partial text', () => {
        for (const data of [
            completion('partial', 'content_filter'),
            { ...completion('partial', 'stop'), stream_incomplete: true },
            { error: { message: 'upstream failed' } },
            completion('<think>' + privateThought, 'stop'),
        ]) {
            const result = classifyApiConnectionTestResponse(data);
            expect(result).toMatchObject({ status: 'error', reply: '' });
            expect(formatApiConnectionTestResult(result)).toContain('连接失败');
            expect(JSON.stringify(result)).not.toContain(privateThought);
        }
    });
});

describe('connection test through the production completion adapter', () => {
    it.each([false, true])('uses the OpenAI adapter with the requested stream=%s and no additional model parameters', async stream => {
        const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => stream
            ? sse([
                { choices: [{ delta: { reasoning_content: privateThought } }] },
                { choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] },
            ])
            : Response.json(completion('OK', 'stop')));
        vi.stubGlobal('fetch', fetchMock);
        const result = await runApiConnectionTest(config, stream);
        expect(result).toEqual({ status: 'success', reply: 'OK', finishReason: 'stop' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][0]).toBe('https://fixture.test/v1/chat/completions');
        expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
            model: config.model,
            messages: [{ role: 'user', content: 'Reply with exactly OK.' }],
            max_tokens: 1024,
            stream,
        });
    });

    it('retains a length result from an actual SSE response instead of treating its partial text as success', async () => {
        const fetchMock = vi.fn(async () => sse([
            { choices: [{ delta: { content: 'O' }, finish_reason: 'length' }] },
        ]));
        vi.stubGlobal('fetch', fetchMock);
        expect(await runApiConnectionTest(config, true)).toEqual({ status: 'limit', reply: 'O', finishReason: 'length' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('keeps HTTP 200 with only reasoning separate from a successful connection test', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => Response.json(completion(null, 'stop'))));
        expect(await runApiConnectionTest(config, false)).toEqual({ status: 'empty', reply: '', finishReason: 'stop' });
    });

    it.each([false, true])('uses the native Gemini adapter and its configured transport (nonStream=%s)', async nonStream => {
        const event = {
            candidates: [{ content: { role: 'model', parts: [
                { thought: true, text: privateThought }, { text: 'OK' },
            ] }, finishReason: nonStream ? 'MAX_TOKENS' : 'STOP' }],
        };
        const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => nonStream ? Response.json(event) : sse([event], false));
        vi.stubGlobal('fetch', fetchMock);
        const result = await runApiConnectionTest({
            ...config, baseUrl: 'https://fixture.test', apiFormat: 'gemini-native', geminiNonStream: nonStream,
        }, !nonStream);
        expect(result).toEqual({ status: nonStream ? 'limit' : 'success', reply: 'OK', finishReason: nonStream ? 'length' : 'stop' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][0]).toBe('https://fixture.test/v1beta/models/fixture-model:'
            + (nonStream ? 'generateContent' : 'streamGenerateContent?alt=sse'));
        expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
            contents: [{ role: 'user', parts: [{ text: 'Reply with exactly OK.' }] }],
            generationConfig: { maxOutputTokens: 1024 },
        });
    });

    it.each([400, 503, 'network'] as const)('reports %s once without retrying the model call', async failure => {
        const fetchMock = vi.fn(async () => {
            if (failure === 'network') throw new TypeError('connection unavailable');
            return Response.json({ error: { message: 'controlled failure' } }, { status: failure });
        });
        vi.stubGlobal('fetch', fetchMock);
        const result = await runApiConnectionTest(config, false);
        expect(result).toMatchObject({ status: 'error', reply: '' });
        expect(result.error).toContain(failure === 'network' ? 'connection unavailable' : String(failure));
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
