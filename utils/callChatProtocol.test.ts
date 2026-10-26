/**
 * 电话 App 协议分发回归：CallApp 的主通话回复 / 视频表演两处辅助请求统一走
 * completeChat 后，gemini-native 与 openai-compatible 都必须按正确协议请求并解析。
 * 这里用 Mock fetch 验证真实请求形状——不调用任何真实付费 API。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { completeChat } from './chatCompletionClient';
import { parseCallAssistantMessage } from './callReplyFormat';
import { isVisionInputUnsupportedError } from './userCameraSnapshot';

const jsonResponse = (body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
    new Response(JSON.stringify(body), { status: 200, headers });

const GEMINI_CALL_REPLY = {
    candidates: [{ content: { role: 'model', parts: [{ text: '喂？我在呢，刚下班。' }] }, finishReason: 'STOP' }],
    modelVersion: 'gemini-3.8-flash',
};

const CALL_MESSAGES = [
    { role: 'system', content: '你是电话中的角色，口语化、简短。' },
    { role: 'user', content: '[2026/10/26 19:00:00] [通话] 喂，在吗？' },
];

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('电话主回复 · gemini-native', () => {
    it('请求打到 :streamGenerateContent（不再指向 /chat/completions），返回可被 parseCallAssistantMessage 解析', async () => {
        const fetchImpl = vi.fn(async (..._args: Parameters<typeof fetch>): Promise<Response> => jsonResponse(GEMINI_CALL_REPLY));
        const result = await completeChat(
            { baseUrl: 'https://api.relayrouter.app', apiKey: 'k', model: 'gemini-3.8-flash', apiFormat: 'gemini-native' },
            { model: 'gemini-3.8-flash', messages: CALL_MESSAGES, temperature: 0.85, max_tokens: 8000, stream: false },
            { fetchImpl: fetchImpl as typeof fetch, maxRetries: 2, meta: { appName: '电话', purpose: '语音通话' } },
        );
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const [url] = fetchImpl.mock.calls[0];
        expect(String(url)).toBe('https://api.relayrouter.app/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse');
        expect(String(url)).not.toContain('/chat/completions');

        const parsed = parseCallAssistantMessage(result.choices?.[0]?.message, false);
        expect(parsed.text).toBe('喂？我在呢，刚下班。');
    });

    it('摄像头快照（data URL image_url）转换为 inlineData，末尾仍是 user 回合', async () => {
        const fetchImpl = vi.fn(async (..._args: Parameters<typeof fetch>): Promise<Response> => jsonResponse(GEMINI_CALL_REPLY));
        await completeChat(
            { baseUrl: 'https://api.relayrouter.app', apiKey: 'k', model: 'gemini-3.8-flash', apiFormat: 'gemini-native' },
            {
                model: 'gemini-3.8-flash',
                stream: false,
                messages: [
                    { role: 'system', content: '通话 prompt' },
                    ...[], // （历史为空的最低情形）
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: '[通话] 看看我现在什么样' },
                            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } },
                        ],
                    },
                ],
            },
            { fetchImpl: fetchImpl as typeof fetch, maxRetries: 0, meta: { appName: '电话', purpose: '视频通话·用户快照' } },
        );
        const sent = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
        const last = sent.contents.at(-1);
        expect(last.role).toBe('user');
        expect(last.parts).toEqual([
            { text: '[通话] 看看我现在什么样' },
            { inlineData: { mimeType: 'image/jpeg', data: 'QUJD' } },
        ]);
        expect(sent.systemInstruction).toEqual({ parts: [{ text: '通话 prompt' }] });
    });

    it('Gemini 形态的"不支持图片"报错能被识别，触发快照降级为纯文字', () => {
        expect(isVisionInputUnsupportedError(
            new Error('Gemini Native API 400: Unsupported part type: inline_data is not supported for image input'),
        )).toBe(true);
        expect(isVisionInputUnsupportedError(new Error('NetworkError'))).toBe(false);
    });
});

describe('电话主回复 · openai-compatible 保持原有行为', () => {
    it('请求仍是 /chat/completions，system 前置、消息原样', async () => {
        const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>): Promise<Response> => jsonResponse({
            choices: [{ message: { role: 'assistant', content: '喂？我在呢，刚下班。' } }],
        }));
        vi.stubGlobal('fetch', fetchMock);
        const result = await completeChat(
            { baseUrl: 'https://api.example.com/v1/', apiKey: 'k', model: 'gpt-test' },
            { messages: CALL_MESSAGES, temperature: 0.85, max_tokens: 8000, stream: false },
            { maxRetries: 0 },
        );
        const [url, init] = fetchMock.mock.calls[0];
        expect(String(url)).toBe('https://api.example.com/v1/chat/completions');
        const body = JSON.parse(String(init?.body));
        expect(body.messages[0].role).toBe('system');
        expect(body.messages).toHaveLength(2);
        expect(parseCallAssistantMessage(result.choices[0].message, false).text).toBe('喂？我在呢，刚下班。');
    });

    it('HTTP 200 但返回 HTML 时仍被明确识别并报错（RelayRouter 实测形态）', async () => {
        const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>): Promise<Response> => new Response(
            '<html><body><h1>RelayRouter</h1></body></html>',
            { status: 200, headers: { 'content-type': 'text/html' } },
        ));
        vi.stubGlobal('fetch', fetchMock);
        await expect(completeChat(
            { baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'gpt-test' },
            { messages: CALL_MESSAGES, stream: false },
            { maxRetries: 0 },
        )).rejects.toThrow(/API返回了HTML而非JSON/);
    });
});
