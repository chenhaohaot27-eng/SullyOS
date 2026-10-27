import { beforeEach, describe, expect, it } from 'vitest';
import type { ImageGenerationConfig, ImageGenerationPreset, ImageGenerationPresetStore } from '../types';
import {
    IMAGE_GENERATION_PRESETS_STORAGE_KEY,
    MIGRATED_PRESET_NAME,
    activateImageGenerationPreset,
    clearImageGenerationPresetStore,
    createImageGenerationPreset,
    deleteImageGenerationPreset,
    exportImageGenerationPresets,
    getActiveImageGenerationPreset,
    importImageGenerationPresets,
    isPrivateNetworkBaseUrl,
    loadImageGenerationPresetStore,
    normalizeImageGenerationPresetStore,
    updateImageGenerationPreset,
} from './imageGenerationPresets';
import {
    IMAGE_GENERATION_CONFIG_STORAGE_KEY,
    loadImageGenerationConfig,
    saveImageGenerationConfig,
} from './imageGenerationConfig';

const configOf = (overrides: Partial<ImageGenerationConfig>): ImageGenerationConfig => ({
    version: 1,
    enabled: true,
    provider: 'openai-images',
    baseUrl: 'https://relay.example/v1',
    apiKey: 'key-a',
    model: 'model-a',
    defaultResolution: '2K',
    defaultAspectRatio: '1:1',
    allowReferenceImages: true,
    timeoutMs: 60_000,
    authMode: 'api-key',
    ...overrides,
});

describe('imageGenerationPresets — 旧单配置无损迁移', () => {
    beforeEach(() => localStorage.clear());

    it('首次读取时把旧单配置迁移为默认预设，原 API Key 与设置不丢失', () => {
        const legacy = configOf({ apiKey: 'legacy-secret-key', model: 'gemini-3-pro-image', provider: 'gemini-native' });
        localStorage.setItem(IMAGE_GENERATION_CONFIG_STORAGE_KEY, JSON.stringify(legacy));

        const store = loadImageGenerationPresetStore();
        expect(store.presets).toHaveLength(1);
        expect(store.activeId).toBe(store.presets[0].id);
        expect(store.presets[0].name).toBe(MIGRATED_PRESET_NAME);
        expect(store.presets[0].config.apiKey).toBe('legacy-secret-key');
        expect(store.presets[0].config.model).toBe('gemini-3-pro-image');
        // 迁移是持久化的：再次读取保持一致
        expect(loadImageGenerationPresetStore().activeId).toBe(store.activeId);
    });

    it('从未配置过的全新安装不产生预设，也不写入存储', () => {
        const store = loadImageGenerationPresetStore();
        expect(store.presets).toHaveLength(0);
        expect(store.activeId).toBeNull();
        expect(localStorage.getItem(IMAGE_GENERATION_PRESETS_STORAGE_KEY)).toBeNull();
    });
});

describe('imageGenerationPresets — 多预设保存与切换', () => {
    beforeEach(() => localStorage.clear());

    const setup = () => {
        const a = createImageGenerationPreset('RelayRouter 云端', configOf({
            provider: 'gemini-native',
            baseUrl: 'https://api.relayrouter.app/v1beta',
            apiKey: 'relay-key',
            model: 'gemini-3-pro-image',
        }));
        const b = createImageGenerationPreset('朋友的 ComfyUI', configOf({
            provider: 'openai-images',
            baseUrl: 'https://100.101.102.103/v1',
            apiKey: '',
            model: 'flux-dev',
            authMode: 'none',
        }));
        return { a, b };
    };

    it('两套预设分别保存不同 URL、Key、模型与参数', () => {
        const { a, b } = setup();
        const store = loadImageGenerationPresetStore();
        expect(store.presets.map(p => p.name)).toEqual(['RelayRouter 云端', '朋友的 ComfyUI']);
        expect(a.config).not.toEqual(b.config);
        expect(a.config.baseUrl).toBe('https://api.relayrouter.app/v1beta');
        expect(b.config.baseUrl).toBe('https://100.101.102.103/v1');
    });

    it('A → B → A 切换后全部配置正确恢复（含 apiKey / authMode / timeout）', () => {
        const { a, b } = setup();
        activateImageGenerationPreset(a.id);
        expect(loadImageGenerationConfig()).toMatchObject({ baseUrl: a.config.baseUrl, apiKey: 'relay-key', authMode: 'api-key' });

        activateImageGenerationPreset(b.id);
        expect(loadImageGenerationConfig()).toMatchObject({ baseUrl: b.config.baseUrl, apiKey: '', authMode: 'none', model: 'flux-dev', provider: 'openai-images' });

        activateImageGenerationPreset(a.id);
        const restored = loadImageGenerationConfig();
        expect(restored).toEqual(a.config);
    });

    it('切换后实际生图服务读取的就是当前预设配置（服务默认 loadConfig 同源）', () => {
        const { a, b } = setup();
        activateImageGenerationPreset(a.id);
        expect(loadImageGenerationConfig().apiKey).toBe('relay-key');
        activateImageGenerationPreset(b.id);
        expect(loadImageGenerationConfig().apiKey).toBe('');
        expect(loadImageGenerationConfig().baseUrl).toBe('https://100.101.102.103/v1');
    });

    it('切换触发现有配置变更事件，预设之间切换不改写目标预设 URL', () => {
        // node 测试环境无 window：临时挂一个 EventTarget 作为 window
        const previousWindow = (globalThis as { window?: unknown }).window;
        const windowStub = new EventTarget() as unknown as EventTarget & { location: { protocol: string } };
        windowStub.location = { protocol: 'https:' };
        (globalThis as { window?: unknown }).window = windowStub;
        try {
            const { a, b } = setup();
            activateImageGenerationPreset(a.id);
            let eventConfig: unknown;
            const listener = (event: Event) => { eventConfig = (event as CustomEvent).detail; };
            window.addEventListener('sullyos:image-generation-config-changed', listener);
            activateImageGenerationPreset(b.id);
            window.removeEventListener('sullyos:image-generation-config-changed', listener);
            // 事件负载按策略不含 Key；配置本体保持 B 的原始 URL
            expect((eventConfig as ImageGenerationConfig).baseUrl).toBe('https://100.101.102.103/v1');
            expect((eventConfig as ImageGenerationConfig).apiKey).toBe('');
            expect(loadImageGenerationConfig().baseUrl).toBe('https://100.101.102.103/v1');
        } finally {
            (globalThis as { window?: unknown }).window = previousWindow;
        }
    });

    it('更新当前启用预设会同步生效配置；重命名不影响配置', () => {
        const { a } = setup();
        activateImageGenerationPreset(a.id);
        updateImageGenerationPreset(a.id, { config: { ...a.config, apiKey: 'rotated-key' } });
        expect(loadImageGenerationConfig().apiKey).toBe('rotated-key');
        updateImageGenerationPreset(a.id, { name: 'RelayRouter 新域名' });
        expect(getActiveImageGenerationPreset()?.name).toBe('RelayRouter 新域名');
        expect(loadImageGenerationConfig().apiKey).toBe('rotated-key');
    });
});

describe('imageGenerationPresets — 删除 / 清空 / 异常导入不错关联', () => {
    beforeEach(() => localStorage.clear());

    it('删除当前启用预设：有剩余预设时安全切换到剩余预设', () => {
        const a = createImageGenerationPreset('A', configOf({ apiKey: 'key-a' }));
        const b = createImageGenerationPreset('B', configOf({ apiKey: 'key-b', baseUrl: 'https://b.example/v1' }));
        activateImageGenerationPreset(b.id);
        const store = deleteImageGenerationPreset(b.id);
        expect(store.presets.map(p => p.id)).toEqual([a.id]);
        expect(store.activeId).toBe(a.id);
        expect(loadImageGenerationConfig().apiKey).toBe('key-a');
    });

    it('删除最后一个预设：恢复明确关闭状态，activeId 不悬空', () => {
        const a = createImageGenerationPreset('A', configOf({ enabled: true }));
        activateImageGenerationPreset(a.id);
        const store = deleteImageGenerationPreset(a.id);
        expect(store.presets).toHaveLength(0);
        expect(store.activeId).toBeNull();
        const config = loadImageGenerationConfig();
        expect(config.enabled).toBe(false);
    });

    it('清空预设与配置后读取安全', () => {
        createImageGenerationPreset('A', configOf({}));
        clearImageGenerationPresetStore();
        expect(loadImageGenerationPresetStore().presets).toHaveLength(0);
        expect(loadImageGenerationConfig().enabled).toBe(false);
    });

    it('异常导入（坏条目 / 悬空 activeId / 重复 id）被安全归一化', () => {
        const good: ImageGenerationPreset = { id: 'p1', name: 'P1', config: configOf({}) };
        const store = importImageGenerationPresets({
            version: 1,
            presets: [good, { id: '', name: '坏', config: {} }, { name: '缺 id', config: {} }, good],
            activeId: 'missing-id',
        }) as ImageGenerationPresetStore;
        expect(store.presets).toHaveLength(1);
        expect(store.activeId).toBe('p1');
        expect(loadImageGenerationConfig().baseUrl).toBe(good.config.baseUrl);
    });

    it('旧版备份（无预设字段）导入为 no-op，不影响已恢复的单配置', () => {
        saveImageGenerationConfig(configOf({ apiKey: 'legacy-import-key' }));
        expect(importImageGenerationPresets(undefined)).toBeUndefined();
        expect(importImageGenerationPresets(null)).toBeUndefined();
        expect(loadImageGenerationConfig().apiKey).toBe('legacy-import-key');
    });

    it('完整备份往返：导出含预设与 Key，恢复后一致', () => {
        const a = createImageGenerationPreset('A', configOf({ apiKey: 'roundtrip-key' }));
        activateImageGenerationPreset(a.id);
        const exported = exportImageGenerationPresets();
        expect(exported?.presets[0].config.apiKey).toBe('roundtrip-key');

        clearImageGenerationPresetStore();
        localStorage.removeItem(IMAGE_GENERATION_CONFIG_STORAGE_KEY);
        importImageGenerationPresets(exported);
        expect(getActiveImageGenerationPreset()?.id).toBe(a.id);
        expect(loadImageGenerationConfig().apiKey).toBe('roundtrip-key');
    });
});

describe('imageGenerationPresets — 无鉴权模式与私有地址识别', () => {
    beforeEach(() => localStorage.clear());

    it('空 Key 绝不会自动降级为无鉴权：authMode 默认 api-key', () => {
        const preset = createImageGenerationPreset('云端', configOf({ apiKey: '' }));
        expect(preset.config.authMode).toBe('api-key');
        expect(normalizeImageGenerationPresetStore({
            presets: [{ id: 'x', name: 'X', config: { apiKey: '', authMode: 'weird' } }],
        }).presets[0].config.authMode).toBe('api-key');
    });

    it('识别本地 / 私有 / Tailscale 地址，拒绝把公网地址当作私有', () => {
        expect(isPrivateNetworkBaseUrl('http://127.0.0.1:8188/v1')).toBe(true);
        expect(isPrivateNetworkBaseUrl('http://localhost:8188/v1')).toBe(true);
        expect(isPrivateNetworkBaseUrl('http://192.168.1.20:8188/v1')).toBe(true);
        expect(isPrivateNetworkBaseUrl('http://172.20.10.9:8188/v1')).toBe(true);
        expect(isPrivateNetworkBaseUrl('http://100.101.102.103:8188/v1')).toBe(true);
        expect(isPrivateNetworkBaseUrl('https://friend-tailnet.ts.net/v1')).toBe(true);
        expect(isPrivateNetworkBaseUrl('https://api.relayrouter.app/v1')).toBe(false);
        expect(isPrivateNetworkBaseUrl('https://images.example.com/v1')).toBe(false);
        expect(isPrivateNetworkBaseUrl('https://8.8.8.8/v1')).toBe(false);
        expect(isPrivateNetworkBaseUrl('not a url')).toBe(false);
    });

    it('显式 authMode none 的本地预设允许空 Key 保存与切换', () => {
        const local = createImageGenerationPreset('我的 ComfyUI', configOf({
            baseUrl: 'http://192.168.1.20:8188/v1',
            apiKey: '',
            model: 'flux-dev',
            authMode: 'none',
        }));
        activateImageGenerationPreset(local.id);
        expect(loadImageGenerationConfig()).toMatchObject({ apiKey: '', authMode: 'none' });
    });
});
