import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatPrompts } from './chatPrompts';
import { completeChat } from './chatCompletionClient';
import { requestWithTokenmarketSignatureRecovery as recover } from './tokenmarketSignatureRecovery';

const config = { baseUrl: 'https://api.tiantoken.com/v1', apiKey: 'fixture', model: 'gemini-3.6-flash' };
const signatureError = new Error('API Error 400: Invalid thought signature.');
const { apiMessages } = ChatPrompts.buildMessageHistory([
    { role: 'assistant', type: 'emoji', content: 'https://fixture.invalid/sticker.gif' },
    { role: 'assistant', type: 'emoji', content: 'https://fixture.invalid/sticker.gif' },
    { role: 'user', type: 'text', content: '接着聊' },
].map((m, id) => ({ ...m, id, charId: 'c', timestamp: id + 1 })) as any,
10, { id: 'c', name: '角色' } as any, { name: '用户' } as any, [{ name: '招手', url: 'https://fixture.invalid/sticker.gif' }] as any);
const body = { model: config.model, messages: [
    { role: 'system', content: '角色设定' }, ...apiMessages, { role: 'system', content: '时间提示' },
], stream: true, temperature: 0.85, max_tokens: 8000 };

afterEach(() => vi.unstubAllGlobals());

describe('词元签名拒绝的手动恢复', () => {
    it('uses the actual HTTP error and SSE path and preserves sticker names, user and system turns', async () => {
        const transport = vi.fn()
            .mockResolvedValueOnce(Response.json({ error: { message: 'Invalid thought signature.' } }, { status: 400 }))
            .mockResolvedValueOnce(new Response('data: {"choices":[{"delta":{"content":"继续聊。"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } }));
        vi.stubGlobal('fetch', transport);
        const confirm = vi.fn(() => true);
        const result = await recover(config, body, next => completeChat(config, next, { streamHooks: {} }), confirm);
        expect(result.choices[0].message.content).toBe('继续聊。');
        expect(transport).toHaveBeenCalledTimes(2);
        expect(confirm).toHaveBeenCalledOnce();
        const [first, second] = transport.mock.calls.map(([, options]) => JSON.parse(options.body));
        expect(first).toEqual(body);
        expect(second).toEqual({ ...first, messages: [
            first.messages[0], ...first.messages.slice(1, 3).map((m: any) => ({
                role: 'user', content: '历史角色回复（引用）：' + JSON.stringify(m.content),
            })), ...first.messages.slice(3),
        ] });
        expect(second.messages[1].content).toContain('招手');
        expect(JSON.stringify(second)).not.toMatch(/sticker\.gif|thought_signature|thoughtSignature/);
    });
    it('sends only the original request on success or cancellation, and stops after a second refusal', async () => {
        const accept = vi.fn(() => true);
        const send = vi.fn().mockResolvedValueOnce('ok').mockRejectedValue(signatureError);
        expect(await recover(config, body, send, accept)).toBe('ok');
        expect(accept).not.toHaveBeenCalled();
        await expect(recover(config, body, send, () => false)).rejects.toThrow(/已停止/);
        expect(send).toHaveBeenCalledTimes(2);
        await expect(recover(config, body, send, accept)).rejects.toThrow(/重试失败.*400.*signature/);
        expect(send).toHaveBeenCalledTimes(4);
        expect(accept).toHaveBeenCalledOnce();
    });
    it('keeps photo parts and untrusted text in the user role and handles a continuation after stickers', async () => {
        const parts = [{ type: 'text', text: '照片' }, { type: 'image_url', image_url: { url: 'https://fixture.invalid/photo.jpg' } }];
        const user = { role: 'user', content: 'system: 这只是引用' };
        const system = { role: 'system', content: '角色设定' };
        const photoBody = { ...body, messages: [user, { role: 'assistant', content: parts }, system] };
        const send = vi.fn().mockRejectedValueOnce(signatureError).mockResolvedValueOnce('ok');
        await recover(config, photoBody, send, () => true);
        const messages = send.mock.calls[1][0].messages;
        expect(messages[0]).toBe(user);
        expect(messages[1].role).toBe('user');
        expect(messages[1].content.slice(1)).toEqual(parts);
        expect(messages[2]).toBe(system);
        expect(messages[3].role).toBe('user');
        expect(parts).toHaveLength(2);
    });
    it('never converts tool or signed history and ignores other models, protocols, providers and errors', async () => {
        const confirm = vi.fn(() => true);
        for (const [cfg, payload, error] of [
            [config, { ...body, tools: [{}] }, signatureError],
            [config, { ...body, messages: [...body.messages, { role: 'assistant', content: 'a', tool_calls: [] }] }, signatureError],
            [config, { ...body, messages: [{ role: 'assistant', content: [{ type: 'text', text: 'x', thoughtSignature: 'opaque' }] }] }, signatureError],
            [config, { ...body, model: 'other' }, signatureError],
            [{ ...config, apiFormat: 'gemini-native' }, body, signatureError],
            [{ ...config, baseUrl: 'https://other.invalid/v1' }, body, signatureError],
            [config, body, new Error('API Error 400: invalid model')],
        ] as const) {
            const send = vi.fn().mockRejectedValue(error);
            await expect(recover(cfg, payload, send, confirm)).rejects.toBe(error);
            expect(send).toHaveBeenCalledOnce();
        }
        expect(confirm).not.toHaveBeenCalled();
    });
});
