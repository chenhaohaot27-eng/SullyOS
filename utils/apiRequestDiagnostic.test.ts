import { describe, expect, it } from 'vitest';
import { API_REQUEST_DIAGNOSTIC_LIMIT, formatApiRequestDiagnostic } from './apiRequestDiagnostic';

const request = (body: unknown, headers?: HeadersInit): RequestInit => ({ method: 'POST', body: JSON.stringify(body), headers });

describe('request metadata diagnostics', () => {
    it('shows the actual small connection probe without claiming thinking is disabled', () => {
        const text = formatApiRequestDiagnostic(request({
            model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'PRIVATE_PROMPT' }], max_tokens: 5, stream: false,
        }));
        expect(text).toContain('model: gemini-3.8-flash');
        expect(text).toContain('max_tokens: 已发送(number=5)');
        expect(text).toContain('max_completion_tokens: 未发送');
        expect(text).toContain('stream: 已发送(boolean=false)');
        expect(text).toContain('messages(1) roles: user×1; tail: user');
        expect(text).toContain('tools(0) names(0): 无');
        expect(text).toContain('thinking: 未发送（服务端默认）');
        expect(text).toContain('reasoning: 未发送（服务端默认）');
        expect(text).not.toMatch(/PRIVATE_PROMPT|thinking: off/);
    });

    it('allowlists OpenAI parameters and nested thinking metadata without dumping extra_body', () => {
        const text = formatApiRequestDiagnostic(request({
            model: 'google/gemini-3.8-flash', max_completion_tokens: 128, stream: true,
            stream_options: { include_usage: true, secret: 'PRIVATE_STREAM_EXTRA' }, temperature: 0.7, top_p: 0.9,
            messages: [{ role: 'system', content: 'PRIVATE_SYSTEM' }, { role: 'user', content: [{ text: 'PRIVATE_MULTIPART' }] }],
            tools: [{ type: 'function', function: { name: 'lookup', description: 'PRIVATE_TOOL_DESCRIPTION', parameters: { secret: 'PRIVATE_SCHEMA' } } }],
            thinking: { type: 'enabled', budget_tokens: 4000, content: 'PRIVATE_THOUGHT' }, reasoning_effort: 'medium',
            extra_body: { apiKey: 'PRIVATE_API_KEY', prompt: 'PRIVATE_EXTRA', thinking: { type: 'enabled', budget_tokens: 3000, secret: 'PRIVATE_THINKING_EXTRA' } },
        }, { Authorization: 'Bearer PRIVATE_HEADER_KEY' }));
        expect(text).toContain('max_completion_tokens: 已发送(number=128)');
        expect(text).toContain('include_usage: 已发送(boolean=true)');
        expect(text).toContain('reasoning_effort: 已发送(string=medium)');
        expect(text).toContain('thinking: 已发送(object; type=已发送(string=enabled), budget_tokens=已发送(number=4000))');
        expect(text).toContain('extra_body.thinking: 已发送(object; type=已发送(string=enabled), budget_tokens=已发送(number=3000))');
        expect(text).toContain('tools(1) names(1): lookup');
        expect(text).not.toContain('PRIVATE_');
    });

    it.each(['streamGenerateContent', 'generateContent'])('summarizes Native %s using the URL model and whitelisted generationConfig fields', action => {
        const text = formatApiRequestDiagnostic(request({
            contents: [{ role: 'user', parts: [{ text: 'PRIVATE_NATIVE_TEXT' }, { inlineData: { data: 'PRIVATE_IMAGE' } }] }],
            systemInstruction: { parts: [{ text: 'PRIVATE_SYSTEM' }] },
            generationConfig: { maxOutputTokens: 5, temperature: 1, topP: 0.8, secret: 'PRIVATE_GENERATION_EXTRA', thinkingConfig: { thinkingBudget: 0, includeThoughts: false, thinkingLevel: 'low', custom: 'PRIVATE_NESTED' } },
            tools: [{ functionDeclarations: [{ name: 'weather', description: 'PRIVATE_DESCRIPTION' }, { name: 'clock' }] }],
        }), `https://relay.invalid/v1beta/models/google%2Fgemini-3.8-flash:${action}?key=PRIVATE_URL_KEY`);
        expect(text).toContain('--- Request (Gemini Native) ---');
        expect(text).toContain('model: google/gemini-3.8-flash');
        expect(text).toContain('generationConfig.maxOutputTokens: 已发送(number=5)');
        expect(text).toContain(`transport: ${action === 'streamGenerateContent' ? 'SSE' : 'JSON'}（由URL指定）`);
        expect(text).toContain('thinkingBudget=已发送(number=0)');
        expect(text).toContain('includeThoughts=已发送(boolean=false)');
        expect(text).toContain('thinkingLevel=已发送(string=low)');
        expect(text).toContain('contents(1) roles: user×1');
        expect(text).toContain('tools(2) names(2): weather, clock');
        expect(text).toContain('systemInstruction parts: 1');
        expect(text).not.toContain('PRIVATE_');
    });

    it('shows invalid parameter types without echoing arbitrary values or role names', () => {
        const text = formatApiRequestDiagnostic(request({
            model: 'PRIVATE MODEL TEXT', stream: 'PRIVATE_STREAM_VALUE', max_tokens: 'PRIVATE_BUDGET',
            messages: [{ role: 'PRIVATE_ROLE', content: 'PRIVATE_CONTENT' }],
            tools: [{ function: { name: 'PRIVATE TOOL NAME' } }],
            thinking: { type: 'PRIVATE_TYPE', budget_tokens: 'PRIVATE_BUDGET' },
            reasoning_effort: 'PRIVATE_REASONING', reasoning: { effort: 'PRIVATE_EFFORT', secret: 'PRIVATE_SECRET' },
        }));
        expect(text).toContain('model: [已隐藏标识]');
        expect(text).toContain('max_tokens: 已发送(string，值未展示)');
        expect(text).toContain('roles: unknown×1');
        expect(text).not.toContain('PRIVATE');
    });

    it('redacts credential-shaped and credential-matching model and tool identifiers', () => {
        const text = formatApiRequestDiagnostic(request({
            model: 'header-credential', tools: [
                { function: { name: 'url-credential' } }, { function: { name: 'sk-secret-token' } }, { function: { name: 'body-credential' } },
            ],
            extra_body: { apiKey: 'body-credential' },
        }, { 'x-api-key': 'header-credential' }), 'https://relay.invalid/v1/chat/completions?token=url-credential');
        expect(text).toContain('[已隐藏标识]');
        expect(text).not.toMatch(/header-credential|url-credential|sk-secret-token|body-credential/);
    });

    it('bounds huge histories and tool lists while retaining numeric message counts', () => {
        const thinking = { type: 'adaptive', mode: 'auto', effort: 'high', thinkingLevel: 'low', thinking_level: 'minimal', budget_tokens: 4000, thinking_budget: 3000, thinkingBudget: 2000, max_tokens: 8000, includeThoughts: true, include_thoughts: false, enabled: true, exclude: false };
        const text = formatApiRequestDiagnostic(request({
            model: 'fixture', messages: Array.from({ length: 1000 }, () => ({ role: 'user', content: 'PRIVATE_BODY'.repeat(100) })),
            tools: Array.from({ length: 100 }, (_, i) => ({ function: { name: 'tool_' + i } })),
            thinking, reasoning: thinking, extra_body: { thinking, reasoning: thinking },
        }));
        expect(text.length).toBeLessThanOrEqual(API_REQUEST_DIAGNOSTIC_LIMIT);
        expect(text).toContain('messages(1000) roles: user×1000');
        expect(text).toContain('tools(100) names(100)');
        expect(text).toContain('摘要已截断');
        expect(text).not.toContain('PRIVATE_BODY');
    });

    it('never consumes a Request body stream or emits non-JSON input', async () => {
        const resource = new Request('https://relay.invalid/v1/chat/completions', { method: 'POST', body: 'PRIVATE_STREAM_BODY' });
        expect(formatApiRequestDiagnostic(undefined, resource)).toContain('未提供可读取');
        expect(resource.bodyUsed).toBe(false);
        expect(await resource.text()).toBe('PRIVATE_STREAM_BODY');
        expect(formatApiRequestDiagnostic({ body: 'PRIVATE_INVALID_JSON' })).not.toContain('PRIVATE_INVALID_JSON');
        expect(formatApiRequestDiagnostic({ body: new URLSearchParams({ prompt: 'PRIVATE_FORM_BODY' }) })).not.toContain('PRIVATE_FORM_BODY');
    });
});
