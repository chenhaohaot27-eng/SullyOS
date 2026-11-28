import { publicMessageText, readReply, finalizeReply } from './replyBoundary';
import { readOpenAiResponse } from './openAiStream';
export { isSseResponseText, parseSseToCompletion } from './openAiStream';
/**
 * Safe API response parsing utilities.
 *
 * Prevents "Unexpected token <" crashes that happen when API proxies
 * return HTML error pages (CloudFlare, nginx 502/503, rate limits)
 * instead of JSON responses.
 */

// 同时挂两套日志：
//   - devDebug 的 api 类目（开发者勾「API」复制 / 下载导出）
//   - 全局 fetch 拦截器 + apiCallLog（用户在「设置 → API 调用记录」里看）
// 后者的 meta 通过下面 safeFetchJson 的第 5 个参数挂到 __sullyMeta 上传出去。
import { appendDevDebugApiLog, makeDebugLogger } from './devDebug';
import { getApiCallAmbientContext, recordApiCall, type ApiCallMeta } from './apiCallLog';
import { completionOutcome } from './completionOutcome';

const log = makeDebugLogger('api', 'SafeAPI');

export function isChatCompletionUrl(url: string): boolean {
    return url.includes('/chat/completions');
}

/** Parse JSON or a relay's SSE response through the shared bounded reader. */
export async function safeResponseJson(response: Response): Promise<any> {
    return finalizeReply((await readOpenAiResponse(response)).data);
}

/** safeFetchJson 的可选流式钩子（只在响应确实是 SSE 流时触发） */
export interface StreamHooks {
    /** 完整 SSE 正文通过校验后通知显示层。 */
    onDelta?: (delta: string, fullText: string) => void;
    /** 每收到一段原生 reasoning 增量时回调；渠道不发送 reasoning 时不会触发。 */
    onReasoningDelta?: (delta: string, fullReasoning: string) => void;
    /** 收到第一个正文增量时回调一次（TTFT 参考点） */
    onFirstDelta?: () => void;
}

/**
 * 真·流式读取响应体：边到边解析 SSE 行，收齐校验后回调 onDelta。
 * 支持 data 事件前先到达的 SSE 注释/心跳；代理无视 stream:true 返回整包 JSON / HTML
 * 错误页时，自动退化为完整 JSON / HTML 解析 —— 与非流式路径行为一致。
 */
export async function readBodyWithStreaming(
    response: Response,
    hooks: StreamHooks,
    timing?: { firstDeltaMs?: number },
    startedAt?: number,
): Promise<any> {
    let sawFirstDelta = false;
    const { data, isSse } = await readOpenAiResponse(response, (delta, fullReasoning) => {
        if (delta.content) {
            if (!sawFirstDelta) {
                sawFirstDelta = true;
                if (timing && startedAt) timing.firstDeltaMs = Date.now() - startedAt;
                try { hooks.onFirstDelta?.(); } catch { /* 回调异常不拦截流 */ }
            }
            // Content is released only after the complete turn passes validation.
        }
        if (delta.reasoning) {
            try { hooks.onReasoningDelta?.(delta.reasoning, fullReasoning); } catch { /* 回调异常不拦截流 */ }
        }
    });
    const result = finalizeReply(data);
    const content = result?.choices?.[0]?.message?.content;
    if (isSse && content && completionOutcome(result).kind !== 'interrupted') hooks.onDelta?.(content, content);
    return result;
}

/**
 * Fetch with automatic retry for transient errors on non-billable endpoints.
 * Chat completions never retry automatically: a timeout/network error does not
 * prove the upstream generation stopped, so retrying can charge the user twice.
 * Other endpoints retry on: 429, 500, 502, 503, 504 and network failures.
 * Returns the parsed JSON data directly.
 *
 * `timeoutMs`：每次尝试的硬超时。如果调用方没在 options.signal 里自带 AbortController，
 * 这里会给每次 attempt 起一个内部 AbortController，超时就 abort，避免提供方 stall
 * 住整个页面（用户误以为卡死，只能重新打开网页）。0 / 未传 = 不超时。
 */
export async function safeFetchJson(
    url: string,
    options: RequestInit,
    maxRetries: number = 2,
    timeoutMs: number = 0,
    /** 可选：补充「哪个 App / 哪个角色 / 用途」到 API 调用记录（设置 → API 调用记录）。 */
    meta?: ApiCallMeta,
    /** 可选：流式增量回调（请求体带 stream:true 时传入才有意义；响应不是 SSE 时静默不触发）。 */
    streamHooks?: StreamHooks,
): Promise<any> {
    const retryableStatuses = new Set([429, 500, 502, 503, 504]);
    let lastError: Error | null = null;
    const urlStr = String(url);
    const automaticRetryLimit = isChatCompletionUrl(urlStr)
        ? 0
        : Math.max(0, Math.floor(Number(maxRetries) || 0));
    let lastStatus: number | undefined;

    // 显式 meta 挂到 RequestInit 给全局 fetch 兜底；同时快照环境标签，避免长响应期间
    // 用户切 App 后被错标。safeFetchJson 与全局拦截器以 requestId 原子去重。
    const metaOptions: RequestInit = meta ? { ...options, __sullyMeta: meta } as RequestInit : options;
    const logMeta = meta || getApiCallAmbientContext();

    for (let attempt = 0; attempt <= automaticRetryLimit; attempt++) {
        // 全局 fetch 拦截器和这里的“已解析响应兜底”共享 ID。前者覆盖裸 fetch，
        // 后者不依赖 Response.clone()，避免部分 iOS/WebView 克隆流不结束时漏记。
        const callerRequestId = (options as RequestInit & { __sullyApiCallId?: unknown }).__sullyApiCallId;
        const requestId = attempt === 0 && typeof callerRequestId === 'string' && callerRequestId.trim()
            ? callerRequestId
            : `api-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        // 每次 attempt 建一个独立的 AbortController（仅用于 timeout）
        // 调用方自己的 options.signal 仍然有效，两者任一触发就 abort
        let attemptOptions = { ...metaOptions, __sullyApiCallId: requestId } as RequestInit;
        let timeoutHandle: any = null;
        let timedOut = false;
        let abortFromCaller: (() => void) | undefined;
        if (timeoutMs > 0) {
            const ac = new AbortController();
            timeoutHandle = setTimeout(() => {
                timedOut = true;
                ac.abort();
            }, timeoutMs);
            if (options.signal) {
                // 串联外部 signal：外部 abort 也触发内部
                if (options.signal.aborted) {
                    clearTimeout(timeoutHandle);
                    throw new Error('aborted');
                }
                abortFromCaller = () => ac.abort();
                options.signal.addEventListener('abort', abortFromCaller, { once: true });
            }
            attemptOptions = { ...attemptOptions, signal: ac.signal };
        }
        const attemptStartedAt = Date.now();
        try {
            const response = await fetch(url, attemptOptions);
            lastStatus = response.status;
            const headersMs = Date.now() - attemptStartedAt;

            if (!response.ok) {
                // For retryable status codes, retry before giving up
                if (retryableStatuses.has(response.status) && attempt < automaticRetryLimit) {
                    const delay = Math.pow(2, attempt) * 1000; // 1s, 2s
                    log.warn('HTTP retry', { status: response.status, attempt: attempt + 1, maxRetries: automaticRetryLimit, delay });
                    await new Promise(r => setTimeout(r, delay));
                    continue;
                }
                // Non-retryable or last attempt: parse body for error details
                const data = await safeResponseJson(response);
                // If we somehow got valid JSON with error info, wrap it
                const errMsg = data?.error?.message || data?.error || `HTTP ${response.status}`;
                throw new Error(`API Error ${response.status}: ${errMsg}`);
            }

            const timing: { firstDeltaMs?: number } = {};
            const data = streamHooks || (isChatCompletionUrl(urlStr) && response.headers.get('content-type')?.includes('text/event-stream'))
                ? await readBodyWithStreaming(response, streamHooks ?? {}, timing, attemptStartedAt)
                : await safeResponseJson(response);
            if (isChatCompletionUrl(urlStr)) {
                // TTFT 拆分埋点：headers = 首包响应头到达（≈排队+prefill 起点），
                // firstDelta = 第一段正文增量（≈真正的 TTFT，仅流式路径有），
                // total = 整包收完。定位「API 慢 20s」到底慢在 prefill 还是生成。
                const totalMs = Date.now() - attemptStartedAt;
                console.log(`⏱ [API timing] headers=${headersMs}ms${timing.firstDeltaMs != null ? ` firstDelta=${timing.firstDeltaMs}ms` : ''} total=${totalMs}ms${streamHooks ? ' streamed=1' : ''}`);
                appendDevDebugApiLog({
                    url: urlStr,
                    method: options.method,
                    status: response.status,
                    requestBody: options.body,
                    response: data,
                    durationMs: totalMs,
                    headersMs,
                    firstDeltaMs: timing.firstDeltaMs,
                });
                // 已解析响应是最可靠的日志来源：不再把记账成败押在异步
                // response.clone().text() 上。全局拦截器仍负责裸 fetch，并以 requestId 去重。
                recordApiCall({
                    requestId,
                    url: urlStr,
                    body: attemptOptions.body,
                    status: response.status,
                    ok: response.ok && completionOutcome(data).kind !== 'interrupted',
                    response: data,
                    meta: logMeta,
                    durationMs: totalMs,
                });
            }
            return data;
        } catch (e: any) {
            if (timedOut && isChatCompletionUrl(urlStr)) {
                throw new Error(`聊天请求等待超过 ${Math.ceil(timeoutMs / 1000)} 秒，未收到完整回复。`);
            }
            lastError = e;

            // AbortError（含 timeout）：是否重试看上层策略，先按可重试处理（网络层面）
            const isAbort = e?.name === 'AbortError' || /aborted|timeout/i.test(e?.message || '');

            // Network errors (fetch itself failed) are retryable
            if ((e?.name === 'TypeError' || isAbort) && attempt < automaticRetryLimit) {
                const delay = Math.pow(2, attempt) * 1000;
                log.warn(isAbort ? 'Timeout/Abort retry' : 'Network error retry', { attempt: attempt + 1, maxRetries: automaticRetryLimit, delay, message: e?.message });
                await new Promise(r => setTimeout(r, delay));
                continue;
            }

            // For HTML/parse errors on non-ok responses during retry, continue
            if (attempt < automaticRetryLimit && e?.message?.includes('API返回了HTML')) {
                const delay = Math.pow(2, attempt) * 1000;
                log.warn('HTML response retry', { attempt: attempt + 1, maxRetries, delay });
                await new Promise(r => setTimeout(r, delay));
                continue;
            }

            if (isChatCompletionUrl(urlStr)) {
                appendDevDebugApiLog({
                    url: urlStr,
                    method: options.method,
                    status: lastStatus,
                    requestBody: options.body,
                    error: e,
                    durationMs: Date.now() - attemptStartedAt,
                });
            }
            throw e;
        } finally {
            if (timeoutHandle) clearTimeout(timeoutHandle);
            if (abortFromCaller) options.signal?.removeEventListener('abort', abortFromCaller);
        }
    }

    throw lastError || new Error('API请求失败');
}

/**
 * Safely extract the AI content string from an OpenAI-compatible response.
 * Returns '' instead of crashing when the structure is unexpected.
 *
 */
export function extractContent(data: any): string {
    return readReply(publicMessageText(data?.choices?.[0]?.message)).trim();
}

/**
 * Robustly extract a JSON object from AI-generated text.
 *
 * Handles common Claude format instabilities:
 *  - JSON wrapped in ```json ... ``` code blocks
 *  - Extra prose before/after the JSON ("Here is the result: { ... }")
 *  - Trailing commas in arrays/objects  (common Claude habit)
 *  - Single-quoted strings
 *  - Unquoted keys
 *
 * Returns parsed object on success, null on total failure.
 */
/**
 * Walk through a JSON-ish string and re-escape `"` characters that appear inside
 * string values but weren't escaped by the LLM.
 *
 * Common with Claude when the content quotes a phrase ("还不够好" / "我爱你"等)
 * inside a string value — the inner quotes break JSON.parse because they look
 * like closing delimiters.
 *
 * Heuristic for distinguishing "real closing quote" vs "unescaped inner quote":
 *   A `"` is treated as closing iff the next non-whitespace char is one of
 *   , } ] : end-of-input. Otherwise it's an inner quote and gets \-escaped.
 */
function escapeUnescapedInnerQuotes(text: string): string {
    let result = '';
    let inString = false;
    let escaped = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];

        if (escaped) { result += ch; escaped = false; continue; }
        if (ch === '\\' && inString) { result += ch; escaped = true; continue; }

        if (ch === '"') {
            if (!inString) {
                inString = true;
                result += ch;
                continue;
            }
            // We're inside a string. Look ahead to decide: closing or inner?
            let j = i + 1;
            while (j < text.length && /[ \t\r\n]/.test(text[j])) j++;
            const next = j < text.length ? text[j] : '';
            // Closing iff next meaningful char is one of , } ] : or EOF
            if (next === '' || next === ',' || next === '}' || next === ']' || next === ':') {
                inString = false;
                result += ch;
            } else {
                // Inner unescaped quote → escape it
                result += '\\"';
            }
            continue;
        }

        result += ch;
    }

    return result;
}

/**
 * Attempt to repair truncated JSON by closing open strings, arrays, and objects.
 * Handles the common case where LLM output is cut off mid-string.
 */
function repairTruncatedJson(text: string): string | null {
    // If it already ends with } or ], it's probably not truncated in a way we can fix
    const trimmed = text.trim();
    if (trimmed.endsWith('}') || trimmed.endsWith(']')) return null; // let other steps handle it

    // Walk through the string tracking state
    let inString = false;
    let escaped = false;
    const stack: ('{' | '[')[] = [];
    let lastKeyValueEnd = 0; // position after last complete key:value pair

    for (let i = 0; i < trimmed.length; i++) {
        const ch = trimmed[i];

        if (escaped) { escaped = false; continue; }
        if (ch === '\\' && inString) { escaped = true; continue; }

        if (ch === '"') {
            inString = !inString;
            continue;
        }

        if (inString) continue;

        if (ch === '{') stack.push('{');
        else if (ch === '[') stack.push('[');
        else if (ch === '}') { if (stack.length > 0 && stack[stack.length - 1] === '{') stack.pop(); }
        else if (ch === ']') { if (stack.length > 0 && stack[stack.length - 1] === '[') stack.pop(); }

        // Track positions after complete values at object level
        if (stack.length === 1 && stack[0] === '{' && (ch === ',' || ch === '}')) {
            lastKeyValueEnd = i + 1;
        }
    }

    if (stack.length === 0) return null; // balanced, nothing to repair

    // Strategy: truncate to last complete key:value, then close brackets
    let repaired = '';
    if (lastKeyValueEnd > 0) {
        repaired = trimmed.slice(0, lastKeyValueEnd).replace(/,\s*$/, '');
    } else {
        // No complete key:value found at top level, try closing from current position
        repaired = trimmed;
        // If we're in an open string, close it
        if (inString) repaired += '"';
    }

    // Close remaining open brackets in reverse order
    for (let i = stack.length - 1; i >= 0; i--) {
        repaired += stack[i] === '{' ? '}' : ']';
    }

    return repaired;
}

export function extractJson(raw: string): any | null {
    if (!raw) return null;

    // 1. Strip markdown code fences
    let text = raw
        .replace(/^```(?:json|JSON)?\s*\n?/gm, '')
        .replace(/\n?```\s*$/gm, '')
        .trim();

    // 2. Try direct parse first (fast path)
    try { return JSON.parse(text); } catch {}

    // 3. Extract the outermost { ... } or [ ... ]
    const objMatch = text.match(/(\{[\s\S]*\})/);
    const arrMatch = text.match(/(\[[\s\S]*\])/);
    // Prefer whichever starts earlier in the text
    let jsonStr = '';
    if (objMatch && arrMatch) {
        jsonStr = (text.indexOf(objMatch[1]) <= text.indexOf(arrMatch[1]))
            ? objMatch[1] : arrMatch[1];
    } else {
        jsonStr = objMatch?.[1] || arrMatch?.[1] || '';
    }

    if (!jsonStr) return null;

    // 4. Try parsing the extracted substring
    try { return JSON.parse(jsonStr); } catch {}

    // 5. Fix common AI formatting issues and retry
    let fixed = jsonStr
        // Trailing commas: ,} or ,]
        .replace(/,\s*([}\]])/g, '$1')
        // Single quotes → double quotes (careful with apostrophes in text)
        // Only replace quotes that look like JSON string delimiters
        .replace(/'/g, '"')
        // Unquoted keys:  { foo: "bar" } → { "foo": "bar" }
        .replace(/([{,]\s*)([a-zA-Z_]\w*)\s*:/g, '$1"$2":');

    try { return JSON.parse(fixed); } catch {}

    // 6. Try to repair unescaped inner quotes (LLM writes naked " inside a string value).
    // Common with Claude when the content quotes a phrase like 「埋一句"我爱你"」
    // — the inner " breaks JSON parsing because they're not \-escaped.
    const innerQuoteFixed = escapeUnescapedInnerQuotes(jsonStr);
    if (innerQuoteFixed && innerQuoteFixed !== jsonStr) {
        try { return JSON.parse(innerQuoteFixed); } catch {}
        try {
            return JSON.parse(innerQuoteFixed
                .replace(/,\s*([}\]])/g, '$1')
                .replace(/([{,]\s*)([a-zA-Z_]\w*)\s*:/g, '$1"$2":'));
        } catch {}
    }

    // 7. Try to repair truncated JSON (LLM hit max_tokens)
    // Find the first { and attempt to close any open strings/brackets
    const firstBrace = text.indexOf('{');
    if (firstBrace >= 0) {
        let truncated = text.slice(firstBrace);
        const repaired = repairTruncatedJson(truncated);
        if (repaired) {
            try { return JSON.parse(repaired); } catch {}
            // Also try with common fixes applied
            try {
                return JSON.parse(repaired
                    .replace(/,\s*([}\]])/g, '$1')
                    .replace(/([{,]\s*)([a-zA-Z_]\w*)\s*:/g, '$1"$2":'));
            } catch {}
            // Also try escaping inner quotes on the truncated-repaired version
            const repairedInnerFixed = escapeUnescapedInnerQuotes(repaired);
            if (repairedInnerFixed !== repaired) {
                try { return JSON.parse(repairedInnerFixed); } catch {}
            }
        }
    }

    // 8. Last resort: try to extract individual JSON objects if there are multiple
    // (AI sometimes outputs two JSON blocks, take the larger one)
    const allObjects = [...text.matchAll(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g)];
    if (allObjects.length > 0) {
        // Sort by length, try the longest first (most likely the full response)
        const sorted = allObjects.sort((a, b) => b[0].length - a[0].length);
        for (const m of sorted) {
            try {
                return JSON.parse(m[0].replace(/,\s*([}\]])/g, '$1'));
            } catch {}
            try {
                const fixedInner = escapeUnescapedInnerQuotes(m[0]);
                return JSON.parse(fixedInner.replace(/,\s*([}\]])/g, '$1'));
            } catch {}
        }
    }

    // 9. AI sometimes wraps the expected JSON in a wrapper object like {"result": {...}}
    // Try to find the first nested object value and return it
    for (const m of allObjects) {
        try {
            const parsed = JSON.parse(m[0].replace(/,\s*([}\]])/g, '$1'));
            const vals = Object.values(parsed);
            if (vals.length === 1 && typeof vals[0] === 'object' && vals[0] !== null) return vals[0];
        } catch {}
    }

    console.error('[extractJson] JSON 解析失败', { chars: raw.length });
    return null;
}
