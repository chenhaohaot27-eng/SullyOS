/** Output-only contract. The nonce is generated per request, never taken from chat history. */
export class ReplyBoundaryError extends Error {
    readonly code = 'LLM_REPLY_BOUNDARY';
    readonly permanent = true;

    constructor() {
        super('无法可靠分离思考与正式回复，本轮已拦截。请重新生成。');
    }
}

export function frameReplyMessages<T extends { role: string; content?: unknown }>(messages: T[], nonce: string) {
    const rule = '本轮传输格式：请输出可直接展示的完整正式回复（含需要执行的动作，保留原有格式）。'
        + '如使用正文标签，请放在唯一一对 <reply-' + nonce + '> 和 </reply-' + nonce + '> 之间；'
        + '也可直接输出原有正文格式。库存分析、推理和草案不得混入正式回复。仅调用原生工具时可留空正文。';
    const first = messages[0];
    if (first?.role === 'system' && typeof first.content === 'string') {
        return [{ ...first, content: first.content + '\n\n' + rule }, ...messages.slice(1)];
    }
    return [{ role: 'system' as const, content: rule }, ...messages];
}

/** Only provider-designated text parts may contribute bytes to the public channel. */
export function publicPartText(value: any): string {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(publicPartText).join('');
    if (!value || typeof value !== 'object' || value.thought === true
        || (value.type && !['text', 'output_text'].includes(value.type))) return '';
    return publicPartText(value.text ?? value.content ?? value.value);
}

export function isThoughtPart(part: any): boolean {
    return part?.thought === true || ['thinking', 'thought', 'reasoning', 'analysis', 'redacted_thinking'].includes(part?.type);
}

export function publicMessageText(message: any): string {
    if (isThoughtPart(message)) return '';
    return publicPartText(message?.content);
}

/** Validate the complete turn before releasing any text or tool calls. Nested thought
 * blocks are legal. Public text does not require a custom frame; any frame that is
 * present must be complete, unique and correlated with this request. */
export function readReply(text: string, nonce?: string, nativeTools = false): string {
    const tags = /<\s*(\/?)\s*(think(?:ing)?|thought|reasoning|analysis)(?=[\s>])[^>]*>/gi;
    const stack: string[] = [];
    const visible: string[] = [];
    let cursor = 0;
    for (const match of text.matchAll(tags)) {
        if (!stack.length) visible.push(text.slice(cursor, match.index));
        const name = match[2].toLowerCase();
        if (!match[1]) stack.push(name);
        else if (stack.pop() !== name) throw new ReplyBoundaryError();
        cursor = match.index! + match[0].length;
    }
    if (stack.length) throw new ReplyBoundaryError();
    visible.push(text.slice(cursor));
    const body = visible.join('');
    // Transport normalization runs before the caller supplies its nonce. Keep frames
    // intact here so only the request-aware pass can accept and remove them.
    if (!nonce) return body;
    let answer = body;
    // Include wrong nonces, malformed spacing/case, and truncated prefixes. Once a
    // frame is attempted, its preamble can never become a plain-text fallback.
    const markers = Array.from(body.matchAll(/<\s*\/?\s*reply(?=-|[\s>]|$)/gi));
    if (markers.length) {
        const start = '<reply-' + nonce + '>';
        const end = '</reply-' + nonce + '>';
        const at = body.indexOf(start);
        const to = body.indexOf(end);
        if (markers.length !== 2 || at < 0 || to < at + start.length
            || markers[0].index !== at || markers[1].index !== to) throw new ReplyBoundaryError();
        answer = body.slice(at + start.length, to);
    }
    // A relay can copy a whole formatted scratchpad even inside the final span.
    // Require two distinct line-leading document headings before flagging prose.
    const headings = answer.split(/\r?\n/).map(line => line.trim().replace(/^[#*\s]+|[*\s]+$/g, ''));
    const scratchpad = headings.some(line => /^(?:表情包库存|内部分析|思考过程|sticker inventory|analysis)\s*(?:[:：]|$)/i.test(line))
        && headings.some(line => /^(?:回复草案|回复草稿|reply draft|draft reply)\s*(?:[:：]|$)/i.test(line));
    if (scratchpad || (!nativeTools && !answer.trim())) throw new ReplyBoundaryError();
    return answer;
}

/** Mutate only the public message fields so Gemini's non-enumerable signature survives. */
export function finalizeReply(data: any, nonce?: string): any {
    if (nonce && !data?.choices?.[0]?.message) throw new ReplyBoundaryError();
    for (const choice of Array.isArray(data?.choices) ? data.choices : []) {
        const message = choice?.message;
        if (!message) continue;
        if (isThoughtPart(message)) delete message.tool_calls;
        if (Array.isArray(message.tool_calls)) {
            message.tool_calls = message.tool_calls.filter((call: unknown) => !isThoughtPart(call));
            if (!message.tool_calls.length) delete message.tool_calls;
        }
        message.content = readReply(publicMessageText(message), nonce, !!message.tool_calls?.length);
        for (const key of ['reasoning_content', 'reasoning', 'thinking', 'thought', 'reasoning_details', 'anthropic_thinking']) {
            delete message[key];
        }
    }
    return data;
}
