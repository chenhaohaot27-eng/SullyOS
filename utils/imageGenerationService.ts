import type {
    ImageGenerationAspectRatio,
    ImageGenerationConfig,
    ImageGenerationProvider,
    ImageGenerationResolution,
} from '../types';
import { loadImageGenerationConfig, normalizeImageGenerationConfig } from './imageGenerationConfig';

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

export type ImageGenerationErrorCode =
    | 'DISABLED'
    | 'INVALID_CONFIG'
    | 'AUTH'
    | 'TIMEOUT'
    | 'CANCELLED'
    | 'REFERENCE_NOT_SUPPORTED'
    | 'EMPTY_RESPONSE'
    | 'NETWORK'
    | 'PROVIDER';

export class ImageGenerationError extends Error {
    constructor(
        public readonly code: ImageGenerationErrorCode,
        message: string,
        public readonly status?: number,
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

export interface ImageGenerationProviderAdapter {
    readonly provider: ImageGenerationProvider;
    readonly supportsReferenceImages: boolean;
    generate(context: AdapterContext): Promise<GeneratedImage[]>;
}

const DATA_URI_RE = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i;
const BASE64_RE = /^[a-z0-9+/]+={0,2}$/i;

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

async function parseProviderResponse(response: Response, apiKey: string): Promise<unknown> {
    let payload: unknown;
    try {
        payload = await response.json();
    } catch {
        payload = undefined;
    }
    if (response.ok) return payload;
    const detail = payload && typeof payload === 'object'
        ? (payload as any).error?.message || (payload as any).message || response.statusText
        : response.statusText;
    if (response.status === 401 || response.status === 403) {
        throw new ImageGenerationError('AUTH', '生图 API 鉴权失败，请检查 API Key', response.status);
    }
    throw new ImageGenerationError('PROVIDER', `生图 API 返回 HTTP ${response.status}：${sanitizeErrorText(detail, apiKey)}`, response.status);
}

function geminiEndpoint(config: ImageGenerationConfig): string {
    const base = config.baseUrl.replace(/\/+$/, '');
    if (/\/models\/[^/]+:generateContent$/i.test(base)) return base;
    const apiRoot = /\/v1(?:beta)?$/i.test(base) ? base : `${base}/v1beta`;
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
        const response = await fetchImpl(geminiEndpoint(config), {
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
        });
        const payload = await parseProviderResponse(response, config.apiKey);
        return normalizeImageGenerationResponse(payload);
    },
};

function openAiEndpoint(baseUrl: string): string {
    const base = baseUrl.replace(/\/+$/, '');
    return /\/images\/generations$/i.test(base) ? base : `${base}/images/generations`;
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
        const response = await fetchImpl(openAiEndpoint(config.baseUrl), {
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
        });
        const payload = await parseProviderResponse(response, config.apiKey);
        return normalizeImageGenerationResponse(payload);
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

export async function generatedImageToBlob(image: GeneratedImage, fetchImpl: typeof fetch = fetch): Promise<Blob> {
    if (image.source === 'url' && !isHttpUrl(image.url)) {
        throw new ImageGenerationError('EMPTY_RESPONSE', '图片地址不是可持久化的 HTTP(S) URL');
    }
    const response = await fetchImpl(image.url);
    if (!response.ok) throw new ImageGenerationError('NETWORK', `图片预览读取失败（HTTP ${response.status}）`, response.status);
    return response.blob();
}
