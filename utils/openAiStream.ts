import { isThoughtPart, publicMessageText } from './replyBoundary';

export function parseSseToCompletion(raw: string): any | null {
    const asm = new SseAssembler();
    // 按行切，逐行找 "data: " 开头（允许 \r\n、空行分隔）
    for (const line of raw.split(/\r?\n/)) asm.feedLine(line);
    return asm.finish();
}

/**
 * OpenAI 兼容 SSE 流的增量拼装器。
 * feedLine 逐行喂入（分别返回本行的正文与思考增量），finish 合成完整 completion 对象。
 * parseSseToCompletion（整包路径）和 readBodyWithStreaming（真流式路径）共用这一份，
 * 保证两条路对 delta / message / tool_calls 分片的处理完全一致。
 */
export interface SseFeedDelta {
    content: string;
    reasoning: string;
}

export class SseAssembler {
    content = '';
    private role = 'assistant';
    private finishReason: string | null = null;
    private firstChunk: any = null;
    private usage: any = undefined;
    private gotAnyChunk = false;
    private sawDone = false;
    get receivedDone(): boolean { return this.sawDone; }
    private brokenEvent = false;
    // tool_calls 流式分片: OpenAI 约定按 index 分组, id/name 在首片, arguments 逐片拼接。
    // 不拼的话开了 stream 的工具模式(瑞幸/MCP)会静默丢掉全部工具调用。
    private toolCalls: any[] = [];
    // 思考通道: DeepSeek/Gemini 系走 delta.reasoning_content, OpenRouter 走 delta.reasoning,
    // 部分 Claude 官转(CC 渠道)走 delta.thinking 或分块 content(数组里 type:'thinking')。
    // 仅供独立流式回调使用，绝不补进空正文。
    private reasoning = '';
    /** 喂一行 SSE 文本，分别返回正文与思考增量（没有则为空串）。 */
    feedLine(line: string): SseFeedDelta {
        if (!line.startsWith('data:')) return { content: '', reasoning: '' };
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') this.sawDone = true;
        if (!payload || this.sawDone) return { content: '', reasoning: '' };
        let chunk: any;
        try { chunk = JSON.parse(payload); } catch {
            this.brokenEvent = true;
            return { content: '', reasoning: '' };
        }
        if (chunk?.error) this.brokenEvent = true;
        if (!chunk || typeof chunk !== 'object') return { content: '', reasoning: '' };
        return this.feedChunk(chunk);
    }

    feedChunk(chunk: any): SseFeedDelta {
        this.gotAnyChunk = true;
        if (!this.firstChunk) this.firstChunk = chunk;
        // OpenAI 流式 usage 在最后一个 chunk（include_usage=true 时），也可能出现在中途；
        // 始终取最后一个非空的 usage，兼容各家代理。
        if (chunk.usage) this.usage = chunk.usage;
        const choice = chunk.choices?.[0];
        if (!choice) return { content: '', reasoning: '' };
        let delta = '';
        let reasoningDelta = '';
        // delta 路径（OpenAI 流式常见）
        if (choice.delta) {
            delta = publicMessageText(choice.delta);
            this.content += delta;
            if (Array.isArray(choice.delta.content)) {
                for (const block of choice.delta.content) {
                    if (block?.thought === true || ['thinking', 'thought', 'reasoning'].includes(block?.type)) {
                        const thought = block.thinking ?? block.text;
                        if (typeof thought === 'string') reasoningDelta += thought;
                    }
                }
                this.reasoning += reasoningDelta;
            }
            const dr = choice.delta.reasoning_content ?? choice.delta.reasoning ?? choice.delta.thinking;
            if (typeof dr === 'string') {
                this.reasoning += dr;
                reasoningDelta += dr;
            }
            if (choice.delta.role) this.role = choice.delta.role;
            if (!isThoughtPart(choice.delta) && Array.isArray(choice.delta.tool_calls)) {
                for (const frag of choice.delta.tool_calls) {
                    if (isThoughtPart(frag)) continue;
                    const idx = frag.index ?? 0;
                    if (!this.toolCalls[idx]) this.toolCalls[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
                    if (frag.id) this.toolCalls[idx].id = frag.id;
                    if (frag.type) this.toolCalls[idx].type = frag.type;
                    if (frag.function?.name) this.toolCalls[idx].function.name += frag.function.name;
                    if (frag.function?.arguments) this.toolCalls[idx].function.arguments += frag.function.arguments;
                }
            }
        }
        // message 路径（一次性 SSE，不常见但兼容）
        else if (choice.message) {
            delta = publicMessageText(choice.message);
            this.content = delta;
            const mr = choice.message.reasoning_content ?? choice.message.reasoning ?? choice.message.thinking;
            if (typeof mr === 'string') {
                this.reasoning += mr;
                reasoningDelta += mr;
            }
            if (choice.message.role) this.role = choice.message.role;
            if (!isThoughtPart(choice.message) && Array.isArray(choice.message.tool_calls)) this.toolCalls.push(...choice.message.tool_calls);
        }
        if (choice.finish_reason) this.finishReason = choice.finish_reason;
        return { content: delta, reasoning: reasoningDelta };
    }

    get reasoningContent(): string {
        return this.reasoning;
    }

    finish(): any | null {
        if (!this.gotAnyChunk) return null;
        // 合成兼容结构
        return {
            ...(this.brokenEvent || (!this.sawDone && !this.finishReason) ? { stream_incomplete: true } : {}),
            id: this.firstChunk?.id || 'sse-assembled',
            object: 'chat.completion',
            created: this.firstChunk?.created || Math.floor(Date.now() / 1000),
            model: this.firstChunk?.model || '',
            choices: [{
                index: 0,
                message: {
                    role: this.role,
                    content: this.content,
                    ...(this.reasoning ? { reasoning_content: this.reasoning } : {}),
                    ...(this.toolCalls.length ? {
                        tool_calls: this.toolCalls.filter(Boolean).map((tc, i) => ({ ...tc, id: tc.id || `call_sse_${i}` })),
                    } : {}),
                },
                finish_reason: this.finishReason,
            }],
            usage: this.usage || this.firstChunk?.usage,
        };
    }
}
