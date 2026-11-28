/** Request metadata only: never print prompts, credentials or arbitrary provider extras. */
export const API_REQUEST_DIAGNOSTIC_LIMIT = 1_600;

const ABSENT = '未发送（服务端默认）';
const HIDDEN_ID = '[已隐藏标识]';
const ROLES = new Set(['system', 'developer', 'user', 'assistant', 'model', 'tool', 'function']);
const MODES = new Set(['enabled', 'disabled', 'adaptive', 'auto', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
type RecordValue = Record<string, unknown>;

const record = (value: unknown): RecordValue | undefined =>
    value != null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined;
const has = (value: RecordValue | undefined, key: string): boolean => !!value && Object.prototype.hasOwnProperty.call(value, key);
const valueType = (value: unknown): string => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;

function scalar(value: unknown, present: boolean, enumAllowed = false): string {
    if (!present) return ABSENT;
    if (typeof value === 'number' && Number.isFinite(value)) return `已发送(number=${value})`;
    if (typeof value === 'boolean') return `已发送(boolean=${value})`;
    if (enumAllowed && typeof value === 'string' && MODES.has(value)) return `已发送(string=${value})`;
    return `已发送(${valueType(value)}，值未展示)`;
}

function field(parent: RecordValue | undefined, key: string, enumAllowed = false): string {
    return scalar(parent?.[key], has(parent, key), enumAllowed);
}

function thinkingValue(value: unknown): string {
    const object = record(value);
    if (!object) return scalar(value, true, true);
    const details: string[] = [];
    for (const key of ['type', 'mode', 'effort', 'thinkingLevel', 'thinking_level']) {
        if (has(object, key)) details.push(`${key}=${field(object, key, true)}`);
    }
    for (const key of ['budget_tokens', 'thinking_budget', 'thinkingBudget', 'max_tokens', 'includeThoughts', 'include_thoughts', 'enabled', 'exclude']) {
        if (has(object, key)) details.push(`${key}=${field(object, key)}`);
    }
    return `已发送(object${details.length ? '; ' + details.join(', ') : '，无可展示参数'})`;
}

function reasoningSummary(body: RecordValue, generation: RecordValue | undefined): string[] {
    const extra = record(body.extra_body);
    const google = record(extra?.google);
    const thinking: Array<[string, RecordValue | undefined, string]> = [
        ['thinking', body, 'thinking'], ['thinking_budget', body, 'thinking_budget'],
        ['thinkingConfig', body, 'thinkingConfig'], ['thinking_config', body, 'thinking_config'],
        ['generationConfig.thinkingConfig', generation, 'thinkingConfig'],
        ['extra_body.thinking', extra, 'thinking'], ['extra_body.thinking_budget', extra, 'thinking_budget'],
        ['extra_body.thinkingConfig', extra, 'thinkingConfig'], ['extra_body.thinking_config', extra, 'thinking_config'],
        ['extra_body.google.thinking_config', google, 'thinking_config'],
    ];
    const reasoning: Array<[string, RecordValue | undefined, string]> = [
        ['reasoning_effort', body, 'reasoning_effort'], ['reasoning', body, 'reasoning'],
        ['extra_body.reasoning_effort', extra, 'reasoning_effort'], ['extra_body.reasoning', extra, 'reasoning'],
    ];
    const summarize = (entries: typeof thinking, label: string): string[] => {
        const sent = entries.filter(([, parent, key]) => has(parent, key));
        return sent.length ? sent.map(([name, parent, key]) => `${name}: ${thinkingValue(parent![key])}`) : [`${label}: ${ABSENT}`];
    };
    return [...summarize(thinking, 'thinking'), ...summarize(reasoning, 'reasoning')];
}

function rolesSummary(messages: unknown[], label: string): string {
    const roles = messages.map(message => {
        const role = record(message)?.role;
        return typeof role === 'string' && ROLES.has(role) ? role : 'unknown';
    });
    const counts = new Map<string, number>();
    for (const role of roles) counts.set(role, (counts.get(role) ?? 0) + 1);
    const summary = Array.from(counts, ([role, count]) => `${role}×${count}`).join(', ') || '无';
    return `${label}(${messages.length}) roles: ${summary}; tail: ${roles.slice(-6).join(',') || '无'}`;
}

/** Pass the actual outbound init, after any request rewrites. Request body streams
 * are deliberately not read. Only the hostname and a fixed protocol label may
 * be displayed from the URL; credentials, path and query are never logged. */
export function formatApiRequestDiagnostic(init?: RequestInit, resource?: RequestInfo | URL): string {
    const heading = '\n--- Request ---\n';
    try {
        if (typeof init?.body !== 'string') return heading + '请求元数据：未提供可读取的 JSON 请求体';
        const body = record(JSON.parse(init.body));
        if (!body) return heading + '请求元数据：JSON 请求体不是对象';

        const source = typeof Request !== 'undefined' && resource instanceof Request ? resource : undefined;
        let url: URL | undefined;
        try { if (resource) url = new URL(source?.url || String(resource)); } catch { /* Relative or invalid URL: the actual host is unknown. */ }
        const credentials: string[] = [];
        new Headers(init.headers ?? source?.headers).forEach((value, key) => {
            if (/authorization|api[-_]?key|token|secret|cookie/i.test(key)) {
                credentials.push(value, value.replace(/^\S+\s+/, ''));
                if (key.toLowerCase() === 'cookie') credentials.push(...value.split(';').map(part => part.slice(part.indexOf('=') + 1).trim()));
            }
        });
        url?.searchParams.forEach((value, key) => {
            if (/key|token|auth|secret|signature/i.test(key)) credentials.push(value);
        });
        if (url?.username) credentials.push(decodeURIComponent(url.username));
        if (url?.password) credentials.push(decodeURIComponent(url.password));
        for (const parent of [body, record(body.extra_body)]) {
            for (const [key, value] of Object.entries(parent ?? {})) {
                if (/^(?:authorization|api[-_]?key|key|access[-_]?token|secret|password)$/i.test(key) && typeof value === 'string') credentials.push(value);
            }
        }
        const identifier = (value: unknown, maxLength: number): string => {
            if (value == null || value === '') return '未提供';
            if (typeof value !== 'string' || value.length > maxLength
                || !/^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]*$/.test(value)
                || /^(?:sk-|AIza|eyJ[\w-]+\.)/i.test(value)
                || /[A-Za-z0-9_+=]{40,}/.test(value)
                || credentials.some(secret => secret && value.includes(secret))) return HIDDEN_ID;
            return value;
        };

        const nativeEndpoint = /\/models\/([^/]+):(streamGenerateContent|generateContent)$/.exec(url?.pathname || '');
        const hostname = url?.hostname;
        const endpointHost = !hostname ? '未知'
            : !/^https?:$/.test(url?.protocol || '') || !/^[a-zA-Z0-9.-]+$/.test(hostname)
                || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname)
                || /(?:^|\.)(?:sk-|AIza|eyJ)/i.test(hostname)
                || credentials.some(secret => secret && hostname.includes(secret.toLowerCase()))
                ? HIDDEN_ID : identifier(hostname, 253);
        const protocol = !/^https?:$/.test(url?.protocol || '') ? 'unknown' : nativeEndpoint ? 'gemini-native'
            : /\/chat\/completions\/?$/.test(url?.pathname || '') ? 'openai-compatible' : 'unknown';
        const native = Array.isArray(body.contents) || !!nativeEndpoint;
        let model: unknown = body.model;
        if (nativeEndpoint) {
            try { model = decodeURIComponent(nativeEndpoint[1]); } catch { model = undefined; }
        }
        const generation = record(body.generationConfig);
        const sampling = native ? generation : body;
        const messages = native ? body.contents : body.messages;
        const definitions = Array.isArray(body.tools)
            ? native
                ? body.tools.flatMap(tool => {
                    const list = record(tool)?.functionDeclarations;
                    return Array.isArray(list) ? list : [];
                })
                : body.tools.map(tool => record(tool)?.function)
            : [];
        const names = [...new Set(definitions.map(tool => identifier(record(tool)?.name, 64)))];
        const displayedNames = names.slice(0, 6).join(', ') || '无';
        const streamOptions = record(body.stream_options);
        const lines = [
            native ? '\n--- Request (Gemini Native) ---' : '\n--- Request ---',
            `endpoint_host: ${endpointHost} | protocol: ${protocol}`,
            `model: ${identifier(model, 120)}`,
            `max_tokens: ${field(body, 'max_tokens')} | max_completion_tokens: ${field(body, 'max_completion_tokens')}`,
            ...(native || has(generation, 'maxOutputTokens') ? [`generationConfig.maxOutputTokens: ${field(generation, 'maxOutputTokens')}`] : []),
            `stream: ${field(body, 'stream')}` + (nativeEndpoint ? ` | transport: ${nativeEndpoint[2] === 'streamGenerateContent' ? 'SSE' : 'JSON'}（由URL指定）` : ''),
            `stream_options: ${has(body, 'stream_options') ? `已发送(${valueType(body.stream_options)})` : ABSENT}; include_usage: ${field(streamOptions, 'include_usage')}`,
            `temperature: ${field(sampling, 'temperature')} | ${native ? 'topP' : 'top_p'}: ${field(sampling, native ? 'topP' : 'top_p')}`,
            Array.isArray(messages) ? rolesSummary(messages, native ? 'contents' : 'messages') : `${native ? 'contents' : 'messages'}: ${field(body, native ? 'contents' : 'messages')}`,
            `tools(${definitions.length}) names(${names.length}): ${displayedNames}${names.length > 6 ? `, …另${names.length - 6}个` : ''}`,
            ...(native ? [`systemInstruction parts: ${Array.isArray(record(body.systemInstruction)?.parts) ? (record(body.systemInstruction)!.parts as unknown[]).length : 0}`] : []),
            ...reasoningSummary(body, generation),
        ];
        const text = lines.join('\n');
        const suffix = '\n…（摘要已截断）';
        return text.length <= API_REQUEST_DIAGNOSTIC_LIMIT ? text : text.slice(0, API_REQUEST_DIAGNOSTIC_LIMIT - suffix.length) + suffix;
    } catch {
        return heading + '请求元数据：无法解析；未输出原始请求';
    }
}
