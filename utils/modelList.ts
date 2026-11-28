import type { ChatApiFormat } from '../types';

const MODEL_ID_KEYS = ['id', 'model', 'name', 'model_name', 'slug'] as const;

export interface ModelCatalogEntry {
    id: string;
    supportedEndpointTypes?: string[];
}

/**
 * 把第三方 /models 的松散返回值收敛成 UI 可以安全处理的字符串列表。
 * 有些兼容站会把整个模型对象（甚至 null、数字）塞进数组；这些值若直接
 * 进入选择器，公共前缀计算里的 slice/toLowerCase 会让整页崩溃。
 */
export function normalizeModelIds(value: unknown): string[] {
    return normalizeModelCatalog(value).map(model => model.id);
}

function normalizeModelCatalog(value: unknown): ModelCatalogEntry[] {
    if (!Array.isArray(value)) return [];
    const result = new Map<string, ModelCatalogEntry>();

    for (const item of value) {
        let candidate: unknown = item;
        const record = item && typeof item === 'object' ? item as Record<string, unknown> : undefined;
        if (record) {
            candidate = MODEL_ID_KEYS.map(key => record[key]).find(entry => typeof entry === 'string');
        }
        if (typeof candidate !== 'string') continue;
        const id = candidate.trim();
        if (!id) continue;
        const model: ModelCatalogEntry = result.get(id) ?? { id };
        if (Array.isArray(record?.supported_endpoint_types)) {
            const endpoints = record.supported_endpoint_types
                .filter((endpoint): endpoint is string => typeof endpoint === 'string')
                .map(endpoint => endpoint.trim().toLowerCase())
                .filter(Boolean);
            if (endpoints.length) {
                model.supportedEndpointTypes = [...new Set([...(model.supportedEndpointTypes ?? []), ...endpoints])];
            }
        }
        result.set(id, model);
    }

    return [...result.values()];
}

/** Extract common OpenAI-compatible and nested model-list response shapes. */
export function extractModelIds(data: unknown): string[] {
    return extractModelCatalog(data).map(model => model.id);
}

/** Capability metadata is advisory and belongs to the URL/token that returned it. */
export function extractModelCatalog(data: unknown): ModelCatalogEntry[] {
    if (Array.isArray(data)) return normalizeModelCatalog(data);
    if (!data || typeof data !== 'object') return [];

    const root = data as Record<string, unknown>;
    const nestedData = root.data && typeof root.data === 'object' && !Array.isArray(root.data)
        ? root.data as Record<string, unknown>
        : undefined;
    const candidates = [root.data, root.models, nestedData?.models, nestedData?.data];
    for (const candidate of candidates) {
        const models = normalizeModelCatalog(candidate);
        if (models.length > 0) return models;
    }
    return [];
}

export function getModelProtocolInfo(model: ModelCatalogEntry | undefined, currentFormat: ChatApiFormat) {
    const endpoints = model?.supportedEndpointTypes ?? [];
    const formats: ChatApiFormat[] = [];
    if (endpoints.includes('openai')) formats.push('openai-compatible');
    if (endpoints.includes('gemini')) formats.push('gemini-native');
    return {
        formats,
        // Missing, malformed, or unknown metadata cannot establish a mismatch.
        suggestedFormat: formats.length === 1 && formats[0] !== currentFormat ? formats[0] : null,
    };
}
