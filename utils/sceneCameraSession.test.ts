/**
 * Scene Camera Session Tests (Phase 3C)
 *
 * 覆盖：
 * 1. scene-snapshot / duo-photo 完整 Director + Renderer 流程
 * 2. 两阶段 loading 状态（directing → rendering → done）
 * 3. 重拍同一镜头：reuse ShotPlan，不调用 Director
 * 4. 重新导演：调 Director，带 previousShotPlan
 * 5. Renderer 失败：ShotPlan 保留，retry 只走 Renderer
 * 6. busy 互斥：生成期间不产生并发请求
 * 7. reset：关闭 modal 清理 loading / 临时 ShotPlan
 * 8. renderShotPlan / generateSceneCamera 传递 characterId 与 aspectRatio（Visual Identity 注入依赖 characterId）
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CharacterProfile, ImageGenerationConfig, SceneCameraShotPlan } from '../types';
import { SceneCameraSession, SCENE_CAMERA_ASPECT_RATIOS, SUPPORTED_SCENE_CAMERA_MODES } from './sceneCameraSession';
import { generateSceneCamera, renderShotPlan } from './sceneCameraService';
import * as imageGenerationService from './imageGenerationService';
import * as sceneCameraDirector from './sceneCameraDirector';
import * as visualIdentityPresets from './visualIdentityPresets';

vi.mock('./imageGenerationService');
vi.mock('./sceneCameraDirector');
vi.mock('./visualIdentityPresets');

const character: CharacterProfile = {
    id: 'char-1',
    name: '小满',
    avatar: '',
    greeting: '',
    createdAt: 0,
    updatedAt: 0,
} as CharacterProfile;

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

const makeShotPlan = (mode: 'scene-snapshot' | 'duo-photo', prompt: string): SceneCameraShotPlan => ({
    version: 1,
    mode,
    subjects: ['小满'],
    characterState: '坐在窗边',
    playerVisibility: 'none',
    environment: '咖啡厅',
    moment: '午后',
    bodyOrientation: '侧身',
    expression: '微笑',
    gaze: '看向窗外',
    cameraPosition: '平视',
    shotSize: '半身',
    cameraFeel: '50mm',
    composition: '三分法',
    background: '街道',
    lighting: '自然光',
    continuityConstraints: [],
    avoidConstraints: [],
    finalPrompt: prompt,
    createdAt: Date.now(),
});

interface Harness {
    session: SceneCameraSession;
    phases: string[];
    requestShotPlan: ReturnType<typeof vi.fn>;
    renderExistingShotPlan: ReturnType<typeof vi.fn>;
    rendererConfigRef: { current: ImageGenerationConfig };
}

function createHarness(shotPlan: SceneCameraShotPlan = makeShotPlan('scene-snapshot', 'prompt-v1')): Harness {
    const requestShotPlan = vi.fn().mockResolvedValue(shotPlan);
    const renderExistingShotPlan = vi.fn().mockResolvedValue({
        shotPlan,
        imageUrl: 'data:image/png;base64,AAA',
        rendererMetadata: { provider: rendererConfig.provider, model: rendererConfig.model },
    });
    const rendererConfigRef = { current: { ...rendererConfig } };
    const session = new SceneCameraSession({
        getSceneContext: () => '【陪伴见面 · 最近场景】\n\n玩家：你好',
        getCharacter: () => character,
        getDirectorConfig: () => directorConfig,
        getRendererConfig: () => rendererConfigRef.current,
        requestShotPlan: requestShotPlan as never,
        renderExistingShotPlan: renderExistingShotPlan as never,
    });
    const phases: string[] = [];
    session.subscribe(() => phases.push(session.getState().phase));
    return { session, phases, requestShotPlan, renderExistingShotPlan, rendererConfigRef };
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(visualIdentityPresets.getActiveVisualIdentity).mockReturnValue(null);
});

/** 订阅会在每次 state patch 时通知（phase 未变也会），断言前先折叠连续重复。 */
const dedupePhases = (phases: string[]): string[] => phases.filter((v, i) => i === 0 || phases[i - 1] !== v);

describe('SceneCameraSession', () => {
    it('scene-snapshot：完整 Director + Renderer 流程，两阶段 loading', async () => {
        const h = createHarness();
        await h.session.generate();

        expect(h.requestShotPlan).toHaveBeenCalledTimes(1);
        expect(h.requestShotPlan).toHaveBeenCalledWith(expect.objectContaining({
            mode: 'scene-snapshot',
            sceneContext: expect.stringContaining('玩家：你好'),
            character,
            directorConfig,
            previousShotPlan: undefined,
        }));
        expect(h.renderExistingShotPlan).toHaveBeenCalledTimes(1);
        expect(h.renderExistingShotPlan).toHaveBeenCalledWith(expect.objectContaining({
            character,
            rendererConfig,
        }));
        // 两阶段：idle → directing → rendering → done
        expect(dedupePhases(h.phases)).toEqual(['directing', 'rendering', 'done']);
        const state = h.session.getState();
        expect(state.phase).toBe('done');
        expect(state.imageUrl).toBe('data:image/png;base64,AAA');
        expect(state.shotPlan?.finalPrompt).toBe('prompt-v1');
        expect(state.directorMetadata).toEqual({ provider: 'openai-compatible', model: 'director-model' });
        expect(state.rendererMetadata).toEqual({ provider: 'gpt-images', model: 'renderer-model-a' });
    });

    it('duo-photo：模式切换后完整流程使用 duo-photo', async () => {
        const h = createHarness();
        h.session.setMode('duo-photo');
        await h.session.generate();
        expect(h.requestShotPlan).toHaveBeenCalledWith(expect.objectContaining({ mode: 'duo-photo' }));
        expect(h.session.getState().mode).toBe('duo-photo');
    });

    it('宽高比应传递给 Renderer（可切换）', async () => {
        const h = createHarness();
        h.session.setAspectRatio('9:16');
        await h.session.generate();
        expect(h.renderExistingShotPlan).toHaveBeenCalledWith(expect.objectContaining({ aspectRatio: '9:16' }));
        expect(SCENE_CAMERA_ASPECT_RATIOS).toContain('9:16');
    });

    it('重拍同一镜头：保留 ShotPlan，不调用 Director，允许更换生图模型', async () => {
        const h = createHarness();
        await h.session.generate();
        h.requestShotPlan.mockClear();
        h.renderExistingShotPlan.mockClear();

        // 用户在设置里换了生图模型
        h.rendererConfigRef.current = { ...rendererConfig, model: 'renderer-model-b' };
        await h.session.rerenderSameShot();

        expect(h.requestShotPlan).not.toHaveBeenCalled();
        expect(h.renderExistingShotPlan).toHaveBeenCalledTimes(1);
        expect(h.renderExistingShotPlan).toHaveBeenCalledWith(expect.objectContaining({
            shotPlan: expect.objectContaining({ finalPrompt: 'prompt-v1' }),
            rendererConfig: expect.objectContaining({ model: 'renderer-model-b' }),
        }));
        expect(dedupePhases(h.phases)).toEqual(['directing', 'rendering', 'done', 'rendering', 'done']);
    });

    it('重新导演：重新调用 Director，并带 previousShotPlan', async () => {
        const h = createHarness();
        await h.session.generate();
        h.requestShotPlan.mockClear();

        const newPlan = makeShotPlan('scene-snapshot', 'prompt-v2');
        h.requestShotPlan.mockResolvedValue(newPlan);
        h.renderExistingShotPlan.mockResolvedValue({
            shotPlan: newPlan,
            imageUrl: 'data:image/png;base64,BBB',
            rendererMetadata: { provider: 'gpt-images', model: 'renderer-model-a' },
        });

        await h.session.redirectNewShot();

        expect(h.requestShotPlan).toHaveBeenCalledTimes(1);
        expect(h.requestShotPlan).toHaveBeenCalledWith(expect.objectContaining({
            previousShotPlan: expect.objectContaining({ finalPrompt: 'prompt-v1' }),
        }));
        const state = h.session.getState();
        expect(state.shotPlan?.finalPrompt).toBe('prompt-v2');
        expect(state.previousShotPlan?.finalPrompt).toBe('prompt-v1');
        expect(state.imageUrl).toBe('data:image/png;base64,BBB');
    });

    it('Renderer 失败：ShotPlan 保留在 session state，retry 只走 Renderer', async () => {
        const h = createHarness();
        await h.session.generate();
        h.requestShotPlan.mockClear();
        h.renderExistingShotPlan.mockClear();

        h.renderExistingShotPlan.mockRejectedValueOnce(new Error('生图失败'));
        // 用户在成功后点「重拍同一镜头」，Renderer 失败
        await h.session.rerenderSameShot();

        const failed = h.session.getState();
        expect(failed.phase).toBe('error');
        expect(failed.error).toContain('生图失败');
        // ShotPlan 不丢：可以「重拍同一镜头」而不重新导演
        expect(failed.shotPlan?.finalPrompt).toBe('prompt-v1');
        h.renderExistingShotPlan.mockClear();

        // retry：有 ShotPlan → 只调 Renderer
        await h.session.retry();
        expect(h.requestShotPlan).not.toHaveBeenCalled();
        expect(h.renderExistingShotPlan).toHaveBeenCalledTimes(1);
        expect(h.session.getState().phase).toBe('done');
    });

    it('Director 失败：phase=error 且无 ShotPlan，retry 走完整流程', async () => {
        const h = createHarness();
        h.requestShotPlan.mockRejectedValueOnce(new Error('导演失败'));
        await h.session.generate();
        expect(h.session.getState().phase).toBe('error');
        expect(h.session.getState().shotPlan).toBeUndefined();

        await h.session.retry();
        expect(h.requestShotPlan).toHaveBeenCalledTimes(2);
        expect(h.session.getState().phase).toBe('done');
    });

    it('生成期间 busy 互斥：不产生并发请求', async () => {
        const h = createHarness();
        const plan = makeShotPlan('scene-snapshot', 'busy-prompt');
        let releaseDirector!: () => void;
        h.requestShotPlan.mockImplementation(() => new Promise(resolve => {
            releaseDirector = () => resolve(plan);
        }));
        const first = h.session.generate();
        const second = h.session.generate(); // directing 期间 busy，应被忽略
        releaseDirector();
        await Promise.all([first, second]);
        expect(h.requestShotPlan).toHaveBeenCalledTimes(1);
        expect(h.renderExistingShotPlan).toHaveBeenCalledTimes(1);
    });

    it('reset：关闭 modal 清理 loading / 临时 ShotPlan，回到初始态', async () => {
        const h = createHarness();
        await h.session.generate();
        expect(h.session.getState().imageUrl).toBeTruthy();
        h.session.reset();
        const state = h.session.getState();
        expect(state.phase).toBe('idle');
        expect(state.shotPlan).toBeUndefined();
        expect(state.previousShotPlan).toBeUndefined();
        expect(state.imageUrl).toBeUndefined();
        expect(state.error).toBeUndefined();
        expect(h.session.isBusy()).toBe(false);
    });

    it('第一版只支持 scene-snapshot / duo-photo，其他模式被拒绝', () => {
        const h = createHarness();
        h.session.setMode('pov-selfie' as never);
        expect(h.session.getState().mode).toBe('scene-snapshot');
        expect(SUPPORTED_SCENE_CAMERA_MODES).toEqual(['scene-snapshot', 'duo-photo']);
    });
});

describe('renderShotPlan / generateSceneCamera（characterId 传递 → Visual Identity 注入）', () => {
    it('renderShotPlan 应把 characterId 与 aspectRatio 传给 imageGenerationService', async () => {
        vi.mocked(sceneCameraDirector.callDirector).mockResolvedValue({
            shotPlan: makeShotPlan('scene-snapshot', 'p'),
            rawResponse: '',
            metadata: { provider: 'openai-compatible', model: 'm' },
        });
        vi.mocked(imageGenerationService.generateImage).mockResolvedValue({
            provider: 'gpt-images',
            model: 'renderer-model-a',
            images: [{ source: 'data-uri', url: 'data:image/png;base64,AAA', mimeType: 'image/png' }],
            createdAt: 0,
        } as never);

        const result = await renderShotPlan({
            shotPlan: makeShotPlan('scene-snapshot', 'rerender-prompt'),
            character,
            rendererConfig,
            aspectRatio: '3:4',
        });

        expect(imageGenerationService.generateImage).toHaveBeenCalledWith(expect.objectContaining({
            prompt: 'rerender-prompt',
            characterId: 'char-1',
            aspectRatio: '3:4',
        }));
        expect(result.shotPlan.rendererProvider).toBe('gpt-images');
        expect(result.shotPlan.rendererModel).toBe('renderer-model-a');
        expect(result.imageUrl).toBe('data:image/png;base64,AAA');
    });

    it('generateSceneCamera 完整流程应传递 aspectRatio 与 characterId（Phase 3B 回归）', async () => {
        vi.mocked(sceneCameraDirector.callDirector).mockResolvedValue({
            shotPlan: makeShotPlan('duo-photo', 'duo-prompt'),
            rawResponse: '',
            metadata: { provider: 'openai-compatible', model: 'm' },
        });
        vi.mocked(imageGenerationService.generateImage).mockResolvedValue({
            provider: 'gemini-native',
            model: 'gemini-image',
            images: [{ source: 'data-uri', url: 'data:image/png;base64,CCC', mimeType: 'image/png' }],
            createdAt: 0,
        } as never);

        const result = await generateSceneCamera({
            mode: 'duo-photo',
            sceneContext: '场景',
            character,
            directorConfig,
            rendererConfig,
            aspectRatio: '16:9',
        });

        expect(imageGenerationService.generateImage).toHaveBeenCalledWith(expect.objectContaining({
            characterId: 'char-1',
            aspectRatio: '16:9',
            prompt: 'duo-prompt',
        }));
        expect(result.shotPlan.rendererProvider).toBe('gpt-images');
    });
});
