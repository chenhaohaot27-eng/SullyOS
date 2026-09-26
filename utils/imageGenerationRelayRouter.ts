import type { ImageGenerationProvider } from '../types';

/** RelayRouter 中转服务的固定 host（仅该 host 触发 /v1 ↔ /v1beta 自动改写）。 */
export const RELAY_ROUTER_HOST = 'api.relayrouter.ai';

function hostOf(baseUrl: string): string {
    try {
        return new URL(baseUrl.trim()).hostname.toLowerCase();
    } catch {
        return '';
    }
}

/** Base URL 是否指向 RelayRouter（host 精确匹配，忽略大小写与末尾斜杠）。 */
export function isRelayRouterUrl(baseUrl: string): boolean {
    return hostOf(baseUrl) === RELAY_ROUTER_HOST;
}

/**
 * 切换接口模式时，仅对 RelayRouter 地址自动改写版本路径：
 * - 切到 gemini-native：尾部 /v1 → /v1beta
 * - 切到 openai-images：尾部 /v1beta → /v1
 * 其他 host（如官方 Google / OpenAI 端点）原样返回，绝不自动改写。
 * API Key 等其余配置由调用方保持不动。
 */
export function applyRelayRouterProviderSwitch(
    baseUrl: string,
    nextProvider: ImageGenerationProvider,
): string {
    const trimmed = baseUrl.trim();
    if (!trimmed || !isRelayRouterUrl(trimmed)) return baseUrl;
    const stripped = trimmed.replace(/\/+$/, '');
    if (nextProvider === 'gemini-native' && /\/v1$/i.test(stripped)) {
        return stripped.replace(/\/v1$/i, '/v1beta');
    }
    if (nextProvider === 'openai-images' && /\/v1beta$/i.test(stripped)) {
        return stripped.replace(/\/v1beta$/i, '/v1');
    }
    return baseUrl;
}
