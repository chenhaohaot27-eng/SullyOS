import { afterEach, describe, it, expect } from 'vitest';
import { isGlobalStreamEnabled, upgradeChatBodyToStream, assembleUpgradedResponse } from './streamUpgrade';

// 透明流式升级：请求体改写 + SSE 响应拼回 JSON。
// 关键不变量：调用方拿到的最终 JSON 与不升级时结构等价（choices/usage/model）。

describe('upgradeChatBodyToStream', () => {
    afterEach(() => localStorage.removeItem('os_api_config'));

    it('已保存的全局 stream:true 不覆盖本轮显式 stream:false，也不添加 stream_options', () => {
        localStorage.setItem('os_api_config', JSON.stringify({ stream: true }));
        const original = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'Hi' }], stream: false, max_tokens: 5 });
        expect(isGlobalStreamEnabled()).toBe(true);
        const upgraded = isGlobalStreamEnabled() ? upgradeChatBodyToStream(original) : null;
        expect(upgraded).toBeNull();
        const wire = upgraded ?? original;
        expect(wire).toBe(original);
        expect(JSON.parse(wire)).toMatchObject({ stream: false, max_tokens: 5 });
        expect(JSON.parse(wire)).not.toHaveProperty('stream_options');
    });

    it('缺省 stream 的旧调用仍按全局开关升级，其余请求字段保留', () => {
        localStorage.setItem('os_api_config', JSON.stringify({ stream: true }));
        const original = { model: 'm', messages: [{ role: 'user', content: 'Hi' }], max_tokens: 8000 };
        const out = isGlobalStreamEnabled() ? upgradeChatBodyToStream(JSON.stringify(original)) : null;
        expect(JSON.parse(out!)).toEqual({ ...original, stream: true, stream_options: { include_usage: true } });
    });

    it('已是 stream:true（聊天主路径等自行开流的调用）→ 不碰，返回 null', () => {
        expect(upgradeChatBodyToStream(JSON.stringify({ model: 'm', stream: true, stream_options: { include_usage: false } }))).toBeNull();
    });

    it('非 JSON / 非对象 body → 返回 null 原样放行', () => {
        expect(upgradeChatBodyToStream('not-json')).toBeNull();
        expect(upgradeChatBodyToStream('[1,2]')).toBeNull();
    });
});

describe('assembleUpgradedResponse', () => {
    it('SSE 响应 → 拼回标准 chat.completion JSON', async () => {
        const sse = [
            'data: {"id":"c1","model":"real-backend","choices":[{"delta":{"role":"assistant","content":"你好"}}]}',
            'data: {"choices":[{"delta":{"content":"呀"}}]}',
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}',
            'data: [DONE]',
            '',
        ].join('\n');
        const upstream = new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        const out = await assembleUpgradedResponse(upstream);
        expect(out.headers.get('content-type')).toContain('application/json');
        const data = await out.json();
        expect(data.choices[0].message.content).toBe('你好呀');
        expect(data.model).toBe('real-backend');
        expect(data.usage.total_tokens).toBe(12);
    });

    it('OpenRouter 心跳先于 data 时仍拼回标准 JSON', async () => {
        const sse = [
            ': OPENROUTER PROCESSING',
            '',
            'data: {"id":"c2","choices":[{"delta":{"content":"心跳后"}}]}',
            'data: {"choices":[{"delta":{"content":"正常"}}]}',
            'data: [DONE]',
            '',
        ].join('\n');
        const upstream = new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        const out = await assembleUpgradedResponse(upstream);
        const data = await out.json();
        expect(data.choices[0].message.content).toBe('心跳后正常');
    });

    it('代理无视 stream 返回整包 JSON → 原文透传（重新包装）', async () => {
        const json = JSON.stringify({ choices: [{ message: { content: '整包' } }] });
        const upstream = new Response(json, { status: 200, headers: { 'Content-Type': 'application/json' } });
        const out = await assembleUpgradedResponse(upstream);
        expect((await out.json()).choices[0].message.content).toBe('整包');
    });
});

it.each(['text/plain', 'application/json'])('isolates reasoning even when a relay labels SSE or JSON as %s', async mime => {
    for (const wire of [
        JSON.stringify({choices: [{message: {content: '正式台词', reasoning: 'private-draft'}}]}),
        'data: {"choices":[{"delta":{"reasoning_content":"private-draft","content":"正式台词"}}]}\n\ndata: [DONE]\n\n',
    ]) {
        const normalized = await assembleUpgradedResponse(new Response(wire, {headers: {'Content-Type': mime}}));
        const json = await normalized.json();
        expect(json.choices[0].message.content).toBe('正式台词');
        expect(JSON.stringify(json)).not.toContain('private-draft');
    }
});
