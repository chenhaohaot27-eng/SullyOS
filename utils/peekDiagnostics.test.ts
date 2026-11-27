import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CharacterProfile, Message, UserProfile } from '../types';
import { DatePrompts } from './datePrompts';
import { completeCharacterChat } from './chatCompletionClient';
import { buildApiRequestCapture, captureApiRequestOnce, formatApiRequestCaptureTxt, setApiRequestCaptureArmed } from './apiCallLog';
import { bindPeek, capturePeek, formatPeekReport, PeekTrace } from './peekDiagnostics';
import { frameReplyMessages } from './replyBoundary';
import { DB } from './db';

const nonce = '12345678-1234-4234-8234-123456789abc';
const moment = 1795731599000;
const key = 'synthetic-secret-token';
const shared = 'fixture PRIVATE-"𠮷"\n'.repeat(12);
const sha = (s: string) => createHash('sha256').update(s, 'utf16le').digest('hex');

function input() {
    const books = [0, 1, 2, 3, 4, 5, 6].map(position => ({
        id: 'wb-' + position, sourceUid: position, title: position === 1 ? key : '条目' + position, content: shared,
        position, key: position === 1 ? ['fixture'] : [], useProbability: position === 1, probability: 70,
    }));
    const char = { id: 'c', name: 'fixture', systemPrompt: 'PRIVATE-CARD', worldview: 'PRIVATE-SETTING',
        dateTimeAwarenessEnabled: false, memoryPalaceEnabled: true, roomPlatesInjection: 'PRIVATE-MEMORY',
        refinedMemories: { '2026-11': shared }, mountedWorldbooks: books,
        dateStyleConfig: { extra: ' PRIVATE-STYLE ' }, dateObserve: { enabled: true } } as unknown as CharacterProfile;
    const allMsgs = [
        { id: 10, type: 'text', role: 'user', content: shared, metadata: { source: 'chat' } },
        { id: 11, type: 'chat_forward', role: 'user', content: JSON.stringify({ fromCharName: 'PRIVATE-FORWARD',
            messages: [{ id: 123, type: 'text', content: shared }, { type: 'text', content: 'PRIVATE-CHILD' }] }) },
        { id: 12, type: 'image', role: 'user', content: '', metadata: { source: 'date' } },
    ].map(m => ({ ...m, timestamp: moment, charId: 'c' })) as Message[];
    return { char, allMsgs, userProfile: { name: 'user', bio: 'PRIVATE-BIO' } as UserProfile, emojis: [],
        sceneHint: { sceneSeed: 'PRIVATE-SEED', contextSummary: 'PRIVATE-SUMMARY', participantsText: 'PRIVATE-INVITED' } };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); setApiRequestCaptureArmed(false); });

describe('device-local peek diagnostics', () => {
    it('retains only the selected history IDs and measures a large synthetic message and style independently', async () => {
        const args = input();
        const big = '文本\n🌿'.repeat(30000);
        args.char.dateStyleConfig = { extra: big };
        args.char.contextLimit = 2;
        args.allMsgs = [1, 2, 3].map(id => ({ id, role: 'user', charId: 'c', type: 'text', timestamp: moment,
            content: id === 3 ? big : 'example' })) as Message[];
        const trace = new PeekTrace();
        const {messages} = DatePrompts.buildPeekPayload({ ...args, trace });
        const report = await trace.report(String(messages[0].content), String(messages[1].content), JSON.stringify({ messages }).length);
        expect(report.matched).toEqual({ user: true, system: true });
        const history = report.leaves.filter(l => l.fields?.messageId != null);
        expect(history.map(l => l.fields?.messageId)).toEqual([2, 3]);
        expect(history[1].rawChars).toBe(big.length);
        expect(report.leaves.find(l => l.kind === '自定义文风正文')?.chars).toBe(big.trim().length);
        expect(JSON.stringify(report)).not.toContain('example');
    });

    it.each([true, false])('reconciles exact leaves and optional scene branches (invited=%s)', async invited => {
        const args = input();
        vi.spyOn(Date, 'now').mockReturnValue(moment);
        const rng = vi.spyOn(Math, 'random').mockReturnValue(0.5);
        const options = { ...args, sceneHint: invited ? args.sceneHint : undefined };
        const off = DatePrompts.buildPeekPayload(options);
        const plainDraws = rng.mock.calls.length;
        rng.mockClear();
        const on = DatePrompts.buildPeekPayload({ ...options, trace: new PeekTrace() });
        expect(rng.mock.calls.length).toBe(plainDraws);
        expect(on).toEqual(off);
        const framed = frameReplyMessages(on.messages, nonce);
        const stop = bindPeek(on.messages, nonce, framed, key)!;
        try {
            const messages = framed as { role: string; content: string }[];
            const body = JSON.stringify({ model: 'model', stream: true, messages });
            const report = (await capturePeek(messages, body.length))!;
            expect(report.matched).toEqual({ system: true, user: true });
            for (const side of ['system', 'user'] as const) {
                expect(report.leaves.filter(l => l.side === side).reduce((n, l) => n + l.chars, 0)).toBe(report.totals[side]);
            }
            expect(report.totals.user + report.totals.system + report.quoteChars + report.escapeChars + report.structureChars).toBe(body.length);
            const books = report.leaves.filter(l => l.kind === '世界书条目正文');
            expect(books.map(b => b.fields!.position).sort()).toEqual([0,1,2,3,5,6]);
            expect(books.find(b => b.fields!.position === 1)?.fields).toMatchObject({ title: '已脱敏', probability: 70, activation: '关键词条件命中' });
            expect(books.every(b => b.rawSha256 === sha(shared) && b.sha256 === sha(shared.trim()))).toBe(true);
            expect(report.leaves.find(l => l.fields?.messageId === 10)?.rawSha256).toBe(sha(shared));
            expect(report.leaves.filter(l => l.kind.startsWith('转发子条目')).map(l => l.fields?.childId)).toEqual([123, '未归因']);
            const txt = formatPeekReport(report);
            expect(txt).toContain('前五大叶项');
            expect(txt).toContain(sha(shared) + ': #');
            expect(txt).not.toMatch(/PRIVATE|synthetic-secret-token/);
            expect((await capturePeek([messages[0], {role: 'user', content: 'x'.repeat(report.totals.user)}], body.length))?.matched.user).toBe(false);
        } finally { stop(); }
        expect(capturePeek(framed as any, 0)).toBeUndefined();
    });

    it.each(['https://relay-one.example/v1', 'https://relay-two.example/v1'])('preserves actual fetch arguments and saves only metadata for %s', async baseUrl => {
        vi.spyOn(Date, 'now').mockReturnValue(moment);
        vi.spyOn(crypto, 'randomUUID').mockReturnValue(nonce);
        vi.spyOn(Math, 'random').mockReturnValue(0.2);
        const calls: { url: string; data: string; headers: string }[] = [];
        let saved: string | null = null;
        vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
            const data = String(init.body);
            calls.push({ url, data, headers: JSON.stringify(init.headers) });
            saved = captureApiRequestOnce({url, body: data});
            return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '<reply-' + nonce + '>OK</reply-' + nonce + '>' } }] }),
                { headers: { 'content-type': 'application/json' } });
        }));
        for (const enabled of [false, true]) {
            setApiRequestCaptureArmed(enabled);
            const payload = DatePrompts.buildPeekPayload({ ...input(), trace: enabled ? new PeekTrace() : undefined });
            await completeCharacterChat({ baseUrl, model: 'fixture', apiKey: key }, { ...payload, stream: false }, {maxRetries: 0});
        }
        expect(calls).toHaveLength(2);
        expect(calls[0]).toEqual(calls[1]);
        expect(calls[1].data).not.toMatch(/peekReport|processedByWatermark|sha256/i);
        await vi.waitFor(async () => {
            const captured = await DB.getApiRequestCapture();
            expect(captured?.id).toBe(saved);
            expect(captured?.peekReport?.matched).toEqual({ user: true, system: true });
            expect(formatApiRequestCaptureTxt(captured!)).not.toMatch(/PRIVATE|synthetic-secret-token/);
        }, {timeout: 5000});
        expect(buildApiRequestCapture({url: baseUrl, body: calls[0].data}).peekReport).toBeUndefined();
    });
});
