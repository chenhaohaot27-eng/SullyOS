import type {
    ImageGenerationAspectRatio,
    ImageGenerationConfig,
    ImageGenerationProvider,
    ImageGenerationResolution,
} from '../types';

export const IMAGE_GENERATION_CONFIG_STORAGE_KEY = 'os_image_generation_config_v1';
export const IMAGE_GENERATION_CONFIG_CHANGED_EVENT = 'sullyos:image-generation-config-changed';

export const DEFAULT_IMAGE_GENERATION_CONFIG: Readonly<ImageGenerationConfig> = Object.freeze({
    version: 1,
    enabled: false,
    provider: 'gemini-native',
    baseUrl: 'https://generativelanguage.googleapis.com',
    apiKey: '',
    model: 'gemini-3-pro-image',
    defaultResolution: '2K',
    defaultAspectRatio: '1:1',
    allowReferenceImages: true,
    timeoutMs: 90_000,
});

const PROVIDERS = new Set<ImageGenerationProvider>(['gemini-native', 'openai-images']);
const RESOLUTIONS = new Set<ImageGenerationResolution>(['1K', '2K', '4K']);
const ASPECT_RATIOS = new Set<ImageGenerationAspectRatio>(['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16']);

const asTrimmedString = (value: unknown, fallback: string): string => (
    typeof value === 'string' ? value.trim() : fallback
);

export function normalizeImageGenerationConfig(value: unknown): ImageGenerationConfig {
    const source = value && typeof value === 'object' ? value as Partial<ImageGenerationConfig> : {};
    const timeout = typeof source.timeoutMs === 'number' && Number.isFinite(source.timeoutMs)
        ? Math.round(source.timeoutMs)
        : DEFAULT_IMAGE_GENERATION_CONFIG.timeoutMs;

    return {
        version: 1,
        enabled: source.enabled === true,
        provider: PROVIDERS.has(source.provider as ImageGenerationProvider)
            ? source.provider as ImageGenerationProvider
            : DEFAULT_IMAGE_GENERATION_CONFIG.provider,
        baseUrl: asTrimmedString(source.baseUrl, DEFAULT_IMAGE_GENERATION_CONFIG.baseUrl).replace(/\/+$/, ''),
        apiKey: asTrimmedString(source.apiKey, ''),
        model: asTrimmedString(source.model, DEFAULT_IMAGE_GENERATION_CONFIG.model),
        defaultResolution: RESOLUTIONS.has(source.defaultResolution as ImageGenerationResolution)
            ? source.defaultResolution as ImageGenerationResolution
            : DEFAULT_IMAGE_GENERATION_CONFIG.defaultResolution,
        defaultAspectRatio: ASPECT_RATIOS.has(source.defaultAspectRatio as ImageGenerationAspectRatio)
            ? source.defaultAspectRatio as ImageGenerationAspectRatio
            : DEFAULT_IMAGE_GENERATION_CONFIG.defaultAspectRatio,
        allowReferenceImages: source.allowReferenceImages !== false,
        timeoutMs: Math.min(300_000, Math.max(5_000, timeout)),
    };
}

export function loadImageGenerationConfig(storage: Pick<Storage, 'getItem'> = localStorage): ImageGenerationConfig {
    try {
        const raw = storage.getItem(IMAGE_GENERATION_CONFIG_STORAGE_KEY);
        return raw ? normalizeImageGenerationConfig(JSON.parse(raw)) : { ...DEFAULT_IMAGE_GENERATION_CONFIG };
    } catch {
        return { ...DEFAULT_IMAGE_GENERATION_CONFIG };
    }
}

function notifyConfigChanged(config: ImageGenerationConfig): void {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent<ImageGenerationConfig>(IMAGE_GENERATION_CONFIG_CHANGED_EVENT, {
        detail: { ...config, apiKey: '' },
    }));
}

export function saveImageGenerationConfig(
    value: unknown,
    storage: Pick<Storage, 'setItem'> = localStorage,
): ImageGenerationConfig {
    const config = normalizeImageGenerationConfig(value);
    storage.setItem(IMAGE_GENERATION_CONFIG_STORAGE_KEY, JSON.stringify(config));
    notifyConfigChanged(config);
    return config;
}

export function clearImageGenerationConfig(
    storage: Pick<Storage, 'removeItem'> = localStorage,
): ImageGenerationConfig {
    storage.removeItem(IMAGE_GENERATION_CONFIG_STORAGE_KEY);
    const config = { ...DEFAULT_IMAGE_GENERATION_CONFIG };
    notifyConfigChanged(config);
    return config;
}

/** Text/full backups intentionally follow the existing local API credential policy. */
export function exportImageGenerationConfig(): ImageGenerationConfig | undefined {
    try {
        return localStorage.getItem(IMAGE_GENERATION_CONFIG_STORAGE_KEY)
            ? loadImageGenerationConfig()
            : undefined;
    } catch {
        return undefined;
    }
}

/** Missing field in an old backup is a no-op; malformed fields normalize safely. */
export function importImageGenerationConfig(value: unknown): ImageGenerationConfig | undefined {
    if (value === undefined || value === null) return undefined;
    return saveImageGenerationConfig(value);
}
