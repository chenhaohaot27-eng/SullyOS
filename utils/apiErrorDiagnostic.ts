// Error bodies can contain echoed prompts, credentials or ordinary completion deltas.
// Only this short diagnostic may enter the two mobile logs.
const BODY_LIMIT = 16 * 1024;
const DETAIL_LIMIT = 400;
const HIDDEN = '已隐藏敏感内容';
// Only fixed provider categories may bypass prompt-echo checks. Arbitrary values
// in code/status/type are still untrusted text, including credentials.
const SAFE_CATEGORIES = new Map([
    'PROHIBITED_CONTENT', 'INVALID_ARGUMENT', 'RESOURCE_EXHAUSTED', 'PERMISSION_DENIED',
    'UNAUTHENTICATED', 'NOT_FOUND', 'FAILED_PRECONDITION', 'DEADLINE_EXCEEDED', 'UNAVAILABLE',
    'service_error', 'invalid_request_error', 'authentication_error', 'permission_error',
    'rate_limit_error', 'server_error', 'overloaded_error', 'context_length_exceeded',
    'model_not_found', 'bad_response_status_code',
].map(value => [value.toLowerCase(), value]));
const REQUEST_ID_FIELDS = ['request_id', 'requestId'] as const;
const REQUEST_ID_HEADERS = ['x-request-id', 'request-id'] as const;
interface DiagnosticField {
    name: string;
    value: string;
    kind: 'metadata' | 'message' | 'request-id';
}

function diagnosticFields(raw: string, contentType: string): DiagnosticField[] {
    const text = raw.trim();
    if (!text || text.startsWith('<')) return [];
    const messageField = (value: string): DiagnosticField[] => [{ name: 'message', value, kind: 'message' }];
    const fromJson = (value: any): DiagnosticField[] => {
        if (!value || typeof value !== 'object' || value.choices || value.candidates) return [];
        const error = value.error;
        const fields: DiagnosticField[] = [];
        for (const name of ['code', 'status', 'type']) {
            const field = error?.[name] ?? value[name];
            if (typeof field === 'string' || typeof field === 'number') fields.push({ name, value: String(field), kind: 'metadata' });
        }
        for (const [prefix, parent] of [['error.', error], ['', value]] as const) {
            for (const name of REQUEST_ID_FIELDS) {
                if (typeof parent?.[name] === 'string') fields.push({ name: prefix + name, value: parent[name], kind: 'request-id' });
            }
        }
        const message = typeof error === 'string' ? error : error?.message ?? value.message ?? value.msg ?? value.detail;
        if (typeof message === 'string' || typeof message === 'number') fields.push(...messageField(String(message)));
        return fields;
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
                if (/^event:\s*error\s*$/mi.test(block) && !/^[{[<]/.test(data)) return messageField(data);
            }
        }
        return [];
    }
    return messageField(text);
}

function redactCredentials(value: string, credentials: string[]): string {
    for (const credential of credentials) value = value.split(credential).join('[已脱敏]');
    return value.replace(/\b(?:Bearer|Basic)\s+\S+/gi, '[已脱敏]')
        .replace(/(?:authorization|api[-_ ]?key|access[-_ ]?token|secret|password|cookie)["']?\s*[:=]\s*.*/gi, '[已脱敏]')
        .replace(/\b(?:sk-[\w-]+|AIza[\w-]+|eyJ[\w-]+\.[\w.-]+)\b/gi, '[已脱敏]');
}

function requestEchoes(line: string, request: any, fuzzy: boolean): boolean {
    const samples = fuzzy ? [
        ...(line.match(/.{8,10}/gu) ?? []),
        ...line.split(/["'“”‘’：:\n]/).map(s => s.trim()).filter(s => s.length >= 2),
    ] : [line];
    const echoed = (part: unknown): boolean => {
        if (typeof part === 'string') {
            const s = part.trim();
            return !!s && (((fuzzy || s.length >= 8) && line.includes(s)) || samples.some(sample => s.includes(sample)));
        }
        if (Array.isArray(part)) return part.some(echoed);
        if (!part || typeof part !== 'object') return false;
        return Object.entries(part).some(([key, child]) => key !== 'type' && echoed(child));
    };
    const turns: any[] = [...(Array.isArray(request?.messages) ? request.messages : []), ...(Array.isArray(request?.contents) ? request.contents : [])];
    return turns.some(turn => echoed(turn?.content ?? turn?.parts)) || echoed(request?.systemInstruction) || echoed(request?.prompt);
}

function safeField(field: DiagnosticField, request: any, credentials: string[]): string {
    const value = field.value;
    if (field.kind === 'request-id') {
        // Explicit trace fields only. Long IDs are valid; the generic long-token
        // redactor below cannot distinguish them from secrets. Reject known
        // credentials, secret-shaped values and prompt echoes before displaying.
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(value)
            || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)
            || redactCredentials(value, credentials) !== value
            || requestEchoes(value, request, false)) return HIDDEN;
        return value;
    }
    // Drop dumps even when the relay serialized them inside error.message.
    if (/[{<>]|"(?:content|messages|prompt|input|parts)"\s*:|data:[^;]+;base64,/i.test(value)) return HIDDEN;
    const line = redactCredentials(value.trim().split(/[\r\n]/, 1)[0], credentials)
        .replace(/https?:\/\/\S+|[A-Za-z0-9_+/=-]{40,}/gi, '[已脱敏]')
        .replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, DETAIL_LIMIT);
    if (field.kind === 'metadata' && (SAFE_CATEGORIES.has(line.toLowerCase()) || /^(?:[0-9]|[1-9][0-9]|[1-5][0-9]{2})$/.test(line))) return line;
    // This known relay error can itself appear in a previous failure notice in the history.
    if (/^invalid thought signature\.?$/i.test(line)) return line;
    // Reject full short inputs and excerpts of longer turns (including multipart content).
    if (requestEchoes(line, request, true)) return HIDDEN;
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
        for (const name of REQUEST_ID_HEADERS) {
            const value = response.headers.get(name);
            if (value) fields.push({ name, value, kind: 'request-id' });
        }
        if (!fields.length) return raw.trim() ? '未找到可显示的上游错误字段' : '服务器返回了空正文';
        const source = typeof Request !== 'undefined' && resource instanceof Request ? resource : undefined;
        // Never read a Request stream for logging. Without its text we cannot exclude prompt echoes.
        if ((init?.body != null && typeof init.body !== 'string') || (source?.body && !init?.body)) return HIDDEN;
        const request = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
        const headers = new Headers(init?.headers ?? source?.headers);
        const credentials: string[] = [];
        headers.forEach((value, key) => {
            if (/authorization|api[-_]?key|token|secret|cookie/i.test(key)) {
                credentials.push(value, value.replace(/^\S+\s+/, ''));
                if (key.toLowerCase() === 'cookie') credentials.push(...value.split(';').map(part => part.slice(part.indexOf('=') + 1).trim()));
            }
        });
        if (resource) {
            const url = new URL(source?.url || String(resource), 'https://local.invalid');
            url.searchParams.forEach((value, key) => {
                if (/key|token|auth|secret|signature/i.test(key)) credentials.push(value);
            });
            if (url.username) credentials.push(decodeURIComponent(url.username));
            if (url.password) credentials.push(decodeURIComponent(url.password));
        }
        for (const parent of [request, request?.extra_body]) {
            if (!parent || typeof parent !== 'object') continue;
            for (const [key, value] of Object.entries(parent)) {
                if (/^(?:authorization|api[-_]?key|key|access[-_]?token|secret|password)$/i.test(key) && typeof value === 'string') credentials.push(value);
            }
        }
        const secrets = credentials.filter(Boolean);
        // A relay may put the category at the start of a message that then echoes
        // private text. Only recognize explicit error prefixes; an enum mentioned
        // inside a quoted prompt or a later explanation is not a provider category.
        const categories = new Set<string>();
        for (const field of fields.filter(field => field.kind === 'message')) {
            const token = /^(?:status_code\s*=\s*[1-5][0-9]{2}\s*,\s*)?([A-Za-z][A-Za-z0-9_]*)(?=\s*(?::|$))/i
                .exec(redactCredentials(field.value, secrets).trim())?.[1];
            const category = token && SAFE_CATEGORIES.get(token.toLowerCase());
            if (category && (token.includes('_') || token === category)
                && !fields.some(item => item.kind === 'metadata' && item.value.toLowerCase() === category.toLowerCase())) categories.add(category);
        }
        const metadata = fields.filter(field => field.kind === 'metadata');
        const ordered: DiagnosticField[] = [...metadata, ...Array.from(categories, value => ({ name: 'category', value, kind: 'metadata' as const })),
            ...fields.filter(field => field.kind === 'request-id'), ...fields.filter(field => field.kind === 'message')];
        return ordered.map(field => `${field.name}: ${safeField(field, request, secrets)}`).join(' · ').slice(0, DETAIL_LIMIT) || '服务器未提供错误说明';
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
