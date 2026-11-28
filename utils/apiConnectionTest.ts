import { completeChat, type ChatCompletionApiConfig } from './chatCompletionClient';
import { completionOutcome } from './completionOutcome';
import { extractContent } from './safeApi';

export const API_CONNECTION_TEST_MAX_TOKENS = 1024;
export const API_CONNECTION_TEST_PROMPT = 'Reply with exactly OK.';

export interface ApiConnectionTestResult {
    status: 'success' | 'limit' | 'empty' | 'error';
    reply: string;
    finishReason: string | null;
    error?: string;
}

/** A bounded synthetic request: no character history, tools or provider-specific parameters. */
export function buildApiConnectionTestBody(model: string, stream: boolean) {
    return {
        model,
        messages: [{ role: 'user', content: API_CONNECTION_TEST_PROMPT }],
        max_tokens: API_CONNECTION_TEST_MAX_TOKENS,
        stream,
    };
}

function failedTest(error: unknown, finishReason: string | null = null): ApiConnectionTestResult {
    return {
        status: 'error', reply: '', finishReason,
        error: String(error instanceof Error ? error.message : error || '未知错误').slice(0, 180),
    };
}

/** Receiving a response is distinct from receiving a complete, usable public reply. */
export function classifyApiConnectionTestResponse(data: unknown): ApiConnectionTestResult {
    const outcome = completionOutcome(data);
    if (outcome.kind === 'interrupted') {
        return failedTest(`模型回复未完整结束（${outcome.reason}）`, outcome.reason);
    }
    try {
        const reply = extractContent(data);
        return {
            status: outcome.kind === 'limit' ? 'limit' : reply ? 'success' : 'empty',
            reply,
            finishReason: outcome.reason,
        };
    } catch (error) {
        return failedTest(error, outcome.reason);
    }
}

export async function runApiConnectionTest(
    apiConfig: ChatCompletionApiConfig, stream: boolean,
): Promise<ApiConnectionTestResult> {
    try {
        const data = await completeChat(apiConfig, buildApiConnectionTestBody(apiConfig.model, stream), {
            maxRetries: 0,
            meta: { appName: '系统设置', purpose: 'API 连接测试' },
        });
        return classifyApiConnectionTestResponse(data);
    } catch (error) {
        return failedTest(error);
    }
}

export function formatApiConnectionTestResult(result: ApiConnectionTestResult): string {
    const preview = result.reply.slice(0, 60);
    switch (result.status) {
        case 'success': return `✅ 连接成功 — 模型回复：“${preview}”`;
        case 'limit': return '⚠️ 接口已响应，但达到输出上限，本次测试未完整完成。'
            + (preview ? `已收到部分正文：“${preview}”` : '未取得可用正文。');
        case 'empty': return '⚠️ 接口已响应，但未取得可用正文，连接测试尚未通过。';
        case 'error': return `❌ 连接失败：${result.error || '未知错误'}`;
    }
}
