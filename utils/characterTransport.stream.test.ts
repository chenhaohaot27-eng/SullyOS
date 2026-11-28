import { describe, expect, it, vi } from 'vitest';
import { characterTransport } from './characterTransport';
import { SSE_FINISH_GRACE_MS } from './openAiStream';

describe('characterTransport streaming', () => {
    it.each(['DONE', 'finish-only'])('returns a verified completion at %s when the provider never closes the body', async terminal => {
        let source!: ReadableStreamDefaultController<Uint8Array>;
        const cancel = vi.fn();
        const transport = vi.fn(async (_resource: RequestInfo | URL, init?: RequestInit) => {
            const request = JSON.parse(init!.body as string);
            const nonce = /<reply-([^>]+)>/.exec(request.messages[0].content)?.[1];
            expect(nonce).toBeTruthy();
            const event = { choices: [{ delta: { content: `<reply-${nonce}>正式回复🙂</reply-${nonce}>`, reasoning_content: 'private-draft' }, finish_reason: 'stop' }] };
            return new Response(new ReadableStream<Uint8Array>({
                start(controller) {
                    source = controller;
                    const wire = `data: ${JSON.stringify(event)}\n\ndata: {"choices":[],"usage":{"total_tokens":12}}\n\n`
                        + (terminal === 'DONE' ? 'data: [DONE]\n\n' : '');
                    controller.enqueue(new TextEncoder().encode(wire));
                },
                cancel,
            }), { headers: { 'content-type': 'text/event-stream' } });
        });
        const request = characterTransport(transport, false)('https://fixture.invalid/v1/chat/completions', {
            method: 'POST', body: JSON.stringify({ model: 'fixture', messages: [{ role: 'system', content: 'Fixture.' }] }),
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const response = await Promise.race([
                request,
                new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), terminal === 'DONE' ? 200 : SSE_FINISH_GRACE_MS + 500); }),
            ]);
            expect(response, 'A protocol-complete reply must not wait for transport EOF').not.toBeNull();
            const data = await response!.json();
            expect(data.choices[0].message.content).toBe('正式回复🙂');
            expect(data.lemuriaReplyVerified).toBe(true);
            expect(data.usage.total_tokens).toBe(12);
            expect(JSON.stringify(data)).not.toContain('private-draft');
            expect(transport).toHaveBeenCalledOnce();
            expect(cancel).toHaveBeenCalledOnce();
        } finally {
            clearTimeout(timer);
            try { source.close(); } catch { /* Already cancelled after a complete protocol frame. */ }
            await request;
        }
    });
});
