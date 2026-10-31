import type {
    ImageGenerationAspectRatio,
    ImageGenerationConfig,
    ImageGenerationProvider,
    ImageGenerationResolution,
    VisualIdentity,
    VisualIdentityReference,
} from '../types';
import { loadImageGenerationConfig, normalizeImageGenerationConfig } from './imageGenerationConfig';
import { withImageGenerationLogMeta } from './imageGenerationLogging';
import { normalizeVisualIdentity, resolveVisualIdentityReferences } from './visualIdentity';
import { buildVisualIdentityPrompt } from './visualIdentityPrompt';
import { applyPhotoSemantics } from './photoSemantics';
import { getActiveVisualIdentity } from './visualIdentityPresets';

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
    /** 角色 ID，用于自动注入 visualIdentity 参考图和身份约束提示词 */
    characterId?: string;
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

/** 无鉴权模式（authMode === 'none'）下完全不携带鉴权头，避免 `Bearer undefined` 等伪造值。 */
function bearerAuthHeaders(config: Pick<ImageGenerationConfig, 'apiKey' | 'authMode'>): Record<string, string> {
    if (config.authMode === 'none') return {};
    const key = config.apiKey.trim();
    return key ? { Authorization: `Bearer ${key}` } : {};
}

function geminiAuthHeaders(config: Pick<ImageGenerationConfig, 'apiKey' | 'authMode'>): Record<string, string> {
    if (config.authMode === 'none') return {};
    const key = config.apiKey.trim();
    return key ? { 'x-goog-api-key': key } : {};
}

/**
 * HTTPS 页面访问 HTTP 接口会被浏览器混合内容策略拦截；本地 HTTP 生图接口失败时
 * 明确提示检查连接安全/HTTPS 代理/CORS，而不是误报成密钥错误。
 */
function networkFailureHint(baseUrl: string): string {
    let hint = '';
    try {
        const insecureHttp = new URL(baseUrl).protocol === 'http:';
        const securePage = typeof window !== 'undefined' && window.location?.protocol === 'https:';
        if (insecureHttp && securePage) {
            hint = '；当前页面为 HTTPS，浏览器会拦截 HTTP 接口（混合内容限制），请检查连接安全、HTTPS 代理或 CORS 配置，或改用 HTTPS 地址';
        }
    } catch { /* 保持无提示 */ }
    return hint;
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
        // 保留供应商原始错误（Key 无效 / 模型未授权 / Organization Verification / 权限不足），便于区分具体原因
        const authHint = detail ? `（${detail}）` : '';
        throw new ImageGenerationError('AUTH', withRequestId(`生图 API 鉴权失败，请检查 API Key${authHint}`, requestId), response.status, requestId);
    }
    if (response.status === 429 || /(负载已饱和|稍后再试|rate[\s_-]*limit|too many requests|quota exceeded)/i.test(detail)) {
        const message = /quota|billing|insufficient|额度/i.test(detail)
            ? '生图 API 额度不足或已触发限流，请检查账户额度与限流策略，或稍后重试 / 切换其他生图模型。'
            : '当前模型线路繁忙。你可以稍后重试，或刷新模型列表后切换其他生图模型。';
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
            headers: { 'Content-Type': 'application/json', ...geminiAuthHeaders(config) },
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
            headers: geminiAuthHeaders(config),
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

// ─── OpenAI 官方 GPT Image 模型（gpt-image-*）独立适配参数 ─────────────────────
// gpt-image-2.5-flare / gpt-image-2.5-sunburst / gpt-image-1 等官方模型走新版
// Images API 参数：不发送 response_format，改用 output_format，尺寸按官方约束映射。

/** OpenAI 官方 Base URL（设置页与文档共用）。 */
export const OFFICIAL_GPT_IMAGES_BASE_URL = 'https://api.openai.com/v1';
/** 新建 GPT Images 预设的推荐默认模型。 */
export const DEFAULT_GPT_IMAGES_MODEL = 'gpt-image-2.5-flare';

/** 官方 gpt-image-* 模型 ID（gpt-image-1、gpt-image-2.5-flare、gpt-image-2.5-sunburst 等）。 */
export const OFFICIAL_GPT_IMAGE_MODEL_RE = /^gpt-image-[a-z0-9][a-z0-9.-]*$/i;

export function isOfficialGptImageModel(model: string): boolean {
    return OFFICIAL_GPT_IMAGE_MODEL_RE.test(model.trim());
}

/** 官方支持的宽高比范围：2:3 ~ 3:2。 */
export const GPT_IMAGE_MIN_ASPECT_RATIO = 2 / 3;
export const GPT_IMAGE_MAX_ASPECT_RATIO = 3 / 2;
/** 单边长度上限。 */
export const GPT_IMAGE_MAX_SIDE = 3840;
/** 总像素上限（与 3840×2160 一致）。 */
export const GPT_IMAGE_MAX_PIXELS = 8_294_400;
/** 官方推荐尺寸（优先命中）。 */
export const GPT_IMAGE_RECOMMENDED_SIZES: readonly string[] = ['1024x1024', '1536x1024', '1024x1536'];

export interface GptImageSize {
    width: number;
    height: number;
    /** 宽高比超出官方 2:3~3:2 范围（如 16:9），已收敛到最近可用比例。 */
    aspectRatioClamped: boolean;
    /** 超过 2560×1440 的尺寸属于官方实验性范围。 */
    experimental: boolean;
}

const floorToMultipleOf16 = (value: number): number => Math.max(16, Math.floor(value / 16) * 16);

/**
 * GPT Image 2.5 尺寸映射（独立于旧版 DALL-E 4096 算法）：
 * - 1K/2K/4K 以长边 1024/2048/3840 为目标，宽高均为 16 的倍数；
 * - 1K 的 1:1、3:2、2:3 会自然命中官方推荐尺寸 1024x1024 / 1536x1024 / 1024x1536；
 * - 宽高比收敛到官方 2:3~3:2；单边 ≤ 3840；总像素 ≤ 8,294,400（4K 方图会缩到 2880×2880）。
 */
export function resolveGptImageSize(
    resolution: ImageGenerationResolution,
    aspectRatio: ImageGenerationAspectRatio,
): GptImageSize {
    const [ratioWidth, ratioHeight] = aspectRatio.split(':').map(Number);
    const rawRatio = ratioWidth / ratioHeight;
    const ratio = Math.min(GPT_IMAGE_MAX_ASPECT_RATIO, Math.max(GPT_IMAGE_MIN_ASPECT_RATIO, rawRatio));
    // 官方 1K/2K/4K 家族以短边 1024/2048/3840 为基准（如 1536x1024、3072x2048、3840x2560）
    const shortEdge = resolution === '4K' ? 3840 : resolution === '2K' ? 2048 : 1024;
    let width = ratio >= 1 ? shortEdge * ratio : shortEdge;
    let height = ratio >= 1 ? shortEdge : shortEdge / ratio;
    // 总像素超限时先按比例整体缩放，再向下取 16 的倍数，保证不突破像素上限
    const scale = Math.sqrt(Math.min(1, GPT_IMAGE_MAX_PIXELS / (width * height)));
    width = floorToMultipleOf16(Math.min(GPT_IMAGE_MAX_SIDE, width * scale));
    height = floorToMultipleOf16(Math.min(GPT_IMAGE_MAX_SIDE, height * scale));
    // 取整后比例越界：优先轻微放大短边（不超边长/像素上限），否则收窄长边
    let guard = 8;
    while (width / height > GPT_IMAGE_MAX_ASPECT_RATIO && guard-- > 0) {
        if (height + 16 <= GPT_IMAGE_MAX_SIDE && width * (height + 16) <= GPT_IMAGE_MAX_PIXELS) height += 16;
        else width -= 16;
    }
    guard = 8;
    while (width / height < GPT_IMAGE_MIN_ASPECT_RATIO && guard-- > 0) {
        if (width + 16 <= GPT_IMAGE_MAX_SIDE && (width + 16) * height <= GPT_IMAGE_MAX_PIXELS) width += 16;
        else height -= 16;
    }
    return {
        width,
        height,
        aspectRatioClamped: rawRatio > GPT_IMAGE_MAX_ASPECT_RATIO || rawRatio < GPT_IMAGE_MIN_ASPECT_RATIO,
        experimental: width > 2560 || height > 1440,
    };
}

/** 参考图上传文件名保留原始 MIME 对应扩展名（默认 png）。 */
const MIME_TYPE_FILE_EXTENSIONS: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
};

function imageFileExtension(mimeType: string): string {
    return MIME_TYPE_FILE_EXTENSIONS[mimeType.split(';')[0].trim().toLowerCase()] || 'png';
}

export const openAiImagesAdapter: ImageGenerationProviderAdapter = {
    provider: 'openai-images',
    supportsReferenceImages: false,
    async generate({ config, options, signal, fetchImpl }) {
        const response = await fetchImpl(openAiEndpoint(config.baseUrl), withImageGenerationLogMeta({
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...bearerAuthHeaders(config) },
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
            headers: bearerAuthHeaders(config),
            signal,
        }, { operation: 'list-models', provider: config.provider }));
        const payload = await parseProviderResponse(response, config.apiKey, 'list-models');
        return normalizeAvailableImageModels(payload, config.provider);
    },
};

export const gptImagesAdapter: ImageGenerationProviderAdapter = {
    provider: 'gpt-images',
    supportsReferenceImages: true,
    async generate({ config, options, references, signal, fetchImpl }) {
        const hasReferences = references.length > 0;
        // OpenAI 官方 gpt-image-* 模型走新版 Images API 参数：
        // 不发送 response_format，改用 output_format（默认 png），尺寸按 GPT Image 2.5 官方约束映射。
        // 非 gpt-image-* 旧模型（dall-e-3 等）保持原有字段，不破坏第三方兼容路径。
        const official = isOfficialGptImageModel(config.model);
        const officialSize = official ? resolveGptImageSize(options.resolution, options.aspectRatio) : null;
        const sizeValue = officialSize
            ? `${officialSize.width}x${officialSize.height}`
            : openAiSize(options.resolution, options.aspectRatio);

        // GPT with reference images: use /images/edits with multipart/form-data
        if (hasReferences) {
            const editsEndpoint = openAiEndpoint(config.baseUrl).replace(/\/images\/generations$/i, '/images/edits');
            const formData = new FormData();

            // Add model and prompt
            formData.append('model', config.model);
            formData.append('prompt', composePrompt(options.prompt, options.style));
            formData.append('n', '1');
            formData.append('size', sizeValue);
            if (official) formData.append('output_format', 'png');
            else formData.append('response_format', 'b64_json');

            // Add reference images as image files.
            // 官方 gpt-image 模型按官方文档：单图用 image 字段，多图用 image[] 字段；
            // 文件名保留原始 MIME 对应扩展名；multipart Content-Type 由运行时自动生成 boundary。
            references.forEach((reference, index) => {
                const blob = new Blob(
                    [Uint8Array.from(atob(reference.base64), c => c.charCodeAt(0))],
                    { type: reference.mimeType },
                );
                const field = official && references.length > 1 ? 'image[]' : 'image';
                formData.append(field, blob, `reference_${index}.${imageFileExtension(reference.mimeType)}`);
            });

            const response = await fetchImpl(editsEndpoint, withImageGenerationLogMeta({
                method: 'POST',
                headers: bearerAuthHeaders(config),
                body: formData,
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
        }

        // GPT without reference images: use standard /images/generations
        const endpoint = openAiEndpoint(config.baseUrl);
        const response = await fetchImpl(endpoint, withImageGenerationLogMeta({
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...bearerAuthHeaders(config) },
            body: JSON.stringify(official ? {
                model: config.model,
                prompt: composePrompt(options.prompt, options.style),
                n: 1,
                size: sizeValue,
                output_format: 'png',
            } : {
                model: config.model,
                prompt: composePrompt(options.prompt, options.style),
                n: 1,
                size: sizeValue,
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
            headers: bearerAuthHeaders(config),
            signal,
        }, { operation: 'list-models', provider: config.provider }));
        const payload = await parseProviderResponse(response, config.apiKey, 'list-models');
        return normalizeAvailableImageModels(payload, config.provider);
    },
};

const ADAPTERS: Record<ImageGenerationProvider, ImageGenerationProviderAdapter> = {
    'gemini-native': geminiNativeAdapter,
    'openai-images': openAiImagesAdapter,
    'gpt-images': gptImagesAdapter,
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
        // 无鉴权模式（用户在预设中显式选择）允许空 Key；普通云端接口仍要求完整填写
        if (!config.baseUrl || (config.authMode !== 'none' && !config.apiKey)) {
            throw new ImageGenerationError('INVALID_CONFIG', '刷新模型前，请填写 Base URL 和 API Key（无鉴权本地接口需在预设中选择「无鉴权」）');
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
            throw new ImageGenerationError('NETWORK', `模型列表请求失败：${sanitizeErrorText(error, config.apiKey)}${networkFailureHint(config.baseUrl)}`);
        } finally {
            clearTimeout(timeoutId);
        }
    }

    async generateImage(options: GenerateImageOptions, configOverride?: ImageGenerationConfig): Promise<ImageGenerationResult> {
        const config = normalizeImageGenerationConfig(configOverride || this.loadConfig());
        const prompt = options.prompt?.trim();
        if (!config.enabled) throw new ImageGenerationError('DISABLED', '生图 API 尚未启用');
        // 无鉴权模式（用户在预设中显式选择）允许空 Key；普通云端接口空 Key 一律拒绝
        const noAuth = config.authMode === 'none';
        if (!config.baseUrl || (!noAuth && !config.apiKey) || !config.model || !prompt) {
            throw new ImageGenerationError('INVALID_CONFIG', noAuth
                ? '请填写完整的生图 URL、模型和提示词'
                : '请填写完整的生图 URL、API Key、模型和提示词');
        }

        // ─── 解析角色视觉身份（若提供 characterId） ─────────────────────────────────
        let visualIdentity: VisualIdentity | undefined;
        let identityReferences: Array<{ reference: VisualIdentityReference; blob: Blob }> = [];
        let identityPrompt = '';

        if (options.characterId) {
            try {
                const { DB } = await import('./db');
                const char = await DB.getCharacter(options.characterId);
                // Phase 2F：优先当前 active 形态预设，否则回退 legacy visualIdentity（行为不变）
                const activeVi = char ? getActiveVisualIdentity(char) : undefined;
                if (activeVi) {
                    visualIdentity = normalizeVisualIdentity(activeVi);
                    if (visualIdentity.enabled && visualIdentity.references.length > 0) {
                        identityReferences = await resolveVisualIdentityReferences(visualIdentity.references);
                        identityPrompt = buildVisualIdentityPrompt(visualIdentity);
                    }
                }
            } catch (e) {
                console.warn('[ImageGen] 视觉身份读取失败，继续生成（不带身份约束）:', e);
            }
        }

        // ─── 合并参考图：优先级 ① isPrimary 长期身份图 ② 临时参考图 ③ 其他长期身份图 ─────
        const tempReferences = options.referenceImages || [];
        const mergedReferences: ReferenceImageInput[] = [];
        const seenBlobRefs = new Set<string>();

        // ① 主要身份图（isPrimary）
        for (const { reference, blob } of identityReferences) {
            if (reference.isPrimary && !seenBlobRefs.has(reference.blobRef)) {
                seenBlobRefs.add(reference.blobRef);
                mergedReferences.push({
                    data: URL.createObjectURL(blob),
                    mimeType: blob.type,
                    name: `identity-primary-${reference.role}`,
                });
            }
        }

        // ② 临时参考图（本次调用传入）
        mergedReferences.push(...tempReferences);

        // ③ 其他长期身份图（非 isPrimary）
        for (const { reference, blob } of identityReferences) {
            if (!reference.isPrimary && !seenBlobRefs.has(reference.blobRef)) {
                seenBlobRefs.add(reference.blobRef);
                mergedReferences.push({
                    data: URL.createObjectURL(blob),
                    mimeType: blob.type,
                    name: `identity-${reference.role}`,
                });
            }
        }

        // 参考图总量截断（5 张上限）
        const finalReferences = mergedReferences.slice(0, 5);

        if (finalReferences.length > 5) throw new ImageGenerationError('INVALID_CONFIG', '参考图最多支持 5 张');
        if (finalReferences.length && !config.allowReferenceImages) {
            throw new ImageGenerationError('REFERENCE_NOT_SUPPORTED', '当前配置已禁止参考图');
        }

        const adapter = ADAPTERS[config.provider];

        // ─── Provider 行为：OpenAI 不支持参考图，但仍注入文字身份提示词；GPT 支持参考图 ─────────────
        // 检查必须在转换参考图之前，避免无效的网络请求
        let skipReferencesForProvider = false;
        if (finalReferences.length && !adapter.supportsReferenceImages) {
            const hasUserProvidedRefs = (options.referenceImages?.length || 0) > 0;
            if (config.provider === 'openai-images' && identityReferences.length > 0 && !hasUserProvidedRefs) {
                // OpenAI: 只对 identity 参考图跳过（用户未直接提供参考图的情况）
                // 这种情况下保留文字身份约束，跳过图片
                skipReferencesForProvider = true;
                console.info('[ImageGen] OpenAI provider 不支持参考图，已跳过视觉身份图片但保留身份文字描述');
            } else {
                // 其他情况：用户直接提供了参考图，或非 openai-images provider 不支持
                throw new ImageGenerationError('REFERENCE_NOT_SUPPORTED', '当前接口模式不支持参考图，请改用 Gemini Native 或 GPT Images');
            }
        }

        // ─── 合并 prompt：身份约束 + 原始 prompt ───────────────────────────────────
        const identityMergedPrompt = identityPrompt ? `${identityPrompt}\n\n${prompt}` : prompt;

        // ─── Phase 2E 摄影语义修正：只在末尾补充约束，不覆盖剧情原文 ──────────────
        // 视觉身份启用（或 prompt 自带拍照语义）时按生活照处理；commercial 请求不强压。
        const finalPrompt = applyPhotoSemantics(identityMergedPrompt, {
            identityActive: !!(visualIdentity?.enabled && visualIdentity.references.length > 0),
        });

        const controller = new AbortController();
        let timedOut = false;
        const onAbort = () => controller.abort(options.signal?.reason);
        if (options.signal?.aborted) onAbort();
        else options.signal?.addEventListener('abort', onAbort, { once: true });
        const timeoutId = setTimeout(() => { timedOut = true; controller.abort(); }, config.timeoutMs);

        try {
            const referencesToSend = skipReferencesForProvider ? [] : finalReferences;
            const references = await Promise.all(referencesToSend.map(input => toInlineReference(input, this.fetchImpl, controller.signal)));
            const normalizedOptions = {
                ...options,
                prompt: finalPrompt,
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
            throw new ImageGenerationError('NETWORK', `生图请求失败：${sanitizeErrorText(error, config.apiKey)}${networkFailureHint(config.baseUrl)}`);
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
