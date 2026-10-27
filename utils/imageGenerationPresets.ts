import type {
    ImageGenerationConfig,
    ImageGenerationPreset,
    ImageGenerationPresetStore,
} from '../types';
import {
    clearImageGenerationConfig,
    IMAGE_GENERATION_CONFIG_STORAGE_KEY,
    loadImageGenerationConfig,
    normalizeImageGenerationConfig,
    saveImageGenerationConfig,
} from './imageGenerationConfig';

export const IMAGE_GENERATION_PRESETS_STORAGE_KEY = 'os_image_generation_presets_v1';
export const IMAGE_GENERATION_PRESETS_CHANGED_EVENT = 'sullyos:image-generation-presets-changed';

/** 旧单配置迁移为预设时的默认名称。 */
export const MIGRATED_PRESET_NAME = '默认配置';

export const EMPTY_PRESET_STORE: Readonly<ImageGenerationPresetStore> = Object.freeze({
    version: 1,
    presets: [],
    activeId: null,
});

function generatePresetId(): string {
    const cryptoObj = typeof globalThis !== 'undefined' ? (globalThis as { crypto?: Crypto }).crypto : undefined;
    if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
    return `img-preset-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createImageGenerationPresetId(): string {
    return generatePresetId();
}

function asTrimmedNonEmpty(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** 单个预设归一化：非法/缺字段的条目返回 null（由调用方丢弃），配置部分复用现有归一化。 */
export function normalizeImageGenerationPreset(value: unknown): ImageGenerationPreset | null {
    if (!value || typeof value !== 'object') return null;
    const source = value as { id?: unknown; name?: unknown; config?: unknown };
    const id = asTrimmedNonEmpty(source.id);
    const name = asTrimmedNonEmpty(source.name);
    if (!id || !name) return null;
    return { id, name, config: normalizeImageGenerationConfig(source.config) };
}

/**
 * 集合归一化：去重 id、丢弃非法条目，并保证 activeId 永远指向存在的预设
 * （指向缺失预设时回退到第一个预设，没有预设则为 null）。
 */
export function normalizeImageGenerationPresetStore(value: unknown): ImageGenerationPresetStore {
    const source = value && typeof value === 'object' ? value as Partial<ImageGenerationPresetStore> : {};
    const seen = new Set<string>();
    const presets: ImageGenerationPreset[] = [];
    for (const raw of Array.isArray(source.presets) ? source.presets : []) {
        const preset = normalizeImageGenerationPreset(raw);
        if (!preset || seen.has(preset.id)) continue;
        seen.add(preset.id);
        presets.push(preset);
    }
    const activeId = typeof source.activeId === 'string' && seen.has(source.activeId)
        ? source.activeId
        : presets.length ? presets[0].id : null;
    return { version: 1, presets, activeId };
}

function notifyPresetsChanged(store: ImageGenerationPresetStore): void {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent<ImageGenerationPresetStore>(IMAGE_GENERATION_PRESETS_CHANGED_EVENT, {
        // 预设含 API Key，与配置变更事件同策略：不把 Key 放进事件负载
        detail: { ...store, presets: store.presets.map(p => ({ ...p, config: { ...p.config, apiKey: '' } })) },
    }));
}

interface PresetStorage {
    getItem: Storage['getItem'];
    setItem: Storage['setItem'];
    removeItem: Storage['removeItem'];
}

function writePresetStore(store: ImageGenerationPresetStore, storage: PresetStorage): ImageGenerationPresetStore {
    storage.setItem(IMAGE_GENERATION_PRESETS_STORAGE_KEY, JSON.stringify(store));
    notifyPresetsChanged(store);
    return store;
}

/**
 * 读取预设集合；首次访问（无预设存储）且本机存在旧版单配置时，
 * 无损迁移为名为「默认配置」的预设并保持其为当前选中——不清空旧 Key、模型或任何设置。
 */
export function loadImageGenerationPresetStore(
    storage: PresetStorage = localStorage,
): ImageGenerationPresetStore {
    let raw: string | null = null;
    try {
        raw = storage.getItem(IMAGE_GENERATION_PRESETS_STORAGE_KEY);
    } catch {
        raw = null;
    }
    if (raw) {
        try {
            return normalizeImageGenerationPresetStore(JSON.parse(raw));
        } catch {
            return { ...EMPTY_PRESET_STORE, presets: [], activeId: null };
        }
    }

    // 旧版单配置 → 默认预设（仅当用户实际保存过配置时）
    let legacyRaw: string | null = null;
    try {
        legacyRaw = storage.getItem(IMAGE_GENERATION_CONFIG_STORAGE_KEY);
    } catch {
        legacyRaw = null;
    }
    if (!legacyRaw) return { ...EMPTY_PRESET_STORE, presets: [], activeId: null };

    const legacyConfig = loadImageGenerationConfig(storage);
    const preset: ImageGenerationPreset = {
        id: generatePresetId(),
        name: MIGRATED_PRESET_NAME,
        config: legacyConfig,
    };
    const store: ImageGenerationPresetStore = { version: 1, presets: [preset], activeId: preset.id };
    try {
        return writePresetStore(store, storage);
    } catch {
        return store;
    }
}

export function saveImageGenerationPresetStore(
    value: unknown,
    storage: PresetStorage = localStorage,
): ImageGenerationPresetStore {
    return writePresetStore(normalizeImageGenerationPresetStore(value), storage);
}

/** 新建预设（内容取自给定配置），不改变当前选中；返回新预设。 */
export function createImageGenerationPreset(
    name: string,
    config: ImageGenerationConfig | unknown,
    storage: PresetStorage = localStorage,
): ImageGenerationPreset {
    const store = loadImageGenerationPresetStore(storage);
    const preset: ImageGenerationPreset = {
        id: generatePresetId(),
        name: name.trim() || `预设 ${store.presets.length + 1}`,
        config: normalizeImageGenerationConfig(config),
    };
    saveImageGenerationPresetStore({ ...store, presets: [...store.presets, preset] }, storage);
    return preset;
}

/** 更新预设（名称与/或配置），不存在时返回 null。 */
export function updateImageGenerationPreset(
    id: string,
    patch: { name?: string; config?: unknown },
    storage: PresetStorage = localStorage,
): ImageGenerationPreset | null {
    const store = loadImageGenerationPresetStore(storage);
    const index = store.presets.findIndex(preset => preset.id === id);
    if (index === -1) return null;
    const current = store.presets[index];
    const next: ImageGenerationPreset = {
        id: current.id,
        name: patch.name?.trim() ? patch.name.trim() : current.name,
        config: patch.config !== undefined ? normalizeImageGenerationConfig(patch.config) : current.config,
    };
    const presets = [...store.presets];
    presets[index] = next;
    saveImageGenerationPresetStore({ ...store, presets }, storage);
    // 更新的正好是当前启用预设时，同步刷新生效配置（走既有保存/事件通道）
    if (store.activeId === id) saveImageGenerationConfig(next.config, storage);
    return next;
}

/**
 * 删除预设（二次确认由 UI 负责）。删除的是当前启用预设时：
 * - 还有其他预设 → 自动切到第一个剩余预设并使其配置生效；
 * - 没有剩余预设 → 恢复为明确关闭状态（默认配置 + enabled=false），activeId 置 null。
 */
export function deleteImageGenerationPreset(
    id: string,
    storage: PresetStorage = localStorage,
): ImageGenerationPresetStore {
    const store = loadImageGenerationPresetStore(storage);
    const presets = store.presets.filter(preset => preset.id !== id);
    if (store.activeId === id) {
        if (presets.length) {
            const nextActive = presets[0];
            saveImageGenerationPresetStore({ version: 1, presets, activeId: nextActive.id }, storage);
            saveImageGenerationConfig(nextActive.config, storage);
            return { version: 1, presets, activeId: nextActive.id };
        }
        saveImageGenerationPresetStore({ version: 1, presets: [], activeId: null }, storage);
        // 移除旧配置键而非写入禁用默认值，避免下次读取时把默认值误判为待迁移的旧配置
        clearImageGenerationConfig(storage);
        return { version: 1, presets: [], activeId: null };
    }
    return saveImageGenerationPresetStore({ ...store, presets }, storage);
}

/**
 * 切换当前启用预设：把目标预设的完整配置写入现有配置存储（复用 saveImageGenerationConfig，
 * 触发现有配置变更事件），所有生图入口读取到的即为目标预设配置。返回目标预设或 null。
 */
export function activateImageGenerationPreset(
    id: string,
    storage: PresetStorage = localStorage,
): ImageGenerationPreset | null {
    const store = loadImageGenerationPresetStore(storage);
    const target = store.presets.find(preset => preset.id === id);
    if (!target) return null;
    saveImageGenerationPresetStore({ ...store, activeId: id }, storage);
    // 恢复预设保存的原始配置；不做任何 provider 相关的 URL 改写
    saveImageGenerationConfig(target.config, storage);
    return target;
}

/** 当前启用预设（无预设或 activeId 失效时返回 null）。 */
export function getActiveImageGenerationPreset(storage: PresetStorage = localStorage): ImageGenerationPreset | null {
    const store = loadImageGenerationPresetStore(storage);
    return store.presets.find(preset => preset.id === store.activeId) ?? null;
}

/** 清空全部预设与生效配置，恢复明确关闭状态（UI 需先二次确认）。 */
export function clearImageGenerationPresetStore(storage: PresetStorage = localStorage): ImageGenerationPresetStore {
    storage.removeItem(IMAGE_GENERATION_PRESETS_STORAGE_KEY);
    // 一并移除旧配置键（loadImageGenerationConfig 随后返回禁用默认值），
    // 同时广播配置变更事件让所有生图入口立即看到关闭状态
    clearImageGenerationConfig(storage);
    const store: ImageGenerationPresetStore = { version: 1, presets: [], activeId: null };
    notifyPresetsChanged(store);
    return store;
}

/** 文本/完整备份导出：按现有本地凭据策略原样包含预设（含 Key），无预设时返回 undefined。 */
export function exportImageGenerationPresets(): ImageGenerationPresetStore | undefined {
    try {
        return localStorage.getItem(IMAGE_GENERATION_PRESETS_STORAGE_KEY)
            ? loadImageGenerationPresetStore()
            : undefined;
    } catch {
        return undefined;
    }
}

/**
 * 备份导入：缺失字段为 no-op；非法内容安全归一化（丢弃坏条目、修复悬空 activeId）。
 * 导入后若有激活预设，则把生效配置同步为该预设，保证配置与预设不发生错关联。
 */
export function importImageGenerationPresets(value: unknown): ImageGenerationPresetStore | undefined {
    if (value === undefined || value === null) return undefined;
    const store = saveImageGenerationPresetStore(value);
    if (store.activeId) {
        const active = store.presets.find(preset => preset.id === store.activeId);
        if (active) saveImageGenerationConfig(active.config);
    }
    return store;
}

/** 判断 Base URL 是否指向本地/私有网络（用于无鉴权模式的安全提示，仅提示不阻断）。 */
export function isPrivateNetworkBaseUrl(baseUrl: string): boolean {
    let hostname: string;
    try {
        hostname = new URL(baseUrl.trim()).hostname.toLowerCase();
    } catch {
        return false;
    }
    if (!hostname) return false;
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) return true;
    if (hostname.endsWith('.ts.net')) return true; // Tailscale MagicDNS
    if (hostname === '::1' || hostname.startsWith('fc') || hostname.startsWith('fd') || hostname.startsWith('fe80')) return true;
    const v4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (v4) {
        const [a, b] = [Number(v4[1]), Number(v4[2])];
        if (a === 127 || a === 10 || a === 0) return true;
        if (a === 192 && b === 168) return true;
        if (a === 172 && b >= 16 && b <= 31) return true;
        if (a === 169 && b === 254) return true; // link-local
        if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT（Tailscale 默认网段）
    }
    return false;
}
