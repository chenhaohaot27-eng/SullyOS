import { beforeEach, describe, expect, it } from 'vitest';
import {
    DEFAULT_IMAGE_GENERATION_CONFIG,
    IMAGE_GENERATION_CONFIG_STORAGE_KEY,
    clearImageGenerationConfig,
    exportImageGenerationConfig,
    importImageGenerationConfig,
    loadImageGenerationConfig,
    normalizeImageGenerationConfig,
    saveImageGenerationConfig,
} from './imageGenerationConfig';

describe('image generation config persistence', () => {
    beforeEach(() => localStorage.clear());

    it('saves and reloads an independent normalized config', () => {
        const saved = saveImageGenerationConfig({
            enabled: true,
            provider: 'openai-images',
            baseUrl: ' https://images.example/v1/// ',
            apiKey: ' local-image-key ',
            model: ' image-model ',
            defaultResolution: '4K',
            defaultAspectRatio: '16:9',
            allowReferenceImages: false,
            timeoutMs: 45_000,
        });

        expect(saved).toMatchObject({
            version: 1,
            enabled: true,
            provider: 'openai-images',
            baseUrl: 'https://images.example/v1',
            apiKey: 'local-image-key',
            model: 'image-model',
            defaultResolution: '4K',
            defaultAspectRatio: '16:9',
            timeoutMs: 45_000,
        });
        expect(loadImageGenerationConfig()).toEqual(saved);
    });

    it('does not read or overwrite the vision/main API namespace', () => {
        const existingApiConfig = {
            baseUrl: 'https://chat.example/v1',
            apiKey: 'chat-key',
            model: 'chat-model',
            visionApi: { enabled: true, baseUrl: 'https://vision.example/v1', apiKey: 'vision-key', model: 'vision-model' },
        };
        localStorage.setItem('os_api_config', JSON.stringify(existingApiConfig));
        saveImageGenerationConfig({ ...DEFAULT_IMAGE_GENERATION_CONFIG, enabled: true, apiKey: 'image-key' });

        expect(JSON.parse(localStorage.getItem('os_api_config') || '{}')).toEqual(existingApiConfig);
        expect(localStorage.getItem(IMAGE_GENERATION_CONFIG_STORAGE_KEY)).toContain('image-key');
    });

    it('loads safe defaults for old installs, corrupt values, and missing backup fields', () => {
        expect(loadImageGenerationConfig()).toEqual(DEFAULT_IMAGE_GENERATION_CONFIG);
        localStorage.setItem(IMAGE_GENERATION_CONFIG_STORAGE_KEY, '{broken');
        expect(loadImageGenerationConfig()).toEqual(DEFAULT_IMAGE_GENERATION_CONFIG);

        localStorage.removeItem(IMAGE_GENERATION_CONFIG_STORAGE_KEY);
        expect(importImageGenerationConfig(undefined)).toBeUndefined();
        expect(localStorage.getItem(IMAGE_GENERATION_CONFIG_STORAGE_KEY)).toBeNull();

        expect(normalizeImageGenerationConfig({ timeoutMs: 1, provider: 'unknown' })).toMatchObject({
            provider: 'gemini-native',
            timeoutMs: 5_000,
            defaultResolution: '2K',
        });
    });

    it('round-trips through the existing text/full backup credential policy', () => {
        const saved = saveImageGenerationConfig({ ...DEFAULT_IMAGE_GENERATION_CONFIG, enabled: true, apiKey: 'backup-image-key' });
        const exported = exportImageGenerationConfig();
        clearImageGenerationConfig();
        expect(loadImageGenerationConfig().apiKey).toBe('');

        importImageGenerationConfig(exported);
        expect(loadImageGenerationConfig()).toEqual(saved);
    });
});
