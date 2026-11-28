import { beforeEach, describe, expect, it } from 'vitest';
import { DB } from './db';

describe('API call log atomic persistence', () => {
    beforeEach(async () => {
        await DB.clearApiCallLog();
    });

    it('does not lose concurrent appends', async () => {
        const entries = Array.from({ length: 30 }, (_, index) => ({
            id: `concurrent-${index}`,
            timestamp: Date.now() + index,
            model: 'test-model',
            ok: true,
        }));

        await Promise.all(entries.map(entry => DB.appendApiCallLog(entry)));
        const stored = await DB.getApiCallLog();

        expect(stored.filter(entry => entry.id.startsWith('concurrent-'))).toHaveLength(entries.length);
    });

    it('merges duplicate request IDs instead of counting one HTTP request twice', async () => {
        const id = 'same-http-request';
        await DB.appendApiCallLog({ id, timestamp: Date.now(), model: 'm', ok: true });
        await DB.appendApiCallLog({
            id,
            timestamp: Date.now(),
            model: 'm',
            backendModel: 'm-backend',
            totalTokens: 123,
            ok: true,
        });

        const stored = (await DB.getApiCallLog()).filter(entry => entry.id === id);
        expect(stored).toHaveLength(1);
        expect(stored[0]).toMatchObject({ backendModel: 'm-backend', totalTokens: 123 });
    });

    it('keeps a reply rejection when a delayed HTTP success and usage arrive', async () => {
        const id = 'reply-rejected-before-usage';
        await DB.appendApiCallLog({
            id, timestamp: Date.now(), model: 'm', replyValidation: 'failed', errorDetail: 'LLM_REPLY_BOUNDARY',
        });
        await DB.appendApiCallLog({
            id, timestamp: Date.now(), model: 'm', ok: true, status: 200, promptTokens: 123,
            replyValidation: undefined,
        });
        const rows = (await DB.getApiCallLog()).filter(entry => entry.id === id);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ ok: true, status: 200, promptTokens: 123, replyValidation: 'failed' });
    });
});

describe('one-shot API request capture persistence', () => {
    beforeEach(async () => {
        await DB.clearApiRequestCapture();
    });

    it('keeps only the newest full request capture', async () => {
        await DB.saveApiRequestCapture({ id: 'first', payload: { messages: ['old'] } });
        await DB.saveApiRequestCapture({ id: 'second', payload: { messages: ['new'] } });

        expect(await DB.getApiRequestCapture()).toEqual({ id: 'second', payload: { messages: ['new'] } });
    });

    it('clears the full capture without clearing normal call logs', async () => {
        const logId = `kept-${Date.now()}`;
        await DB.appendApiCallLog({ id: logId, timestamp: Date.now(), model: 'm', ok: true });
        await DB.saveApiRequestCapture({ id: 'capture' });
        await DB.clearApiRequestCapture();

        expect(await DB.getApiRequestCapture()).toBeNull();
        expect((await DB.getApiCallLog()).some(entry => entry.id === logId)).toBe(true);
    });

    it('patches usage only when the response belongs to the current capture', async () => {
        await DB.saveApiRequestCapture({ id: 'current', usageStatus: 'pending' });

        expect(await DB.patchApiRequestCapture('stale', { promptTokens: 999 })).toBe(false);
        expect(await DB.patchApiRequestCapture('current', { promptTokens: 321, usageStatus: 'reported' })).toBe(true);
        expect(await DB.getApiRequestCapture()).toMatchObject({
            id: 'current',
            promptTokens: 321,
            usageStatus: 'reported',
        });
    });
});
