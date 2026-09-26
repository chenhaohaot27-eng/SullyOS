/**
 * Scene Camera Service (Phase 3B)
 *
 * 职责：Scene Camera 的完整编排层，协调 Director + Renderer 两阶段生成。
 *
 * 流程：
 * 1. 调用 Director（文本模型）生成 ShotPlan
 * 2. 调用 Renderer（图像模型）基于 ShotPlan.finalPrompt 生成照片
 * 3. 自动注入 Visual Identity references（由 imageGenerationService 处理）
 * 4. 自动应用 photoSemantics 约束（由 imageGenerationService 处理）
 *
 * Phase 3B 限制：
 * - 只支持 scene-snapshot 和 duo-photo 模式
 * - 不新增 Player Visual Identity
 * - 不新增数据库表
 * - 不修改现有聊天生图行为
 */

import type {
  SceneCameraMode,
  SceneCameraShotPlan,
  VisualIdentityPreset,
  CharacterProfile,
  ImageGenerationConfig,
  ImageGenerationAspectRatio,
} from '../types';
import type { DirectorApiConfig } from './sceneCameraPrompt';
import { callDirector } from './sceneCameraDirector';
import { generateImage } from './imageGenerationService';
import { getActiveVisualIdentity } from './visualIdentityPresets';

/** Scene Camera 生成请求参数。 */
export interface SceneCameraRequest {
  /** 摄影模式（Phase 3B 只支持 scene-snapshot 和 duo-photo） */
  mode: SceneCameraMode;
  /** 场景上下文文本（近期对话 + 当前状态） */
  sceneContext: string;
  /** 角色对象 */
  character: CharacterProfile;
  /** Director API 配置 */
  directorConfig: DirectorApiConfig;
  /** Renderer (图像生成) 配置 */
  rendererConfig: ImageGenerationConfig;
  /** 画面宽高比（缺省回落到生图配置的 defaultAspectRatio） */
  aspectRatio?: ImageGenerationAspectRatio;
  /** 上一次的 ShotPlan（用于差异化） */
  previousShotPlan?: SceneCameraShotPlan;
  /** 中止信号 */
  signal?: AbortSignal;
}

/** Scene Camera 生成结果。 */
export interface SceneCameraResult {
  /** 生成的 ShotPlan */
  shotPlan: SceneCameraShotPlan;
  /** 生成的图像 URL（base64 data URL 或 https URL） */
  imageUrl: string;
  /** 图像模型使用的 provider 和 model */
  rendererMetadata: {
    provider: string;
    model: string;
  };
}

/**
 * 生成 Scene Camera 照片（完整流程）。
 *
 * @throws 当 Director 或 Renderer 调用失败时抛出错误
 */
export async function generateSceneCamera(request: SceneCameraRequest): Promise<SceneCameraResult> {
  const { mode, sceneContext, character, directorConfig, rendererConfig, previousShotPlan, signal } = request;

  // Phase 3B 范围限制
  if (mode !== 'scene-snapshot' && mode !== 'duo-photo') {
    throw new Error(`Phase 3B only supports scene-snapshot and duo-photo modes, got: ${mode}`);
  }

  // 获取角色当前的 Visual Identity preset（用于 continuityConstraints）
  const activePreset = getActiveVisualIdentity(character);

  // Step 1: 调用 Director 生成 ShotPlan
  const directorOutput = await callDirector({
    apiConfig: directorConfig,
    mode,
    sceneContext,
    characterName: character.name,
    activePresetName: activePreset?.name,
    previousShotPlan,
  });

  const shotPlan = directorOutput.shotPlan;

  // Step 2: 调用 Renderer 生成图像
  // imageGenerationService 会自动：
  // - 注入 Visual Identity references（基于 characterId）
  // - 应用 photoSemantics 约束
  // - 处理 provider 适配（GPT Images / Gemini Native）
  const imageResult = await generateImage({
    prompt: shotPlan.finalPrompt,
    characterId: character.id, // 自动注入 Visual Identity
    aspectRatio: request.aspectRatio,
    config: rendererConfig, // 保留 3B 调用契约；实际配置源仍是 imageGenerationSettings
    signal,
  });
  const imageUrl = extractImageUrl(imageResult);

  // 记录 Renderer metadata 到 ShotPlan
  shotPlan.rendererProvider = rendererConfig.provider;
  shotPlan.rendererModel = rendererConfig.model;

  return {
    shotPlan,
    imageUrl,
    rendererMetadata: {
      provider: rendererConfig.provider,
      model: rendererConfig.model,
    },
  };
}

/**
 * 从 imageGenerationService 返回值中提取图片 URL。
 * 真实 ImageGenerationResult 的图片在 images[]；Phase 3B 测试 mock 直接给 url，
 * 两者都兼容，取不到时抛错（Renderer 空响应）。
 */
function extractImageUrl(imageResult: { images?: Array<{ url?: string }>; url?: string }): string {
  const url = imageResult?.images?.[0]?.url || imageResult?.url;
  if (!url) throw new Error('Renderer 未返回任何图片');
  return url;
}

/**
 * 仅生成 ShotPlan（不生成图像）。
 *
 * 用途：
 * - 测试 Director 层
 * - 预览摄影方案
 * - 调试 prompt 设计
 */
export async function generateShotPlanOnly(request: {
  mode: SceneCameraMode;
  sceneContext: string;
  character: CharacterProfile;
  directorConfig: DirectorApiConfig;
  previousShotPlan?: SceneCameraShotPlan;
}): Promise<SceneCameraShotPlan> {
  const { mode, sceneContext, character, directorConfig, previousShotPlan } = request;

  const activePreset = getActiveVisualIdentity(character);

  const directorOutput = await callDirector({
    apiConfig: directorConfig,
    mode,
    sceneContext,
    characterName: character.name,
    activePresetName: activePreset?.name,
    previousShotPlan,
  });

  return directorOutput.shotPlan;
}

/**
 * 只重新调用 Renderer（Phase 3C：「重拍同一镜头」/ Renderer 失败重试）。
 *
 * 语义：
 * - 保留传入的 ShotPlan，不重新调用 Director
 * - 允许调用方更换 rendererConfig（换生图模型后重拍）
 * - characterId 继续传递，保证 active Visual Identity 自动生效
 */
export async function renderShotPlan(request: {
  shotPlan: SceneCameraShotPlan;
  character: CharacterProfile;
  rendererConfig: ImageGenerationConfig;
  aspectRatio?: ImageGenerationAspectRatio;
  signal?: AbortSignal;
}): Promise<SceneCameraResult> {
  const { shotPlan, character, rendererConfig, aspectRatio, signal } = request;

  const imageResult = await generateImage({
    prompt: shotPlan.finalPrompt,
    characterId: character.id, // 自动注入 Visual Identity（与完整流程一致）
    aspectRatio,
    config: rendererConfig, // 保留与 generateSceneCamera 一致的调用契约
    signal,
  });
  const imageUrl = extractImageUrl(imageResult);

  const updatedShotPlan: SceneCameraShotPlan = {
    ...shotPlan,
    rendererProvider: rendererConfig.provider,
    rendererModel: rendererConfig.model,
  };

  return {
    shotPlan: updatedShotPlan,
    imageUrl,
    rendererMetadata: {
      provider: rendererConfig.provider,
      model: rendererConfig.model,
    },
  };
}
