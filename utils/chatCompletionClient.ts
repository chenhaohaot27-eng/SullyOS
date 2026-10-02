import type { APIConfig } from '../types';
import type { ApiCallMeta } from './apiCallLog';
import { normalizeApiBaseUrl, normalizeChatApiFormat } from './apiConfigNormalize';
import { getGeminiProviderState, requestGeminiNativeChat } from './geminiNativeChat';
import { safeFetchJson, type StreamHooks } from './safeApi';

export interface ChatCompletionOptions {
  signal?: AbortSignal;
  streamHooks?: StreamHooks;
  /** 仅供单元测试或受控运行环境注入；产品路径默认使用 global fetch。 */
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  timeoutMs?: number;
  meta?: ApiCallMeta;
}

export type ChatCompletionApiConfig = Pick<APIConfig, 'baseUrl' | 'apiKey' | 'model'>
  & Partial<Pick<APIConfig, 'apiFormat'>>;

/**
 * 工具续跑时，Gemini message 上挂着不可枚举的原始 parts/signature 状态；对象展开会丢掉它。
 * OpenAI 路径维持原来的占位 content 形状，Gemini 路径则必须沿用原对象。
 */
export function buildAssistantToolFollowUpMessage(
  responseMessage: Record<string, any>,
  toolCalls: any[],
): Record<string, any> {
  if (getGeminiProviderState(responseMessage)) return responseMessage;
  return {
    role: 'assistant',
    content: responseMessage?.content || '(调用工具中)',
    tool_calls: toolCalls,
  };
}

export async function completeChat(
  apiConfig: ChatCompletionApiConfig,
  openAiShapedBody: Record<string, any>,
  options: ChatCompletionOptions = {},
): Promise<any> {
  const body = openAiShapedBody.model
    ? openAiShapedBody
    : { ...openAiShapedBody, model: apiConfig.model };
  if (normalizeChatApiFormat(apiConfig.apiFormat) === 'gemini-native') {
    return requestGeminiNativeChat(
      normalizeApiBaseUrl(apiConfig.baseUrl),
      apiConfig.apiKey,
      String(body.model || apiConfig.model),
      body,
      {
        signal: options.signal,
        streamHooks: body.stream === false ? undefined : options.streamHooks,
        fetchImpl: options.fetchImpl,
      },
    );
  }

  return safeFetchJson(
    `${normalizeApiBaseUrl(apiConfig.baseUrl)}/chat/completions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiConfig.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: options.signal,
    },
    options.maxRetries ?? 2,
    options.timeoutMs ?? 0,
    options.meta,
    options.streamHooks,
  );
}
