import type { APIConfig } from '../types';
import { normalizeApiBaseUrl, normalizeApiCredential, normalizeApiModel, normalizeChatApiFormat } from './apiConfigNormalize';
import { formatApiConnectionTestResult, type ApiConnectionTestResult } from './apiConnectionTest';

type ApiSettingsDraft = Partial<Pick<APIConfig,
    'baseUrl' | 'apiKey' | 'model' | 'apiFormat' | 'stream' | 'geminiNonStream' | 'temperature'>>;

/** The editable main API fields only. Credentials participate in comparison,
 * but this value must never be rendered, logged, or persisted as test metadata. */
export function normalizeApiSettingsDraft(config: ApiSettingsDraft) {
    return {
        baseUrl: normalizeApiBaseUrl(config.baseUrl),
        apiKey: normalizeApiCredential(config.apiKey),
        model: normalizeApiModel(config.model),
        apiFormat: normalizeChatApiFormat(config.apiFormat),
        stream: config.stream === true,
        geminiNonStream: config.geminiNonStream === true,
        temperature: typeof config.temperature === 'number' ? config.temperature : 0.85,
    };
}

export function apiSettingsDraftMatches(left: ApiSettingsDraft, right: ApiSettingsDraft): boolean {
    const a = normalizeApiSettingsDraft(left);
    const b = normalizeApiSettingsDraft(right);
    return (Object.keys(a) as Array<keyof typeof a>).every(key => Object.is(a[key], b[key]));
}

/** A successful synthetic probe never applies the draft configuration. */
export function formatApiSettingsTestResult(result: ApiConnectionTestResult, hasUnsavedChanges: boolean): string {
    if (result.status === 'success' && hasUnsavedChanges) {
        return `✅ 测试通过，保存后应用 — 模型回复：“${result.reply.slice(0, 60)}”`;
    }
    return formatApiConnectionTestResult(result);
}
