import type {
    ImageGenerationAspectRatio,
    ImageGenerationConfig,
    ImageGenerationProvider,
    ImageGenerationResolution,
} from '../types';
import { loadImageGenerationConfig, normalizeImageGenerationConfig } from './imageGenerationConfig';
import { withImageGenerationLogMeta } from './imageGenerationLogging';

export type ReferenceImageInput = string | {
    data?: string;
    url?: string;
    mimeType?: string;
    name?: string;
};

export interface GenerateImageOptions {
    prompt: string;
    referenceImages?: ReferenceImageInput[];
    resolution?: ImageGenerationResolution;
    aspectRatio?: ImageGenerationAspectRatio;
    style?: string;
    signal?: AbortSignal;
}

export interface GeneratedImage {
    source: 'url' | 'data-uri';
    url: string;
    mimeType: string;
    revisedPrompt?: string;
}

export interface ImageGenerationResult {
    provider: ImageGenerationProvider;
    model: string;
    images: GeneratedImage[];
    createdAt: number;
}

export type ImageModelCapability = 'confirmed' | 'likely' | 'unknown';

export interface AvailableImageModel {
    id: string;
    displayName: string;
    provider: ImageGenerationProvider;
    supportedMethods: string[];
    imageCapability: ImageModelCapability;
    protocolCompatibility: ImageGenerationProvider[];
}

export type ImageGenerationErrorCode =
    | 'DISABLED'
    | 'INVALID_CONFIG'
    | 'AUTH'
    | 'TIMEOUT'
    | 'CANCELLED'
    | 'REFERENCE_NOT_SUPPORTED'
    | 'EMPTY_RESPONSE'
    | 'NETWORK'
    | 'RATE_LIMIT'
    | 'MODELS_UNSUPPORTED'
    | 'PROVIDER';

export class ImageGenerationError extends Error {
    constructor(
        public readonly code: ImageGenerationErrorCode,
        message: string,
        public readonly status?: number,
        public readonly requestId?: string,
    ) {
        super(message);
        this.name = 'ImageGenerationError';
    }
}

interface InlineReferenceImage {
    mimeType: string;
    base64: string;
}

interface AdapterContext {
    config: ImageGenerationConfig;
    options: Required<Pick<GenerateImageOptions, 'prompt' | 'resolution' | 'aspectRatio'>> & GenerateImageOptions;
    references: InlineReferenceImage[];
    signal: AbortSignal;
    fetchImpl: typeof fetch;
}

interface ModelListAdapterContext {
    config: ImageGenerationConfig;
    signal: AbortSignal;
    fetchImpl: typeof fetch;
}

export interface ImageGenerationProviderAdapter {
    readonly provider: ImageGenerationProvider;
    readonly supportsReferenceImages: boolean;
    generate(context: AdapterContext): Promise<GeneratedImage[]>;
    listAvailableModels(context: ModelListAdapterContext): Promise<AvailableImageModel[]>;
}

const DATA_URI_RE = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i;
const BASE64_RE = /^[a-z0-9+/]+={0,2}$/i;
const IMAGE_MODEL_HINT_RE = /(?:^|[-_.\s])(image|imagen|gpt[-_.\s]*image|dall[-_.\s]*e|seedream|flux|banana)(?:$|[-_.\s\d])/i;
const IMAGE_METHOD_HINT_RE = /(generate.?image|image.?generation|text.?to.?image|predict.?image)/i;

function sanitizeErrorText(value: unknown, apiKey?: string): string {
    let text = typeof value === 'string' ? value : value instanceof Error ? value.message : '请求失败';
    if (apiKey) text = text.split(apiKey).join('[REDACTED]');
    return text.slice(0, 500);
}

function isHttpUrl(value: string): boolean {
    try {
        const protocol = new URL(value).protocol;
        return protocol === 'http:' || protocol === 'https:';
    } catch {
        return false;
    }
}

function normalizeBase64(value: string): string | null {
    const compact = value.replace(/\s/g, '');
    if (compact.length < 8 || !BASE64_RE.test(compact) || compact.length % 4 === 1) return null;
    return compact.padEnd(compact.length + ((4 - compact.length % 4) % 4), '=');
}

function imageFromValue(value: unknown, mimeType = 'image/png', revisedPrompt?: string): GeneratedImage | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    const dataMatch = DATA_URI_RE.exec(trimmed);
    if (dataMatch) {
        return { source: 'data-uri', url: `data:${dataMatch[1]};base64,${dataMatch[2].replace(/\s/g, '')}`, mimeType: dataMatch[1], revisedPrompt };
    }
    if (isHttpUrl(trimmed)) return { source: 'url', url: trimmed, mimeType, revisedPrompt };
    // blob: URLs are deliberately never normalized into a durable result.
    const base64 = normalizeBase64(trimmed);
    return base64 ? { source: 'data-uri', url: `data:${mimeType};base64,${base64}`, mimeType, revisedPrompt } : null;
}

export function normalizeImageGenerationResponse(payload: unknown): GeneratedImage[] {
    if (!payload || typeof payload !== 'object') return [];
    const root = payload as Record<string, any>;
    const images: GeneratedImage[] = [];
    const seen = new Set<string>();
    const add = (value: unknown, mimeType?: unknown, revisedPrompt?: unknown) => {
        const image = imageFromValue(
            value,
            typeof mimeType === 'string' && mimeType.startsWith('image/') ? mimeType : 'image/png',
            typeof revisedPrompt === 'string' ? revisedPrompt : undefined,
        );
        if (image && !seen.has(image.url)) {
            seen.add(image.url);
            images.push(image);
        }
    };

    const openAiItems = Array.isArray(root.data) ? root.data : Array.isArray(root.images) ? root.images : [];
    for (const item of openAiItems) {
        if (typeof item === 'string') { add(item); continue; }
        if (!item || typeof item !== 'object') continue;
        add(item.url, item.mime_type || item.mimeType, item.revised_prompt || item.revisedPrompt);
        add(item.b64_json, item.mime_type || item.mimeType, item.revised_prompt || item.revisedPrompt);
        add(item.base64, item.mime_type || item.mimeType, item.revised_prompt || item.revisedPrompt);
        add(item.image, item.mime_type || item.mimeType, item.revised_prompt || item.revisedPrompt);
    }

    const candidates = Array.isArray(root.candidates) ? root.candidates : [];
    for (const candidate of candidates) {
        const parts = candidate?.content?.parts;
        if (!Array.isArray(parts)) continue;
        for (const part of parts) {
            const inline = part?.inlineData || part?.inline_data;
            if (inline) add(inline.data, inline.mimeType || inline.mime_type);
            const file = part?.fileData || part?.file_data;
            if (file) add(file.fileUri || file.file_uri, file.mimeType || file.mime_type);
            add(part?.url, part?.mimeType || part?.mime_type);
        }
    }

    add(root.url, root.mimeType || root.mime_type);
    add(root.b64_json, root.mimeType || root.mime_type);
    add(root.base64, root.mimeType || root.mime_type);
    add(root.image, root.mimeType || root.mime_type);
    return images;
}

function stringArray(value: unknown): string[] {
    return Array.isArray(value)
        ? [...new Set(value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(item => item.trim()))]
        : [];
}

function explicitImageCapability(item: Record<string, any>, supportedMethods: string[]): boolean {
    if (supportedMethods.some(method => IMAGE_METHOD_HINT_RE.test(method))) return true;
    const modalities = stringArray(item.modalities || item.output_modalities || item.outputModalities);
    if (modalities.some(modality => /image/i.test(modality))) return true;
    const capabilities = item.capabilities;
    if (capabilities && typeof capabilities === 'object') {
        return Object.entries(capabilities).some(([key, enabled]) => enabled === true && /image/i.test(key));
    }
    return false;
}

function inferImageCapability(item: Record<string, any>, id: string, supportedMethods: string[]): ImageModelCapability {
    if (explicitImageCapability(item, supportedMethods)) return 'confirmed';
    return IMAGE_MODEL_HINT_RE.test(id) ? 'likely' : 'unknown';
}

export function normalizeAvailableImageModels(
    payload: unknown,
    provider: ImageGenerationProvider,
): AvailableImageModel[] {
    if (!payload || typeof payload !== 'object') return [];
    const root = payload as Record<string, any>;
    const source = Array.isArray(root.models) ? root.models : Array.isArray(root.data) ? root.data : [];
    const models: AvailableImageModel[] = [];
    const seen = new Set<string>();

    for (const raw of source) {
        if (!raw || typeof raw !== 'object') continue;
        const item = raw as Record<string, any>;
        const rawId = typeof item.id === 'string' ? item.id : typeof item.name === 'string' ? item.name : '';
        const id = rawId.trim().replace(/^models\//i, '');
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const supportedMethods = stringArray(
            item.supportedGenerationMethods || item.supported_generation_methods || item.supportedMethods || item.supported_methods,
        );
        models.push({
            id,
            displayName: String(item.displayName || item.display_name || item.name || item.id || id).replace(/^models\//i, ''),
            provider,
            supportedMethods,
            imageCapability: inferImageCapability(item, id, supportedMethods),
            protocolCompatibility: [provider],
        });
    }
    return models;
}

export function filterAvailableImageModels(
    models: AvailableImageModel[],
    options: { provider: ImageGenerationProvider; query?: string; imageOnly?: boolean },
): AvailableImageModel[] {
    const query = options.query?.trim().toLocaleLowerCase() || '';
    return models.filter(model => {
        if (model.provider !== options.provider) return false;
        if (options.imageOnly && model.imageCapability === 'unknown') return false;
        if (!query) return true;
        return `${model.id}\n${model.displayName}`.toLocaleLowerCase().includes(query);
    });
}

/** Empty/placeholder selections preserve the user's manual model ID. */
export function resolveImageModelSelection(selectedId: string | undefined, manualModel: string): string {
    return selectedId?.trim() || manualModel;
}

function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
}

async function toInlineReference(input: ReferenceImageInput, fetchImpl: typeof fetch, signal: AbortSignal): Promise<InlineReferenceImage> {
    const raw = typeof input === 'string' ? input : input.data || input.url || '';
    const explicitMime = typeof input === 'object' ? input.mimeType : undefined;
    const dataMatch = DATA_URI_RE.exec(raw.trim());
    if (dataMatch) return { mimeType: explicitMime || dataMatch[1], base64: dataMatch[2].replace(/\s/g, '') };

    const base64 = normalizeBase64(raw.trim());
    if (base64) return { mimeType: explicitMime || 'image/png', base64 };

    if (!isHttpUrl(raw) && !raw.startsWith('blob:')) {
        throw new ImageGenerationError('INVALID_CONFIG', '参考图必须是 URL、base64 或 data URI');
    }
    const response = await fetchImpl(raw, { signal });
    if (!response.ok) throw new ImageGenerationError('PROVIDER', `参考图读取失败（HTTP ${response.status}）`, response.status);
    const blob = await response.blob();
    return {
        mimeType: explicitMime || blob.type || response.headers.get('content-type')?.split(';')[0] || 'image/png',
        base64: bytesToBase64(new Uint8Array(await blob.arrayBuffer())),
    };
}

function composePrompt(prompt: string, style?: string): string {
    const cleanPrompt = prompt.trim();
    const cleanStyle = style?.trim();
    return cleanStyle ? `${cleanPrompt}\n\nStyle: ${cleanStyle}` : cleanPrompt;
}

function responseRequestId(response: Response, payload: unknown): string | undefined {
    const root = payload && typeof payload === 'object' ? payload as Record<string, any> : {};
    const value = response.headers.get('x-request-id')
        || response.headers.get('request-id')
        || response.headers.get('x-goog-request-id')
        || root.request_id
        || root.requestId
        || root.error?.request_id
        || root.error?.requestId;
    return typeof value === 'string' && value.trim() ? value.trim().slice(0, 160) : undefined;
}

function withRequestId(message: string, requestId?: string): string {
    return requestId ? `${message}（Request ID: ${requestId}）` : message;
}

async function parseProviderResponse(
    response: Response,
    apiKey: string,
    operation: 'generate' | 'list-models' = 'generate',
): Promise<unknown> {
    let payload: unknown;
    try {
        payload = await response.json();
    } catch {
        payload = undefined;
    }
    if (response.ok) return payload;
    const rawDetail = payload && typeof payload === 'object'
        ? (payload as any).error?.message || (payload as any).message || response.statusText
        : response.statusText;
    const detail = sanitizeErrorText(rawDetail, apiKey);
    const requestId = responseRequestId(response, payload);
    if (response.status === 401 || response.status === 403) {
        throw new ImageGenerationError('AUTH', withRequestId('生图 API 鉴权失败，请检查 API Key', requestId), response.status, requestId);
    }
    if (response.status === 429 || /(负载已饱和|稍后再试|rate[\s_-]*limit|too many requests|quota exceeded)/i.test(detail)) {
        const message = '当前模型线路繁忙。你可以稍后重试，或刷新模型列表后切换其他生图模型。';
        throw new ImageGenerationError('RATE_LIMIT', withRequestId(message, requestId), response.status, requestId);
    }
    if (operation === 'list-models' && (response.status === 404 || response.status === 405 || response.status === 501)) {
        const message = '当前中转站不支持模型列表接口，仍可手动填写模型 ID';
        throw new ImageGenerationError('MODELS_UNSUPPORTED', withRequestId(message, requestId), response.status, requestId);
    }
    throw new ImageGenerationError('PROVIDER', withRequestId(`生图 API 返回 HTTP ${response.status}：${detail}`, requestId), response.status, requestId);
}

function geminiApiRoot(baseUrl: string): string {
    let base = baseUrl.replace(/\/+$/, '');
    base = base.replace(/\/models\/[^/]+:generateContent$/i, '').replace(/\/models$/i, '');
    return /\/v1(?:beta)?$/i.test(base) ? base : `${base}/v1beta`;
}

function openAiApiRoot(baseUrl: string): string {
    return baseUrl.replace(/\/+$/, '').replace(/\/images\/generations$/i, '').replace(/\/models$/i, '');
}

export function buildImageGenerationModelsEndpoint(config: Pick<ImageGenerationConfig, 'provider' | 'baseUrl'>): string {
    const apiRoot = config.provider === 'gemini-native' ? geminiApiRoot(config.baseUrl) : openAiApiRoot(config.baseUrl);
    return `${apiRoot}/models`;
}

function geminiEndpoint(config: ImageGenerationConfig): string {
    const base = config.baseUrl.replace(/\/+$/, '');
    if (/\/models\/[^/]+:generateContent$/i.test(base)) return base;
    const apiRoot = geminiApiRoot(base);
    return `${apiRoot}/models/${encodeURIComponent(config.model)}:generateContent`;
}

export const geminiNativeAdapter: ImageGenerationProviderAdapter = {
    provider: 'gemini-native',
    supportsReferenceImages: true,
    async generate({ config, options, references, signal, fetchImpl }) {
        const parts: any[] = [{ text: composePrompt(options.prompt, options.style) }];
        for (const reference of references) {
            parts.push({ inlineData: { mimeType: reference.mimeType, data: reference.base64 } });
        }
        const response = await fetchImpl(geminiEndpoint(config), withImageGenerationLogMeta({
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.apiKey },
            body: JSON.stringify({
                contents: [{ role: 'user', parts }],
                generationConfig: {
                    responseModalities: ['TEXT', 'IMAGE'],
                    imageConfig: { aspectRatio: options.aspectRatio, imageSize: options.resolution },
                },
            }),
            signal,
        }, {
            operation: 'generate',
            provider: config.provider,
            model: config.model,
            resolution: options.resolution,
            aspectRatio: options.aspectRatio,
            referenceImageCount: references.length,
        }));
        const payload = await parseProviderResponse(response, config.apiKey);
        return normalizeImageGenerationResponse(payload);
    },
    async listAvailableModels({ config, signal, fetchImpl }) {
        const response = await fetchImpl(buildImageGenerationModelsEndpoint(config), withImageGenerationLogMeta({
            method: 'GET',
            headers: { 'x-goog-api-key': config.apiKey },
            signal,
        }, { operation: 'list-models', provider: config.provider }));
        const payload = await parseProviderResponse(response, config.apiKey, 'list-models');
        return normalizeAvailableImageModels(payload, config.provider);
    },
};

function openAiEndpoint(baseUrl: string): string {
    const base = baseUrl.replace(/\/+$/, '');
    return /\/images\/generations$/i.test(base) ? base : `${openAiApiRoot(base)}/images/generations`;
}

function openAiSize(resolution: ImageGenerationResolution, aspectRatio: ImageGenerationAspectRatio): string {
    const base = resolution === '4K' ? 4096 : resolution === '2K' ? 2048 : 1024;
    const [widthRatio, heightRatio] = aspectRatio.split(':').map(Number);
    if (widthRatio === heightRatio) return `${base}x${base}`;
    const long = Math.round((base * Math.max(widthRatio, heightRatio) / Math.min(widthRatio, heightRatio)) / 64) * 64;
    return widthRatio > heightRatio ? `${long}x${base}` : `${base}x${long}`;
}

export const openAiImagesAdapter: ImageGenerationProviderAdapter = {
    provider: 'openai-images',
    supportsReferenceImages: false,
    async generate({ config, options, signal, fetchImpl }) {
        const response = await fetchImpl(openAiEndpoint(config.baseUrl), withImageGenerationLogMeta({
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
            body: JSON.stringify({
                model: config.model,
                prompt: composePrompt(options.prompt, options.style),
                n: 1,
                size: openAiSize(options.resolution, options.aspectRatio),
                response_format: 'b64_json',
            }),
            signal,
        }, {
            operation: 'generate',
            provider: config.provider,
            model: config.model,
            resolution: options.resolution,
            aspectRatio: options.aspectRatio,
            referenceImageCount: 0,
        }));
        const payload = await parseProviderResponse(response, config.apiKey);
        return normalizeImageGenerationResponse(payload);
    },
    async listAvailableModels({ config, signal, fetchImpl }) {
        const response = await fetchImpl(buildImageGenerationModelsEndpoint(config), withImageGenerationLogMeta({
            method: 'GET',
            headers: { Authorization: `Bearer ${config.apiKey}` },
            signal,
        }, { operation: 'list-models', provider: config.provider }));
        const payload = await parseProviderResponse(response, config.apiKey, 'list-models');
        return normalizeAvailableImageModels(payload, config.provider);
    },
};

const ADAPTERS: Record<ImageGenerationProvider, ImageGenerationProviderAdapter> = {
    'gemini-native': geminiNativeAdapter,
    'openai-images': openAiImagesAdapter,
};

export interface ImageGenerationServiceDependencies {
    fetchImpl?: typeof fetch;
    loadConfig?: () => ImageGenerationConfig;
}

export class ImageGenerationService {
    private readonly fetchImpl: typeof fetch;
    private readonly loadConfig: () => ImageGenerationConfig;

    constructor(dependencies: ImageGenerationServiceDependencies = {}) {
        this.fetchImpl = dependencies.fetchImpl || fetch.bind(globalThis);
        this.loadConfig = dependencies.loadConfig || loadImageGenerationConfig;
    }

    async listAvailableModels(configOverride: ImageGenerationConfig): Promise<AvailableImageModel[]> {
        const config = normalizeImageGenerationConfig(configOverride);
        if (!config.baseUrl || !config.apiKey) {
            throw new ImageGenerationError('INVALID_CONFIG', '刷新模型前，请填写 Base URL 和 API Key');
        }

        const controller = new AbortController();
        let timedOut = false;
        const timeoutId = setTimeout(() => { timedOut = true; controller.abort(); }, config.timeoutMs);
        try {
            return await ADAPTERS[config.provider].listAvailableModels({
                config,
                signal: controller.signal,
                fetchImpl: this.fetchImpl,
            });
        } catch (error) {
            if (error instanceof ImageGenerationError) throw error;
            if (timedOut) throw new ImageGenerationError('TIMEOUT', `模型列表请求超过 ${Math.round(config.timeoutMs / 1000)} 秒`);
            throw new ImageGenerationError('NETWORK', `模型列表请求失败：${sanitizeErrorText(error, config.apiKey)}`);
        } finally {
            clearTimeout(timeoutId);
        }
    }

    async generateImage(options: GenerateImageOptions, configOverride?: ImageGenerationConfig): Promise<ImageGenerationResult> {
        const config = normalizeImageGenerationConfig(configOverride || this.loadConfig());
        const prompt = options.prompt?.trim();
        if (!config.enabled) throw new ImageGenerationError('DISABLED', '生图 API 尚未启用');
        if (!config.baseUrl || !config.apiKey || !config.model || !prompt) {
            throw new ImageGenerationError('INVALID_CONFIG', '请填写完整的生图 URL、API Key、模型和提示词');
        }

        const referenceInputs = options.referenceImages || [];
        if (referenceInputs.length > 5) throw new ImageGenerationError('INVALID_CONFIG', '参考图最多支持 5 张');
        if (referenceInputs.length && !config.allowReferenceImages) {
            throw new ImageGenerationError('REFERENCE_NOT_SUPPORTED', '当前配置已禁止参考图');
        }
        const adapter = ADAPTERS[config.provider];
        if (referenceInputs.length && !adapter.supportsReferenceImages) {
            throw new ImageGenerationError('REFERENCE_NOT_SUPPORTED', '当前接口模式不支持参考图，请改用 Gemini Native');
        }

        const controller = new AbortController();
        let timedOut = false;
        const onAbort = () => controller.abort(options.signal?.reason);
        if (options.signal?.aborted) onAbort();
        else options.signal?.addEventListener('abort', onAbort, { once: true });
        const timeoutId = setTimeout(() => { timedOut = true; controller.abort(); }, config.timeoutMs);

        try {
            const references = await Promise.all(referenceInputs.map(input => toInlineReference(input, this.fetchImpl, controller.signal)));
            const normalizedOptions = {
                ...options,
                prompt,
                resolution: options.resolution || config.defaultResolution,
                aspectRatio: options.aspectRatio || config.defaultAspectRatio,
            };
            const images = await adapter.generate({ config, options: normalizedOptions, references, signal: controller.signal, fetchImpl: this.fetchImpl });
            if (!images.length) throw new ImageGenerationError('EMPTY_RESPONSE', '生图 API 响应中没有图片');
            return { provider: config.provider, model: config.model, images, createdAt: Date.now() };
        } catch (error) {
            if (error instanceof ImageGenerationError) throw error;
            if (options.signal?.aborted) throw new ImageGenerationError('CANCELLED', '生图请求已取消');
            if (timedOut) throw new ImageGenerationError('TIMEOUT', `生图请求超过 ${Math.round(config.timeoutMs / 1000)} 秒`);
            throw new ImageGenerationError('NETWORK', `生图请求失败：${sanitizeErrorText(error, config.apiKey)}`);
        } finally {
            clearTimeout(timeoutId);
            options.signal?.removeEventListener('abort', onAbort);
        }
    }
}

export const imageGenerationService = new ImageGenerationService();

/** Future apps should import this function; React components must not call providers directly. */
export const generateImage = (options: GenerateImageOptions): Promise<ImageGenerationResult> => (
    imageGenerationService.generateImage(options)
);

/** Settings and future callers share provider adapters; UI components must not fetch /models directly. */
export const listAvailableModels = (config: ImageGenerationConfig): Promise<AvailableImageModel[]> => (
    imageGenerationService.listAvailableModels(config)
);

export async function generatedImageToBlob(image: GeneratedImage, fetchImpl: typeof fetch = fetch): Promise<Blob> {
    if (image.source === 'url' && !isHttpUrl(image.url)) {
        throw new ImageGenerationError('EMPTY_RESPONSE', '图片地址不是可持久化的 HTTP(S) URL');
    }
    const response = await fetchImpl(image.url);
    if (!response.ok) throw new ImageGenerationError('NETWORK', `图片预览读取失败（HTTP ${response.status}）`, response.status);
    return response.blob();
}
