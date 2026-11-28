import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertCompletionDelivered } from './completionOutcome';
import { readOpenAiResponse, SSE_FINISH_GRACE_MS } from './openAiStream';

const encode = (text: string) => new TextEncoder().encode(text);
const event = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('shared OpenAI response reader', () => {
    it('drains late usage after finish with a fixed deadline that heartbeats cannot extend', async () => {
        vi.useFakeTimers();
        let source!: ReadableStreamDefaultController<Uint8Array>;
        const cancel = vi.fn(() => new Promise<void>(() => {}));
        const response = new Response(new ReadableStream<Uint8Array>({
            start(controller) {
                source = controller;
                controller.enqueue(encode(event({ choices: [{ delta: { content: '完整🙂' }, finish_reason: 'stop' }] })));
            },
            cancel,
        }), { headers: { 'content-type': 'text/event-stream' } });
        let settled = false;
        const read = readOpenAiResponse(response).then(result => { settled = true; return result; });
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(SSE_FINISH_GRACE_MS - 100);
        expect(settled).toBe(false);
        source.enqueue(encode(': keepalive\n\n'));
        source.enqueue(encode(event({ choices: [], usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 } })));
        await vi.advanceTimersByTimeAsync(99);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        const { data, isSse } = await read;
        expect(isSse).toBe(true);
        expect(data.choices[0].message.content).toBe('完整🙂');
        expect(data.choices[0].finish_reason).toBe('stop');
        expect(data.stream_incomplete).toBeUndefined();
        expect(data.usage).toEqual({ prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 });
        expect(cancel).toHaveBeenCalledOnce();
        expect(response.body!.locked).toBe(false);
    });

    it('finishes immediately at DONE and handles an upstream cancellation rejection', async () => {
        const cancel = vi.fn(async () => { throw new Error('upstream cleanup failed'); });
        const response = new Response(new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encode(event({ choices: [{ delta: { content: '完整' }, finish_reason: 'stop' }] })
                    + event({ choices: [], usage: { total_tokens: 7 } }) + 'data: [DONE]\n\n'));
            },
            cancel,
        }), { headers: { 'content-type': 'text/event-stream' } });
        const { data } = await readOpenAiResponse(response);
        expect(data.usage.total_tokens).toBe(7);
        expect(cancel).toHaveBeenCalledOnce();
        expect(response.body!.locked).toBe(false);
        // Let a rejected cancel propagate if the reader forgot to attach its catch.
        await new Promise(resolve => setTimeout(resolve, 0));
    });

    it('keeps a finished reply when only half a trailing usage event arrives before the drain deadline', async () => {
        vi.useFakeTimers();
        let source!: ReadableStreamDefaultController<Uint8Array>;
        const response = new Response(new ReadableStream<Uint8Array>({
            start(controller) {
                source = controller;
                controller.enqueue(encode(event({ choices: [{ delta: { content: '完整🙂' }, finish_reason: 'stop' }] })));
            },
        }), { headers: { 'content-type': 'text/event-stream' } });
        const read = readOpenAiResponse(response);
        await vi.advanceTimersByTimeAsync(SSE_FINISH_GRACE_MS - 100);
        source.enqueue(encode('data: {"choices":[],"usage":{"total_tokens":'));
        await vi.advanceTimersByTimeAsync(100);
        const { data } = await read;
        expect(data.choices[0].message.content).toBe('完整🙂');
        expect(data.choices[0].finish_reason).toBe('stop');
        expect(data.stream_incomplete).toBeUndefined();
        expect(data.usage).toBeUndefined();
        expect(() => assertCompletionDelivered(data)).not.toThrow();
    });

    it('retains an error finish reason instead of treating a terminal event as success', async () => {
        vi.useFakeTimers();
        const response = new Response(new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encode(event({ choices: [{ delta: { content: 'partial' }, finish_reason: 'content_filter' }] })));
            },
        }), { headers: { 'content-type': 'text/event-stream' } });
        const read = readOpenAiResponse(response);
        await vi.advanceTimersByTimeAsync(SSE_FINISH_GRACE_MS);
        const { data } = await read;
        expect(data.choices[0].finish_reason).toBe('content_filter');
        expect(() => assertCompletionDelivered(data)).toThrow(/content_filter/);
    });

    it('keeps EOF without any protocol terminal incomplete', async () => {
        const { data } = await readOpenAiResponse(new Response(event({ choices: [{ delta: { content: 'partial' } }] })));
        expect(data.stream_incomplete).toBe(true);
        expect(() => assertCompletionDelivered(data)).toThrow(/stream_incomplete/);
    });

    it('does not erase an invalid SSE event when a valid finish follows it', async () => {
        const wire = 'data: {broken}\n\n'
            + event({ choices: [{ delta: { content: 'partial' }, finish_reason: 'stop' }] })
            + event({ choices: [], usage: { total_tokens: 7 } }) + 'data: [DONE]\n\n';
        const { data } = await readOpenAiResponse(new Response(wire));
        expect(data.stream_incomplete).toBe(true);
        expect(data.usage.total_tokens).toBe(7);
    });

    it.each(['application/json', 'text/event-stream', 'text/plain'])('preserves complete JSON and split UTF-8 when content-type is %s', async contentType => {
        const original = { id: 'fixture', model: 'fixture-model', choices: [{ message: { role: 'assistant', content: '末尾中文🙂' }, finish_reason: 'stop' }], usage: { total_tokens: 9 } };
        const response = new Response(new ReadableStream<Uint8Array>({
            start(controller) {
                for (const byte of encode(JSON.stringify(original))) controller.enqueue(Uint8Array.of(byte));
                controller.close();
            },
        }), { headers: { 'content-type': contentType } });
        const { data, isSse } = await readOpenAiResponse(response);
        expect(isSse).toBe(false);
        expect(data).toEqual(original);
    });

    it.each(['application/json', 'text/event-stream', 'text/plain'])('recognizes SSE and an EOF tail across byte chunks when content-type is %s', async contentType => {
        const wire = ': heartbeat\r\n\r\n' + event({ choices: [{ delta: { content: '尾声🙂' }, finish_reason: 'stop' }] }).trimEnd();
        const response = new Response(new ReadableStream<Uint8Array>({
            start(controller) {
                for (const byte of encode(wire)) controller.enqueue(Uint8Array.of(byte));
                controller.close();
            },
        }), { headers: { 'content-type': contentType } });
        const { data, isSse } = await readOpenAiResponse(response);
        expect(isSse).toBe(true);
        expect(data.choices[0].message.content).toBe('尾声🙂');
        expect(data.stream_incomplete).toBeUndefined();
    });
});
