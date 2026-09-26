/**
 * Scene Camera Director Service (Phase 3B)
 *
 * 职责：调用高阶文本模型，基于场景上下文生成结构化 ShotPlan。
 *
 * Director 是 Scene Camera 的第一层：读取见面场景文本，输出摄影方案 JSON。
 * Renderer 是第二层：读取 ShotPlan.finalPrompt，调用图像模型生成照片。
 *
 * 这两层完全解耦，Director 可以用任意文本模型（GPT/Claude/Gemini），
 * Renderer 可以用任意图像模型（GPT Images/Gemini Native/FLUX）。
 */

import type { SceneCameraShotPlan, SceneCameraMode } from '../types';
import type { DirectorApiConfig } from './sceneCameraPrompt';
import {
  buildDirectorSystemPrompt,
  buildDirectorUserPrompt,
  parseShotPlanFromJson,
  enrichAvoidConstraints,
} from './sceneCameraPrompt';
import { completeChat } from './chatCompletionClient';

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
}

/** Director 调用的输出结果。 */
export interface DirectorOutput {
  /** 生成的 ShotPlan */
  shotPlan: SceneCameraShotPlan;
  /** 原始 LLM 返回的文本（调试用） */
  rawResponse: string;
  /** Director 使用的 provider 和 model */
  metadata: {
    provider: string;
    model: string;
  };
}

/**
 * 调用 Director（高阶文本模型）生成 ShotPlan。
 *
 * @throws 当 API 调用失败或 JSON 解析失败时抛出错误
 */
export async function callDirector(input: DirectorInput): Promise<DirectorOutput> {
  const { apiConfig, mode, sceneContext, characterName, activePresetName, previousShotPlan } = input;

  // 构建 Director prompt
  const systemPrompt = buildDirectorSystemPrompt();
  const userPrompt = buildDirectorUserPrompt({
    mode,
    sceneContext,
    characterName,
    activePresetName,
    previousShotPlan,
  });

  // 调用 completeChat（统一的文本模型接口）
  const apiConfigForChat = {
    baseUrl: apiConfig.baseUrl,
    apiKey: apiConfig.apiKey,
    model: apiConfig.model,
    apiFormat: apiConfig.provider === 'gemini-native' ? 'gemini-native' : 'openai',
  };

  const body = {
    model: apiConfig.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.7, // Director 需要一定创造力设计镜头
    max_tokens: 2048, // ShotPlan JSON 不会太长
    stream: false,
  };

  const response = await completeChat(apiConfigForChat, body);

  // 提取文本内容（兼容 OpenAI 和 Gemini 响应格式）
  const rawResponse = response.choices?.[0]?.message?.content
    || response.content
    || JSON.stringify(response);

  // 解析 JSON（容错处理 markdown code fence）
  let shotPlan = parseShotPlanFromJson(rawResponse, mode);

  // 差异化增强：基于 previousShotPlan 补充 avoidConstraints
  shotPlan = enrichAvoidConstraints(shotPlan, previousShotPlan);

  // 记录 Director metadata
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
