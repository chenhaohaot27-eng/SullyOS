/**
 * Scene Camera Service (Phase 3B)
 *
 * 职责：Scene Camera 的完整编排层，协调 Director + Renderer 两阶段生成。
 *
 * 流程：
 * 1. 调用 Director（文本模型）生成 ShotPlan
 * 2. 调用 Renderer（图像模型）基于 ShotPlan.finalPrompt 生成照片
 * 3. 按实际参考图顺序绑定玩家和角色身份
 * 4. 自动应用 photoSemantics 约束（由 imageGenerationService 处理）
 *
 * Phase 3B 限制：
 * - 只支持 scene-snapshot 和 duo-photo 模式
 * - 不新增数据库表
 * - 不修改现有聊天生图行为
 */

import type {
  SceneCameraMode,
  SceneCameraShotPlan,
  SceneImageOptions,
  UserProfile,
  CharacterProfile,
  ImageGenerationConfig,
  ImageGenerationAspectRatio,
} from '../types';
import type { DirectorApiConfig } from './sceneCameraPrompt';
import { callDirector } from './sceneCameraDirector';
import { generateImage } from './imageGenerationService';
import { prepareCameraReferences, type CameraReference } from './sceneCameraReferences';
import { getActiveVisualIdentity, getActiveVisualIdentityPreset } from './visualIdentityPresets';

/** Scene Camera 生成请求参数。 */
export interface SceneCameraRequest {
  /** 摄影模式（Phase 3B 只支持 scene-snapshot 和 duo-photo） */
  mode: SceneCameraMode;
  /** 场景上下文文本（近期对话 + 当前状态） */
  sceneContext: string;
  /** 角色对象 */
  character: CharacterProfile;
  player?: UserProfile;
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
  /** 画面导演选项（构图方式 / 环境保留 / 人物焦点 / 导演开关） */
  options?: SceneImageOptions;
  /** 用户选中的原文（「选中文本生图」时的最高画面依据） */
  selectedText?: string;
}

/** Scene Camera 生成结果。 */
export interface SceneCameraResult {
  /** 生成的 ShotPlan */
  shotPlan: SceneCameraShotPlan;
  /** 生成的图像 URL（base64 data URL 或 https URL） */
  imageUrl: string;
  references?: CameraReference[];
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
  const { mode, rendererConfig } = request;

  // Phase 3B 范围限制
  if (mode !== 'scene-snapshot' && mode !== 'duo-photo') {
    throw new Error(`Phase 3B only supports scene-snapshot and duo-photo modes, got: ${mode}`);
  }

  const shotPlan = await generateShotPlanOnly({ ...request, rendererProvider: rendererConfig.provider });
  return renderShotPlan({ ...request, shotPlan });
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
  player?: UserProfile;
  directorConfig: DirectorApiConfig;
  previousShotPlan?: SceneCameraShotPlan;
  /** 画面导演选项（构图方式 / 环境保留 / 人物焦点 / 导演开关） */
  options?: SceneImageOptions;
  /** 用户选中的原文（「选中文本生图」时的最高画面依据） */
  selectedText?: string;
  /** 当前图像模型类型（提示阶段二适配 prompt 风格） */
  rendererProvider?: string;
  /** 中止信号 */
  signal?: AbortSignal;
}): Promise<SceneCameraShotPlan> {
  const { mode, sceneContext, character, directorConfig, previousShotPlan, options, selectedText, rendererProvider, signal } = request;

  const activePreset = getActiveVisualIdentityPreset(character);

  const playerIdentity = request.player && getActiveVisualIdentity(request.player);
  const directorOutput = await callDirector({
    apiConfig: directorConfig,
    mode,
    sceneContext,
    characterName: character.name,
    ...(request.player ? { playerName: request.player.name, playerHasReferences: !!(playerIdentity?.enabled && playerIdentity.references?.length) } : {}),
    activePresetName: activePreset?.name,
    previousShotPlan,
    ...(options ? { options } : {}),
    ...(selectedText ? { selectedText } : {}),
    ...(rendererProvider ? { rendererProvider } : {}),
    ...(signal ? { signal } : {}),
  });

  return directorOutput.shotPlan;
}

/**
 * 只重新调用 Renderer（Phase 3C：「重拍同一镜头」/ Renderer 失败重试）。
 *
 * 语义：
 * - 保留传入的 ShotPlan，不重新调用 Director
 * - 允许调用方更换 rendererConfig（换生图模型后重拍）
 * - 重新读取当前形态，生成本次请求及预览共用的参考图列表
 */
export async function renderShotPlan(request: {
  shotPlan: SceneCameraShotPlan;
  character: CharacterProfile;
  player?: UserProfile;
  rendererConfig: ImageGenerationConfig;
  aspectRatio?: ImageGenerationAspectRatio;
  signal?: AbortSignal;
}): Promise<SceneCameraResult> {
  const { shotPlan, character, rendererConfig, aspectRatio, signal } = request;

  const { references, instructions } = await prepareCameraReferences(character, request.player, rendererConfig);
  const imageResult = await generateImage({
    prompt: [shotPlan.finalPrompt, instructions].filter(Boolean).join('\n\n'),
    referenceImages: references.map(ref => ref.data),
    ...(references.length ? { identityActive: true } : {}),
    aspectRatio,
    signal,
  }, rendererConfig);
  const imageUrl = extractImageUrl(imageResult);

  const updatedShotPlan: SceneCameraShotPlan = {
    ...shotPlan,
    rendererProvider: rendererConfig.provider,
    rendererModel: rendererConfig.model,
  };

  return {
    shotPlan: updatedShotPlan,
    references,
    imageUrl,
    rendererMetadata: {
      provider: rendererConfig.provider,
      model: rendererConfig.model,
    },
  };
}
