/**
 * Scene Camera Service Integration Tests (Phase 3B)
 *
 * 测试目标：
 * 1. Director + Renderer 完整流程
 * 2. Visual Identity 自动注入
 * 3. photoSemantics 自动应用
 * 4. previousShotPlan 差异化
 * 5. 错误处理
 */

import { describe, it, expect, vi } from 'vitest';
import type { Character, ImageGenerationConfig, SceneCameraShotPlan } from '../types';
import { generateSceneCamera, generateShotPlanOnly } from './sceneCameraService';
import * as sceneCameraDirector from './sceneCameraDirector';
import * as imageGenerationService from './imageGenerationService';
import * as visualIdentityPresets from './visualIdentityPresets';

// Mock dependencies
vi.mock('./sceneCameraDirector');
vi.mock('./imageGenerationService');
vi.mock('./visualIdentityPresets');

const mockCharacter: Character = {
  id: 'test-char-1',
  name: '测试角色',
  avatar: '',
  greeting: '',
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

const mockDirectorConfig = {
  provider: 'openai' as const,
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'test-key',
  model: 'gpt-4',
};

const mockRendererConfig: ImageGenerationConfig = {
  provider: 'gpt-images',
  model: 'dall-e-3',
  apiKey: 'test-key',
  baseUrl: 'https://api.openai.com/v1',
};

const mockShotPlan: SceneCameraShotPlan = {
  version: 1,
  mode: 'scene-snapshot',
  subjects: ['测试角色'],
  characterState: '站在窗边',
  playerVisibility: 'none',
  environment: '咖啡厅',
  moment: '下午时光',
  bodyOrientation: '侧身',
  expression: '沉思',
  gaze: '看向窗外',
  cameraPosition: '平视',
  shotSize: '半身',
  cameraFeel: '50mm',
  composition: '三分法',
  background: '窗外城市景观',
  lighting: '柔和自然光',
  continuityConstraints: ['保持日常形态'],
  avoidConstraints: [],
  finalPrompt: 'A character standing by the window in a cafe, thoughtful expression, looking outside',
  createdAt: Date.now(),
};

describe('generateShotPlanOnly', () => {
  it('应调用 Director 并返回 ShotPlan', async () => {
    vi.mocked(visualIdentityPresets.getActiveVisualIdentity).mockReturnValue({
      id: 'preset-1',
      name: '日常形态',
      characterId: 'test-char-1',
      isActive: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      references: [],
    });

    vi.mocked(sceneCameraDirector.callDirector).mockResolvedValue({
      shotPlan: mockShotPlan,
      rawResponse: JSON.stringify(mockShotPlan),
      metadata: { provider: 'openai', model: 'gpt-4' },
    });

    const result = await generateShotPlanOnly({
      mode: 'scene-snapshot',
      sceneContext: '角色正在咖啡厅看书',
      character: mockCharacter,
      directorConfig: mockDirectorConfig,
    });

    expect(result).toEqual(mockShotPlan);
    expect(sceneCameraDirector.callDirector).toHaveBeenCalledWith({
      apiConfig: mockDirectorConfig,
      mode: 'scene-snapshot',
      sceneContext: '角色正在咖啡厅看书',
      characterName: '测试角色',
      activePresetName: '日常形态',
      previousShotPlan: undefined,
    });
  });

  it('应传递 previousShotPlan 给 Director', async () => {
    vi.mocked(visualIdentityPresets.getActiveVisualIdentity).mockReturnValue(null);
    vi.mocked(sceneCameraDirector.callDirector).mockResolvedValue({
      shotPlan: mockShotPlan,
      rawResponse: '',
      metadata: { provider: 'openai', model: 'gpt-4' },
    });

    const previousShot: SceneCameraShotPlan = { ...mockShotPlan, createdAt: Date.now() - 10000 };

    await generateShotPlanOnly({
      mode: 'scene-snapshot',
      sceneContext: '角色继续看书',
      character: mockCharacter,
      directorConfig: mockDirectorConfig,
      previousShotPlan: previousShot,
    });

    expect(sceneCameraDirector.callDirector).toHaveBeenCalledWith(
      expect.objectContaining({
        previousShotPlan: previousShot,
      }),
    );
  });
});

describe('generateSceneCamera', () => {
  it('应完成 Director + Renderer 完整流程', async () => {
    vi.mocked(visualIdentityPresets.getActiveVisualIdentity).mockReturnValue(null);
    vi.mocked(sceneCameraDirector.callDirector).mockResolvedValue({
      shotPlan: mockShotPlan,
      rawResponse: '',
      metadata: { provider: 'openai', model: 'gpt-4' },
    });
    vi.mocked(imageGenerationService.generateImage).mockResolvedValue({
      url: 'https://example.com/generated.jpg',
      revisedPrompt: mockShotPlan.finalPrompt,
    });

    const result = await generateSceneCamera({
      mode: 'scene-snapshot',
      sceneContext: '角色在咖啡厅',
      character: mockCharacter,
      directorConfig: mockDirectorConfig,
      rendererConfig: mockRendererConfig,
    });

    // 应调用 Director
    expect(sceneCameraDirector.callDirector).toHaveBeenCalled();

    // 应调用 Renderer（imageGenerationService）
    expect(imageGenerationService.generateImage).toHaveBeenCalledWith({
      prompt: mockShotPlan.finalPrompt,
      characterId: 'test-char-1', // 自动注入 Visual Identity
      config: mockRendererConfig,
      signal: undefined,
    });

    // 应返回完整结果
    expect(result.shotPlan).toEqual(expect.objectContaining({
      finalPrompt: mockShotPlan.finalPrompt,
      rendererProvider: 'gpt-images',
      rendererModel: 'dall-e-3',
    }));
    expect(result.imageUrl).toBe('https://example.com/generated.jpg');
    expect(result.rendererMetadata).toEqual({
      provider: 'gpt-images',
      model: 'dall-e-3',
    });
  });

  it('应在 duo-photo 模式下正常工作', async () => {
    const duoShotPlan: SceneCameraShotPlan = {
      ...mockShotPlan,
      mode: 'duo-photo',
      subjects: ['测试角色', '玩家(背影)'],
      playerVisibility: 'back',
      interaction: '并肩站立',
    };

    vi.mocked(visualIdentityPresets.getActiveVisualIdentity).mockReturnValue(null);
    vi.mocked(sceneCameraDirector.callDirector).mockResolvedValue({
      shotPlan: duoShotPlan,
      rawResponse: '',
      metadata: { provider: 'openai', model: 'gpt-4' },
    });
    vi.mocked(imageGenerationService.generateImage).mockResolvedValue({
      url: 'https://example.com/duo.jpg',
      revisedPrompt: duoShotPlan.finalPrompt,
    });

    const result = await generateSceneCamera({
      mode: 'duo-photo',
      sceneContext: '角色和玩家在公园',
      character: mockCharacter,
      directorConfig: mockDirectorConfig,
      rendererConfig: mockRendererConfig,
    });

    expect(result.shotPlan.mode).toBe('duo-photo');
    expect(result.shotPlan.playerVisibility).toBe('back');
    expect(result.imageUrl).toBe('https://example.com/duo.jpg');
  });

  it('应在 Phase 3B 范围外的模式抛出错误', async () => {
    await expect(
      generateSceneCamera({
        mode: 'pov-selfie', // Phase 3B 不支持
        sceneContext: '角色自拍',
        character: mockCharacter,
        directorConfig: mockDirectorConfig,
        rendererConfig: mockRendererConfig,
      }),
    ).rejects.toThrow('Phase 3B only supports scene-snapshot and duo-photo modes');
  });

  it('应传递 signal 给 imageGenerationService', async () => {
    vi.mocked(visualIdentityPresets.getActiveVisualIdentity).mockReturnValue(null);
    vi.mocked(sceneCameraDirector.callDirector).mockResolvedValue({
      shotPlan: mockShotPlan,
      rawResponse: '',
      metadata: { provider: 'openai', model: 'gpt-4' },
    });
    vi.mocked(imageGenerationService.generateImage).mockResolvedValue({
      url: 'https://example.com/test.jpg',
      revisedPrompt: '',
    });

    const controller = new AbortController();
    await generateSceneCamera({
      mode: 'scene-snapshot',
      sceneContext: '测试',
      character: mockCharacter,
      directorConfig: mockDirectorConfig,
      rendererConfig: mockRendererConfig,
      signal: controller.signal,
    });

    expect(imageGenerationService.generateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        signal: controller.signal,
      }),
    );
  });

  it('应将 Director 和 Renderer metadata 记录到 ShotPlan', async () => {
    vi.mocked(visualIdentityPresets.getActiveVisualIdentity).mockReturnValue(null);
    vi.mocked(sceneCameraDirector.callDirector).mockResolvedValue({
      shotPlan: { ...mockShotPlan, directorProvider: 'anthropic', directorModel: 'claude-3' },
      rawResponse: '',
      metadata: { provider: 'anthropic', model: 'claude-3' },
    });
    vi.mocked(imageGenerationService.generateImage).mockResolvedValue({
      url: 'https://example.com/test.jpg',
      revisedPrompt: '',
    });

    const result = await generateSceneCamera({
      mode: 'scene-snapshot',
      sceneContext: '测试',
      character: mockCharacter,
      directorConfig: { ...mockDirectorConfig, provider: 'anthropic', model: 'claude-3' },
      rendererConfig: { ...mockRendererConfig, provider: 'gemini-native', model: 'gemini-2.0' },
    });

    expect(result.shotPlan.directorProvider).toBe('anthropic');
    expect(result.shotPlan.directorModel).toBe('claude-3');
    expect(result.shotPlan.rendererProvider).toBe('gemini-native');
    expect(result.shotPlan.rendererModel).toBe('gemini-2.0');
  });

  it('应在 Director 失败时抛出错误', async () => {
    vi.mocked(visualIdentityPresets.getActiveVisualIdentity).mockReturnValue(null);
    vi.mocked(sceneCameraDirector.callDirector).mockRejectedValue(new Error('Director API failed'));

    await expect(
      generateSceneCamera({
        mode: 'scene-snapshot',
        sceneContext: '测试',
        character: mockCharacter,
        directorConfig: mockDirectorConfig,
        rendererConfig: mockRendererConfig,
      }),
    ).rejects.toThrow('Director API failed');
  });

  it('应在 Renderer 失败时抛出错误', async () => {
    vi.mocked(visualIdentityPresets.getActiveVisualIdentity).mockReturnValue(null);
    vi.mocked(sceneCameraDirector.callDirector).mockResolvedValue({
      shotPlan: mockShotPlan,
      rawResponse: '',
      metadata: { provider: 'openai', model: 'gpt-4' },
    });
    vi.mocked(imageGenerationService.generateImage).mockRejectedValue(new Error('Image generation failed'));

    await expect(
      generateSceneCamera({
        mode: 'scene-snapshot',
        sceneContext: '测试',
        character: mockCharacter,
        directorConfig: mockDirectorConfig,
        rendererConfig: mockRendererConfig,
      }),
    ).rejects.toThrow('Image generation failed');
  });
});
