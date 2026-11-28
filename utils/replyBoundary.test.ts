import { afterEach, describe, expect, it, vi } from 'vitest';
import { completeCharacterChat } from './chatCompletionClient';
import { finalizeReply, frameReplyMessages, readReply, ReplyBoundaryError } from './replyBoundary';
import { characterTransport } from './characterTransport';

const draft = '表情包库存：[[SEND_EMOJI: 库存样例]]\n回复草案：[[ACTION:POKE]]';
const story = '她心想：“回复草案都写好了，却还是想见他。”\n[[SEND_EMOJI: 招手]]';
const history = [{ role: 'system', content: '原有人设' }, { role: 'user', content: '晚上好' }];

function bytes(events: unknown[], done: boolean) {
    const wire = events.map(e => 'data: ' + JSON.stringify(e) + '\n\n').join('') + (done ? 'data: [DONE]\n\n' : '');
    const bytes = new TextEncoder().encode(wire);
    return new Response(new ReadableStream({ start(c) {
        for (let i = 0; i < bytes.length; i += 3) c.enqueue(bytes.slice(i, i + 3));
        c.close();
    } }), { headers: { 'content-type': 'text/event-stream' } });
}

function relay(native: boolean, streaming: boolean, valid: boolean) {
    return vi.fn(async (_url: any, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body));
        const system = native ? request.systemInstruction.parts[0].text : request.messages[0].content;
        const id = system.match(/<reply-([\da-f-]+)>/)[1];
        const content = valid ? draft + '<reply-' + id + '>' + story + '</reply-' + id + '>' : draft;
        if (native) {
            const thought = { thought: true, text: draft, functionCall: { name: 'poke', args: {} } };
            const event = (parts: unknown[], end?: string) => ({ candidates: [{ content: { parts }, finishReason: end }] });
            return streaming ? bytes([event([thought]), ...Array.from(content).map(text => event([{ text }])), event([], 'STOP')], false)
                : Response.json(event([thought, { text: content }], 'STOP'));
        }
        const usage = { prompt_tokens: 110466, completion_tokens: 902 };
        const thought = { type: 'text', thought: true, text: draft };
        return streaming ? bytes([
            { choices: [{ delta: { reasoning_content: draft, content: [thought] } }] },
            ...Array.from(content, c => ({ choices: [{ delta: { content: c } }] })),
            { choices: [{ delta: {}, finish_reason: 'stop' }], usage },
        ], true) : Response.json({ choices: [{ message: {
            content: [thought, { type: 'text', text: content }], reasoning: draft,
        }, finish_reason: 'stop' }], usage });
    });
}

afterEach(() => vi.unstubAllGlobals());

describe.each(['openai', 'gemini-native', 'cloud'] as const)('%s role response', mode => {
    it.each([true, false])('releases only complete verified dialogue and actions (stream=%s)', async stream => {
        for (const valid of [true, false]) {
            const transport = relay(mode === 'gemini-native', stream, valid);
            vi.stubGlobal('fetch', transport);
            const preview = vi.fn();
            const body = { messages: history, stream, model: 'gemini-3.8-flash' };
            const run = mode === 'cloud'
                ? characterTransport(transport, false)('https://fixture.test/v1/chat/completions',
                    { method: 'POST', body: JSON.stringify(body) }).then(res => res.json())
                : completeCharacterChat({ baseUrl: 'https://fixture.test/v1', apiKey: 'fixture', model: body.model,
                    apiFormat: mode === 'gemini-native' ? mode : 'openai-compatible', geminiNonStream: !stream },
                    body, { streamHooks: { onDelta: preview } });
            if (valid) {
                const result = await run;
                expect(result.choices[0].message.content).toBe(story);
                expect(JSON.stringify(result)).not.toContain('库存样例');
                expect(result.choices[0].message.tool_calls).toBeUndefined();
                if (mode !== 'gemini-native') expect(result.usage.completion_tokens).toBe(902);
            } else {
                await expect(run).rejects.toThrow('重新生成');
                expect(preview).not.toHaveBeenCalled();
            }
            expect(transport).toHaveBeenCalledTimes(1);
            expect(JSON.stringify(preview.mock.calls)).not.toContain('库存样例');
            expect(history[0].content).toBe('原有人设');
        }
    });
});

it('refuses ambiguous or repeated frames before actions, preserves narrative prose verbatim', () => {
    const nonce = 'abc';
    const frame = (s: string) => '<reply-abc>' + s + '</reply-abc>';
    for (const text of [draft, '</think>' + frame(story), frame(story) + frame(draft),
        '<think>' + frame(story), '<think><thought>x</think></thought>' + frame(story),
        frame('内部分析\n[[ACTION:POKE]]\n回复草案\n好。'), frame(draft), '<reply-wrong>' + draft + '</reply-wrong>']) {
        expect(() => readReply(text, nonce)).toThrow(ReplyBoundaryError);
    }
    expect(readReply('<think a="1">a<thought>b</thought>c</think>' + frame(story), nonce)).toBe(story);
    expect(frameReplyMessages(history, nonce)[1]).toBe(history[1]);
});

it('accepts unframed public narrative and preserves frames until the request-aware pass', () => {
    const framed = '<reply-abc>' + story + '</reply-abc>';
    expect(readReply(story, 'abc')).toBe(story);
    expect(readReply('<think>private</think>' + story, 'abc')).toBe(story);
    expect(readReply(framed)).toBe(framed);
    expect(() => readReply(readReply(framed), 'different-request')).toThrow(ReplyBoundaryError);
});

it('permits a typed tool-only response but blocks the same tool if unverified text accompanies it', async () => {
    for (const content of [null, draft]) {
        vi.stubGlobal('fetch', vi.fn(async () => Response.json({ choices: [{ message: { content, reasoning: draft,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] })));
        const call = completeCharacterChat({ baseUrl: 'https://fixture.test', apiKey: 'fixture', model: 'sample' }, { messages: history });
        if (content) await expect(call).rejects.toThrow('重新生成');
        else expect((await call).choices[0].message.tool_calls[0].function.name).toBe('lookup');
    }
});

it('withholds tool calls marked private on a message or a single call', () => {
    const call = { type: 'function', function: { name: 'poke', arguments: '{}' } };
    const frame = '<reply-abc>她心想，也许明天会更好。</reply-abc>';
    expect(() => finalizeReply({ choices: [{ message: { type: 'thinking', tool_calls: [call] } }] }, 'abc')).toThrow(ReplyBoundaryError);
    expect(finalizeReply({ choices: [{ message: { content: frame, tool_calls: [{ ...call, thought: true }] } }] }, 'abc').choices[0].message.tool_calls).toBeUndefined();
});
