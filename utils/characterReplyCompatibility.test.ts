import { afterEach, describe, expect, it, vi } from 'vitest';
import { completeCharacterChat } from './chatCompletionClient';
import { characterTransport } from './characterTransport';

type Mode = 'openai' | 'gemini-native' | 'cloud';
const privateText = '内部分析：PRIVATE_THOUGHT\n回复草案：[[ACTION:PRIVATE_ACTION]]';
const history = [{ role: 'system', content: '角色设定' }, { role: 'user', content: '你好' }];
const publicReplies = [
    '晚上好，我们去散步吧。',
    '[happy] 晚上好。\n[[SEND_EMOJI: 招手]]',
    '[[OBSERVE]]\n心情：开心\n[[/OBSERVE]]\n[happy] 晚上好。',
    '{"dialogue":"晚上好。","expression":"happy"}',
];

function sse(events: unknown[], done: boolean): Response {
    const wire = events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('')
        + (done ? 'data: [DONE]\n\n' : '');
    const bytes = new TextEncoder().encode(wire);
    return new Response(new ReadableStream({ start(controller) {
        // Split UTF-8 characters and protocol tags across network chunks.
        for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
        controller.close();
    } }), { headers: { 'content-type': 'text/event-stream' } });
}

function fixture(mode: Mode, stream: boolean, output: (nonce: string) => string) {
    return vi.fn(async (_resource: any, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body));
        const system = mode === 'gemini-native'
            ? request.systemInstruction.parts[0].text : request.messages[0].content;
        const nonce = system.match(/<reply-([\da-f-]+)>/)[1];
        const content = output(nonce);
        if (mode === 'gemini-native') {
            const thought = { thought: true, text: privateText, functionCall: { name: 'private_action', args: {} } };
            const event = (parts: unknown[], finishReason?: string) => ({
                candidates: [{ content: { role: 'model', parts }, finishReason }],
                usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 5, totalTokenCount: 17 },
            });
            return stream
                ? sse([event([thought]), ...Array.from(content).map(text => event([{ text }])), event([], 'STOP')], false)
                : Response.json(event([thought, { text: content }], 'STOP'));
        }
        const thought = { type: 'thinking', thinking: privateText };
        const hiddenTool = { id: 'private_call', type: 'function', thought: true,
            function: { name: 'private_action', arguments: '{}' } };
        const usage = { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 };
        return stream
            ? sse([
                { choices: [{ delta: { content: [thought], reasoning_content: privateText, tool_calls: [hiddenTool] } }] },
                ...Array.from(content).map(text => ({ choices: [{ delta: { content: text } }] })),
                { choices: [{ delta: {}, finish_reason: 'stop' }], usage },
            ], true)
            : Response.json({ choices: [{ message: {
                role: 'assistant', content: [thought, { type: 'text', thought: true, text: privateText },
                    { type: 'output_text', text: content }],
                reasoning_content: privateText, reasoning: privateText, tool_calls: [hiddenTool],
            }, finish_reason: 'stop' }], usage });
    });
}

function call(mode: Mode, stream: boolean, transport: ReturnType<typeof fixture>, preview = vi.fn()) {
    vi.stubGlobal('fetch', transport);
    const body = { model: 'fixture-model', messages: history, stream };
    return mode === 'cloud'
        ? characterTransport(transport, false)('https://fixture.test/v1/chat/completions', {
            method: 'POST', body: JSON.stringify(body),
        }).then(response => response.json())
        : completeCharacterChat({ baseUrl: 'https://fixture.test/v1', apiKey: 'fixture-key', model: body.model,
            apiFormat: mode === 'gemini-native' ? mode : 'openai-compatible', geminiNonStream: !stream },
            body, { streamHooks: { onDelta: preview, onReasoningDelta: preview } });
}

afterEach(() => vi.unstubAllGlobals());

describe.each(['openai', 'gemini-native', 'cloud'] as const)('%s character reply compatibility', mode => {
    it.each([false, true])('accepts normal public text, VN, OBSERVE and JSON without custom tags (stream=%s)', async stream => {
        for (const expected of publicReplies) {
            const transport = fixture(mode, stream, () => '<think>INLINE_PRIVATE_THOUGHT</think>' + expected);
            const preview = vi.fn();
            const result = await call(mode, stream, transport, preview);
            expect(result.choices[0].message.content).toBe(expected);
            expect(result.choices[0].message.tool_calls).toBeUndefined();
            expect(result.choices[0].finish_reason).toBe('stop');
            expect(result.usage).toEqual({ prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 });
            expect(JSON.stringify(result)).not.toContain('PRIVATE_');
            expect(JSON.stringify(preview.mock.calls)).not.toContain('PRIVATE_');
            if (mode !== 'cloud' && stream) {
                expect(preview).toHaveBeenCalledTimes(1);
                expect(preview).toHaveBeenCalledWith(expected, expected);
            }
            if (mode === 'cloud') expect(result.lemuriaReplyVerified).toBe(true);
            expect(transport).toHaveBeenCalledTimes(1);
        }
        expect(history[0].content).toBe('角色设定');
    });

    it.each([false, true])('uses only the current complete frame and discards its preamble and suffix (stream=%s)', async stream => {
        for (const expected of publicReplies) {
            const transport = fixture(mode, stream, nonce => privateText
                + '<reply-' + nonce + '>' + expected + '</reply-' + nonce + '>' + privateText);
            const preview = vi.fn();
            const result = await call(mode, stream, transport, preview);
            expect(result.choices[0].message.content).toBe(expected);
            expect(JSON.stringify(result)).not.toContain('PRIVATE_');
            expect(JSON.stringify(preview.mock.calls)).not.toContain('PRIVATE_');
            expect(transport).toHaveBeenCalledTimes(1);
        }
    });

    it.each([false, true])('rejects scratchpads, missing public text and malformed frames without fallback or retry (stream=%s)', async stream => {
        const rejected = [
            () => privateText,
            () => '',
            () => '<think>PRIVATE_ONLY_THOUGHT</think>',
            (nonce: string) => 'PREAMBLE_PRIVATE<reply-' + nonce + '>你好',
            () => 'PREAMBLE_PRIVATE<reply-',
            () => 'PREAMBLE_PRIVATE<reply',
            () => 'PREAMBLE_PRIVATE<reply-wrong>你好</reply-wrong>',
            (nonce: string) => '<reply-' + nonce + '>你好</reply-' + nonce + '><reply-wrong>PRIVATE_TAIL</reply-wrong>',
            (nonce: string) => '<reply-' + nonce + '>你好</reply-' + nonce + '><reply',
            (nonce: string) => ('<reply-' + nonce + '>你好</reply-' + nonce + '>').repeat(2),
        ];
        for (const output of rejected) {
            const transport = fixture(mode, stream, output);
            const preview = vi.fn();
            await expect(call(mode, stream, transport, preview)).rejects.toMatchObject({ code: 'LLM_REPLY_BOUNDARY' });
            expect(preview).not.toHaveBeenCalled();
            expect(transport).toHaveBeenCalledTimes(1);
        }
    });
});
