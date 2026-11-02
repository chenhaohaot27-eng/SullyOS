/**
 * Scene Camera Director Service (Phase 3B → 两阶段导演升级)
 *
 * 职责：调用高阶文本模型，基于场景上下文生成结构化 ShotPlan。
 *
 * Director 是 Scene Camera 的第一层：读取见面场景文本，输出摄影方案 JSON。
 * Renderer 是第二层：读取 ShotPlan.finalPrompt，调用图像模型生成照片。
 *
 * 这两层完全解耦，Director 可以用任意文本模型（GPT/Claude/Gemini），
 * Renderer 可以用任意图像模型（GPT Images/Gemini Native/FLUX）。
 *
 * 升级（原文叙事优先）：Director 内部改为两阶段——
 *   阶段一 Scene Analysis（场景解析）→ 阶段二 Prompt Directing（视觉导演）；
 * 导演层任何失败都在内部降级为「基础 prompt 生成模式」，不再向调用方抛错
 * （用户中止除外）。旧的直接抛错契约由 service 层测试 mock 保持兼容。
 */

import type { SceneAnalysis, SceneCameraShotPlan, SceneCameraMode, SceneImageOptions } from '../types';
import type { DirectorApiConfig } from './sceneCameraPrompt';
import { runTwoStageDirector } from './sceneImageDirector';
import { completeChat } from './chatCompletionClient';
import {
  buildDirectorSystemPrompt,
  buildDirectorUserPrompt,
  parseShotPlanFromJson,
  enrichAvoidConstraints,
} from './sceneCameraPrompt';

/** Director 调用的输入参数。 */
export interface DirectorInput {
  /** Director API 配置（provider、model、credentials） */
  apiConfig: DirectorApiConfig;
  /** 摄影模式 */
  mode: SceneCameraMode;
  /** 场景上下文文本（近期对话压缩 + 当前状态） */
  sceneContext: string;
  /** 角色名 */
  characterName: string;
  /** 当前 Visual Identity preset 名称（用于 continuityConstraints） */
  activePresetName?: string;
  /** 上一次 ShotPlan（用于差异化） */
  previousShotPlan?: SceneCameraShotPlan;
  /** 画面导演选项（构图方式 / 环境保留 / 人物焦点）；缺省使用默认值 */
  options?: SceneImageOptions;
  /** 用户选中的原文（「选中文本生图」时的最高画面依据） */
  selectedText?: string;
  /** 当前图像模型类型（gpt-images / openai-images / gemini-native 等） */
  rendererProvider?: string;
  /** 中止信号（中止不是失败，原样上抛） */
  signal?: AbortSignal;
}

/** Director 调用的输出结果。 */
export interface DirectorOutput {
  /** 生成的 ShotPlan */
  shotPlan: SceneCameraShotPlan;
  /** 原始 LLM 返回的文本（调试用；完全回退时为空串） */
  rawResponse: string;
  /** Director 使用的 provider 和 model */
  metadata: {
    provider: string;
    model: string;
  };
  /** 阶段一场景解析结果（解析失败时为 undefined） */
  sceneAnalysis?: SceneAnalysis;
  /** 降级说明（阶段降级或完全回退到基础直生成时给出） */
  fallbackNotice?: string;
}

/**
 * 调用 Director（高阶文本模型）生成 ShotPlan —— 两阶段导演版本。
 *
 * 导演层失败（网络 / 超时 / JSON 无效）在内部降级为基础直生成，不抛错；
 * 仅当用户中止（AbortSignal）时原样上抛。
 */
export async function callDirector(input: DirectorInput): Promise<DirectorOutput> {
  const { apiConfig } = input;

  // 两阶段导演内部已消化所有导演层失败（降级为基础直生成）；
  // 这里只会因用户中止（AbortSignal）上抛。
  const result = await runTwoStageDirector(input);
  return {
    shotPlan: result.shotPlan,
    rawResponse: result.rawResponse,
    metadata: { provider: apiConfig.provider, model: apiConfig.model },
    sceneAnalysis: result.sceneAnalysis,
    fallbackNotice: result.fallbackNotice,
  };
}

/**
 * 旧版单阶段 Director 调用（legacy，保留给仍依赖旧契约的调用方 / 对照调试）。
 * 新代码请使用 callDirector（两阶段 + 降级）。
 */
export async function callDirectorLegacy(input: {
  apiConfig: DirectorApiConfig;
  mode: SceneCameraMode;
  sceneContext: string;
  characterName: string;
  activePresetName?: string;
  previousShotPlan?: SceneCameraShotPlan;
}): Promise<DirectorOutput> {
  const { apiConfig, mode, sceneContext, characterName, activePresetName, previousShotPlan } = input;

  const systemPrompt = buildDirectorSystemPrompt();
  const userPrompt = buildDirectorUserPrompt({
    mode,
    sceneContext,
    characterName,
    activePresetName,
    previousShotPlan,
  });

  const apiConfigForChat = {
    baseUrl: apiConfig.baseUrl,
    apiKey: apiConfig.apiKey,
    model: apiConfig.model,
    apiFormat: apiConfig.provider === 'gemini-native' ? 'gemini-native' : 'openai-compatible',
  };

  const body = {
    model: apiConfig.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.7,
    max_tokens: 2048,
    stream: false,
  };

  const response = await completeChat(apiConfigForChat, body);

  const rawResponse = response.choices?.[0]?.message?.content
    || response.content
    || JSON.stringify(response);

  let shotPlan = parseShotPlanFromJson(rawResponse, mode);
  shotPlan = enrichAvoidConstraints(shotPlan, previousShotPlan);
  shotPlan.directorProvider = apiConfig.provider;
  shotPlan.directorModel = apiConfig.model;

  return {
    shotPlan,
    rawResponse,
    metadata: {
      provider: apiConfig.provider,
      model: apiConfig.model,
    },
  };
}

