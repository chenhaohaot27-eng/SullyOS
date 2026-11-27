// Error bodies can contain echoed prompts, credentials or ordinary completion deltas.
// Only this short diagnostic may enter the two mobile logs.
const BODY_LIMIT = 16 * 1024;
const DETAIL_LIMIT = 400;
const HIDDEN = '已隐藏敏感内容';

function diagnosticFields(raw: string, contentType: string): string[] {
    const text = raw.trim();
    if (!text || text.startsWith('<')) return [];
    const fromJson = (value: any): string[] => {
        if (!value || typeof value !== 'object' || value.choices || value.candidates) return [];
        const error = value.error;
        const fields = [error?.code ?? value.code, error?.status ?? value.status, error?.type ?? value.type,
            typeof error === 'string' ? error : error?.message ?? value.message ?? value.msg ?? value.detail];
        return [...new Set(fields.filter(v => typeof v === 'string' || typeof v === 'number').map(String))];
    };
    if (/^[{[]/.test(text)) {
        try { return fromJson(JSON.parse(text)); } catch { return []; }
    }
    if (/^(data:|event:|id:|retry:|:)/m.test(text) || contentType.includes('text/event-stream')) {
        for (const block of text.replace(/\r\n?/g, '\n').split(/\n\n+/)) {
            const event = /^event:\s*(\S+)/m.exec(block)?.[1];
            if (event && !/^(?:message|error)$/i.test(event)) continue;
            const data = block.split('\n').filter(line => line.startsWith('data:'))
                .map(line => line.slice(5).trimStart()).join('\n');
            if (!data || data === '[DONE]') continue;
            try {
                const fields = fromJson(JSON.parse(data));
                if (fields.length) return fields;
            } catch {
                if (/^event:\s*error\s*$/mi.test(block) && !/^[{[<]/.test(data)) return [data];
            }
        }
        return [];
    }
    return [text];
}

function safeField(value: string, request: any, credentials: string[]): string {
    // Drop dumps even when the relay serialized them inside error.message.
    if (/[{<>]|"(?:content|messages|prompt|input|parts)"\s*:|data:[^;]+;base64,/i.test(value)) return HIDDEN;
    let line = value.trim().split(/[\r\n]/, 1)[0];
    for (const credential of credentials) line = line.split(credential).join('[已脱敏]');
    line = line.replace(/\b(?:Bearer|Basic)\s+\S+/gi, '[已脱敏]')
        .replace(/(?:authorization|api[-_ ]?key|access[-_ ]?token|secret|password|cookie)["']?\s*[:=]\s*.*/gi, '[已脱敏]')
        .replace(/\b(?:sk-[\w-]+|AIza[\w-]+|eyJ[\w-]+\.[\w.-]+)\b/gi, '[已脱敏]')
        .replace(/https?:\/\/\S+|[A-Za-z0-9_+/=-]{40,}/gi, '[已脱敏]')
        .replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, DETAIL_LIMIT);
    // This known relay error can itself appear in a previous failure notice in the history.
    if (/^invalid thought signature\.?$/i.test(line)) return line;
    // Reject full short inputs and excerpts of longer turns (including multipart content).
    const samples = [
        ...(line.match(/.{8,10}/gu) ?? []),
        ...line.split(/["'“”‘’：:\n]/).map(s => s.trim()).filter(s => s.length >= 2),
    ];
    const echoed = (part: unknown): boolean => {
        if (typeof part === 'string') {
            const s = part.trim();
            return !!s && (line.includes(s) || samples.some(sample => s.includes(sample)));
        }
        if (Array.isArray(part)) return part.some(echoed);
        if (!part || typeof part !== 'object') return false;
        return Object.entries(part).some(([key, child]) => key !== 'type' && echoed(child));
    };
    const turns: any[] = [...(request?.messages ?? []), ...(request?.contents ?? [])];
    if (turns.some(turn => echoed(turn?.content ?? turn?.parts)) || echoed(request?.systemInstruction) || echoed(request?.prompt)) return HIDDEN;
    return line;
}

/** Clone synchronously before yielding to the caller. Neither a stalled stream nor a clone failure owns the original response. */
export async function readApiErrorDiagnostic(response: Response, init?: RequestInit, resource?: RequestInfo | URL): Promise<string> {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    try {
        reader = response.clone().body?.getReader();
        if (!reader) return '服务器未返回可读的错误正文';
        const decoder = new TextDecoder();
        let raw = '';
        let bytes = 0;
        const deadline = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('timeout')), 3000);
        });
        while (bytes < BODY_LIMIT) {
            const { done, value } = await Promise.race([reader.read(), deadline]);
            if (done) { finished = true; break; }
            raw += decoder.decode(value.subarray(0, BODY_LIMIT - bytes), { stream: true });
            bytes += value.byteLength;
        }
        raw += decoder.decode();
        const fields = diagnosticFields(raw, response.headers.get('content-type') || '');
        if (!fields.length) return raw.trim() ? '未找到可显示的上游错误字段' : '服务器返回了空正文';
        const source = typeof Request !== 'undefined' && resource instanceof Request ? resource : undefined;
        // Never read a Request stream for logging. Without its text we cannot exclude prompt echoes.
        if ((init?.body != null && typeof init.body !== 'string') || (source?.body && !init?.body)) return HIDDEN;
        const request = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
        const headers = new Headers(init?.headers ?? source?.headers);
        const credentials: string[] = [];
        headers.forEach((value, key) => {
            if (/authorization|api[-_]?key|token|secret/i.test(key)) {
                credentials.push(value, value.replace(/^\S+\s+/, ''));
            }
        });
        if (resource) {
            const url = new URL(source?.url || String(resource), 'https://local.invalid');
            url.searchParams.forEach((value, key) => {
                if (/key|token|auth|secret|signature/i.test(key)) credentials.push(value);
            });
        }
        return fields.map(field => safeField(field, request, credentials.filter(Boolean))).filter(Boolean).join(' · ').slice(0, DETAIL_LIMIT) || '服务器未提供错误说明';
    } catch {
        return '无法读取上游错误正文';
    } finally {
        clearTimeout(timer);
        if (reader) {
            if (!finished) void reader.cancel().catch(() => {});
            reader.releaseLock();
        }
    }
}
