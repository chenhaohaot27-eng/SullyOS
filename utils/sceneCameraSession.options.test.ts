/**
 * SceneCameraSession 画面导演选项 Tests（两阶段导演升级）
 *
 * 覆盖：
 * 1. directorEnabled=false：完全不调导演，本地基础直生成，仍能成像
 * 2. 选项与选中原文正确传递给导演请求
 * 3. 导演降级（directorFallbackReason） surfaced 为 directorNotice
 * 4. updateFinalPrompt + rerenderSameShot：编辑后的 prompt 用于重拍
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CharacterProfile, ImageGenerationConfig, SceneCameraShotPlan, SceneImageOptions } from '../types';
import { SceneCameraSession } from './sceneCameraSession';
import { DEFAULT_SCENE_IMAGE_OPTIONS } from './imageGenerationOptions';

vi.mock('./sceneCameraService');
vi.mock('./imageGenerationService');
vi.mock('./sceneCameraDirector');
vi.mock('./visualIdentityPresets');

import { generateShotPlanOnly, renderShotPlan } from './sceneCameraService';

const character: CharacterProfile = {
    id: 'char-1',
    name: '小满',
    avatar: '',
    greeting: '',
    createdAt: 0,
    updatedAt: 0,
} as unknown as CharacterProfile;

const directorConfig = {
    provider: 'openai-compatible' as const,
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'director-key',
    model: 'director-model',
};

const rendererConfig: ImageGenerationConfig = {
    version: 1,
    enabled: true,
    provider: 'gpt-images',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'renderer-key',
    model: 'renderer-model-a',
    defaultResolution: '2K',
    defaultAspectRatio: '1:1',
    allowReferenceImages: true,
    timeoutMs: 90_000,
};

const makeShotPlan = (prompt: string): SceneCameraShotPlan => ({
    version: 1,
    mode: 'scene-snapshot',
    subjects: ['小满'],
    characterState: '以原文描述为准',
    playerVisibility: 'none',
    environment: '雨夜当铺',
    moment: '对峙时刻',
    bodyOrientation: '以原文描述为准',
    expression: '以原文描述为准',
    gaze: '以原文描述为准',
    cameraPosition: '低机位',
    shotSize: '中景',
    cameraFeel: '35mm',
    composition: 'text_faithful',
    background: '当铺内景',
    lighting: '台灯侧光',
    continuityConstraints: [],
    avoidConstraints: [],
    finalPrompt: prompt,
    createdAt: Date.now(),
});

function createHarness(overrides: {
    selectedText?: string;
    requestShotPlan?: ReturnType<typeof vi.fn>;
} = {}) {
    const requestShotPlan = overrides.requestShotPlan ?? vi.fn().mockResolvedValue(makeShotPlan('director-prompt'));
    const renderExistingShotPlan = vi.fn().mockImplementation(async (req: { shotPlan: SceneCameraShotPlan }) => ({
        shotPlan: req.shotPlan,
        imageUrl: 'data:image/png;base64,AAA',
        rendererMetadata: { provider: rendererConfig.provider, model: rendererConfig.model },
    }));
    const session = new SceneCameraSession({
        getSceneContext: () => '【陪伴见面 · 最近场景】\n\n玩家：你好',
        getCharacter: () => character,
        getDirectorConfig: () => directorConfig,
        getRendererConfig: () => rendererConfig,
        ...(overrides.selectedText !== undefined ? { getSelectedText: () => overrides.selectedText } : {}),
        requestShotPlan: requestShotPlan as never,
        renderExistingShotPlan: renderExistingShotPlan as never,
    });
    return { session, requestShotPlan, renderExistingShotPlan };
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(renderShotPlan).mockResolvedValue({
        shotPlan: makeShotPlan('x'),
        imageUrl: 'data:image/png;base64,AAA',
        rendererMetadata: { provider: 'gpt-images', model: 'm' },
    } as never);
});

describe('SceneCameraSession · 画面导演选项', () => {
    it('默认选项为 narrative_balanced / key_elements / auto / 开启导演', () => {
        const h = createHarness();
        expect(h.session.getState().options).toEqual(DEFAULT_SCENE_IMAGE_OPTIONS);
    });

    it('directorEnabled=false：不调导演，本地基础直生成仍能成像', async () => {
        const h = createHarness({ selectedText: '老陈把信拍在桌上，雨砸进当铺。' });
        h.session.setOptions({ ...DEFAULT_SCENE_IMAGE_OPTIONS, directorEnabled: false });
        await h.session.generate();

        expect(h.requestShotPlan).not.toHaveBeenCalled();
        expect(h.renderExistingShotPlan).toHaveBeenCalledTimes(1);
        const state = h.session.getState();
        expect(state.phase).toBe('done');
        expect(state.imageUrl).toBe('data:image/png;base64,AAA');
        expect(state.shotPlan?.finalPrompt).toContain('老陈把信拍在桌上');
        expect(state.directorNotice).toContain('关闭导演');
    });

    it('开启导演时：选项与选中原文传递给导演请求', async () => {
        const h = createHarness({ selectedText: '老陈把信拍在桌上' });
        const options: SceneImageOptions = { ...DEFAULT_SCENE_IMAGE_OPTIONS, compositionMode: 'text_faithful', subjectFocus: 'npc_allowed' };
        h.session.setOptions(options);
        await h.session.generate();

        expect(h.requestShotPlan).toHaveBeenCalledWith(expect.objectContaining({
            options,
            selectedText: '老陈把信拍在桌上',
            rendererProvider: 'gpt-images',
        }));
    });

    it('导演降级说明 surfaced 为 directorNotice，流程仍完成', async () => {
        const fallbackPlan = { ...makeShotPlan('fallback-prompt'), directorFallbackReason: '导演解析失败，已改为直接根据原文生成' };
        const h = createHarness({ requestShotPlan: vi.fn().mockResolvedValue(fallbackPlan) });
        await h.session.generate();

        const state = h.session.getState();
        expect(state.phase).toBe('done');
        expect(state.directorNotice).toContain('导演解析失败');
        expect(state.shotPlan?.finalPrompt).toBe('fallback-prompt');
    });

    it('updateFinalPrompt + rerenderSameShot：编辑后的 prompt 用于重拍', async () => {
        const h = createHarness();
        await h.session.generate();
        h.renderExistingShotPlan.mockClear();

        h.session.updateFinalPrompt('edited-prompt-by-user');
        await h.session.rerenderSameShot();

        expect(h.renderExistingShotPlan).toHaveBeenCalledWith(expect.objectContaining({
            shotPlan: expect.objectContaining({ finalPrompt: 'edited-prompt-by-user' }),
        }));
    });
});
