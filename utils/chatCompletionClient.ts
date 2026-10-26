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
 * 手动 ⚡ 续写时聊天历史最后一条是 assistant：OpenAI 兼容端点把它当 prefill/续写
 * 直接接受，但 Gemini Native 会拒收（HTTP 400 "Requests ending with a model turn
 * are not supported"）。这里由**调用方**（真实需要"继续模型回复"的主聊天路径）在
 * 末尾补一条合法的 user continuation——不是底层适配器静默改写，其它 apiFormat
 * 一律原样返回，现有行为零变化。
 */
export const GEMINI_NATIVE_CONTINUE_USER_MESSAGE = '[系统: 请接着上一条继续回复，保持角色语气]';

export function ensureGeminiNativeTailUserTurn<T extends { role: string; content?: unknown; tool_calls?: unknown }>(
  messages: T[],
  apiFormat?: string,
): T[] {
  if (apiFormat !== 'gemini-native' || messages.length === 0) return messages;
  let lastIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== 'system') { lastIndex = i; break; }
  }
  // 没有 user/model 回合（全是 system）→ 交给适配器的空 contents 校验报错，不在这里伪造。
  if (lastIndex < 0 || messages[lastIndex].role !== 'assistant') return messages;
  // 空 assistant（无正文且无 tool_calls）在 Gemini 转换里本就不会产生 model 回合，
  // 不需要补；有正文/有 tool_calls 的才需要 user continuation。
  const hasBody = (messages[lastIndex].content != null && String(messages[lastIndex].content) !== '')
    || Array.isArray(messages[lastIndex].tool_calls);
  if (!hasBody) return messages;
  return [...messages, { role: 'user', content: GEMINI_NATIVE_CONTINUE_USER_MESSAGE } as T];
}

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
        source: options.meta?.purpose,
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
