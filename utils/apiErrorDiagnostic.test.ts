import { describe, expect, it, vi } from 'vitest';
import { readApiErrorDiagnostic } from './apiErrorDiagnostic';
import { recordApiCall } from './apiCallLog';
import { DB } from './db';

const fail = (raw: string, type = 'application/json') =>
    new Response(raw, { status: 400, headers: { 'content-type': type } });

describe('mobile upstream error diagnostics', () => {
    it.each([
        ['{"error":{"code":400,"status":"INVALID_ARGUMENT","message":"Invalid thought signature."}}', '400 · INVALID_ARGUMENT · Invalid thought signature.'],
        ['{"message":"Unknown model","code":"no_model"}', 'no_model · Unknown model'],
        ['{"code":"BAD_INPUT","msg":"参数不支持"}', 'BAD_INPUT · 参数不支持'],
        ['上下文超长', '上下文超长'],
        ['event: error\r\ndata: {"error":{"code":"E400",\r\ndata: "message":"Bad role order"}}\r\n\r\n', 'E400 · Bad role order'],
        ['data: {"choices":[{"delta":{"content":"private reply"}}]}\n\ndata: {"error":{"message":"Model overloaded"}}\n\n', 'Model overloaded'],
        ['event: error\ndata: Gateway unavailable\n\n', 'Gateway unavailable'],
        ['data: {"choices":[{"delta":{"content":"private reply"}}]}\n\n', '未找到可显示的上游错误字段'],
        ['{"error":{"input":"private payload"}}', '未找到可显示的上游错误字段'],
        ['', '服务器返回了空正文'],
    ])('reads %s from exactly one clone', async (raw, expected) => {
        const response = fail(raw);
        const cloning = vi.spyOn(response, 'clone');
        const diagnostic = readApiErrorDiagnostic(response);
        expect(cloning).toHaveBeenCalledTimes(1);
        expect(response.bodyUsed).toBe(false);
        expect(await response.text()).toBe(raw);
        expect(await diagnostic).toBe(expected);
    });

    it('hides failed credentials in messages, provider codes and status fields', async () => {
        const raw = JSON.stringify({ error: { code: 'opaque-key', status: 'query-credential',
            message: 'Credential header-secret rejected, Authorization: Basic opaque-value' } });
        const diagnostic = await readApiErrorDiagnostic(fail(raw), {
            headers: { 'x-api-key': 'opaque-key', Authorization: 'Bearer header-secret' },
        }, 'https://relay.invalid/v1/chat/completions?key=query-credential');
        expect(diagnostic).toContain('Credential');
        expect(diagnostic).not.toMatch(/opaque|header-secret|query-credential|Authorization|Basic/);
    });

    it('keeps echoed prompt text, structured content, and raw JSON out of storage', async () => {
        const message = 'private sample content';
        const body = JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: [{ type: 'text', text: message }] }] });
        const raw = JSON.stringify({ error: { code: 'INVALID_ARGUMENT', message: 'bad input: ' + message }, request: body });
        const diagnostic = await readApiErrorDiagnostic(fail(raw), { body });
        expect(diagnostic).toBe('INVALID_ARGUMENT · 已隐藏敏感内容');
        recordApiCall({ requestId: 'mobile-test', url: 'https://relay.invalid/v1/chat/completions', status: 400,
            ok: false, body, errorDetail: diagnostic });
        await vi.waitFor(async () => {
            const entry = (await DB.getApiCallLog()).find(e => e.id === 'mobile-test');
            expect(entry).toMatchObject({ status: 400, ok: false, model: 'test-model', errorDetail: diagnostic });
            expect(JSON.stringify(entry)).not.toContain(message);
        });
    });

    it('bounds bytes read and text displayed while the caller retains the entire error', async () => {
        const raw = 'Unsupported parameter. '.repeat(10000);
        const response = fail(raw, 'text/plain');
        const diagnostic = await readApiErrorDiagnostic(response);
        expect(diagnostic.length).toBe(400);
        expect(await response.text()).toBe(raw);
    });

    it('falls back if the response cannot be cloned', async () => {
        const response = fail('busy');
        vi.spyOn(response, 'clone').mockImplementation(() => { throw new Error('clone failed'); });
        expect(await readApiErrorDiagnostic(response)).toBe('无法读取上游错误正文');
        expect(await response.text()).toBe('busy');
    });

    it('releases the diagnostic reader if the upstream stops sending', async () => {
        vi.useFakeTimers();
        try {
            let source!: ReadableStreamDefaultController<Uint8Array>;
            const response = new Response(new ReadableStream({ start(controller) { source = controller; } }), { status: 400 });
            const diagnostic = readApiErrorDiagnostic(response);
            await vi.advanceTimersByTimeAsync(3100);
            expect(await diagnostic).toBe('无法读取上游错误正文');
            source.enqueue(new TextEncoder().encode('late data'));
            source.close();
            expect(await response.text()).toBe('late data');
        } finally { vi.useRealTimers(); }
    });
});
