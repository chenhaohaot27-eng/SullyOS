/**
 * Scene Image Director（两阶段导演编排）
 *
 * 阶段一（Scene Analysis）：文本模型把原文转译成结构化 SceneAnalysis；
 * 阶段二（Prompt Directing）：结合解析结果 + 用户选项（构图方式 / 环境保留 / 人物焦点）
 * 生成最终 ShotPlan（含 finalPrompt）。
 *
 * 稳定性要求（回退 / 降级）：
 * - 阶段一失败（网络 / 超时 / JSON 无效）→ 跳过解析，阶段二直接依据原文导演；
 * - 阶段二也失败 → 本地「基础 prompt 生成模式」（原文 + 基础设定 + 选项取向），
 *   绝不让导演问题阻断生图流程；通过 fallbackNotice 给出明确但不烦人的提示。
 * - 用户中止（AbortSignal）不是失败：原样上抛，由调用方静默处理。
 */

import type { SceneAnalysis, SceneCameraMode, SceneCameraShotPlan, SceneImageOptions } from '../types';
import type { DirectorApiConfig } from './sceneCameraPrompt';
import { parseShotPlanFromJson, enrichAvoidConstraints } from './sceneCameraPrompt';
import { buildSceneAnalysisSystemPrompt, buildSceneAnalysisUserPrompt, parseSceneAnalysis } from './buildSceneAnalysisPrompt';
import { buildSceneDirectingSystemPrompt, buildSceneDirectingUserPrompt, buildBasicShotPlan } from './buildSceneImagePrompt';
import { DEFAULT_SCENE_IMAGE_OPTIONS } from './imageGenerationOptions';
import { completeChat } from './chatCompletionClient';

export const DIRECTOR_FALLBACK_NOTICE = '导演解析失败，已改为直接根据原文生成';

/** 两阶段导演输入。 */
export interface TwoStageDirectorInput {
  apiConfig: DirectorApiConfig;
  mode: SceneCameraMode;
  /** 场景上下文（近期对话压缩 + 当前状态）。 */
  sceneContext: string;
  /** 用户选中的原文（选中文本生图时的最高画面依据）。 */
  selectedText?: string;
  characterName: string;
  activePresetName?: string;
  previousShotPlan?: SceneCameraShotPlan;
  /** 导演选项；缺省使用默认值（narrative_balanced / key_elements / auto / 开启导演）。 */
  options?: SceneImageOptions;
  /** 当前图像模型类型（提示阶段二适配 prompt 风格）。 */
  rendererProvider?: string;
  /** 中止信号（中止不是失败，直接上抛）。 */
  signal?: AbortSignal;
}

/** 两阶段导演输出。 */
export interface TwoStageDirectorOutput {
  shotPlan: SceneCameraShotPlan;
  /** 阶段一场景解析结果（解析失败时为 undefined）。 */
  sceneAnalysis?: SceneAnalysis;
  /** 降级说明（阶段降级或完全回退时给出，供 UI 提示）。 */
  fallbackNotice?: string;
  /** 阶段二原始返回（调试用；完全回退时为空串）。 */
  rawResponse: string;
}

function toChatApiConfig(apiConfig: DirectorApiConfig) {
  return {
    baseUrl: apiConfig.baseUrl,
    apiKey: apiConfig.apiKey,
    model: apiConfig.model,
    apiFormat: apiConfig.provider === 'gemini-native' ? 'gemini-native' as const : undefined,
  };
}

function extractContent(response: unknown): string {
  const r = response as { choices?: Array<{ message?: { content?: unknown } }>; content?: unknown };
  const choice = r?.choices?.[0]?.message?.content;
  if (typeof choice === 'string' && choice) return choice;
  if (typeof r?.content === 'string' && r.content) return r.content;
  return JSON.stringify(response ?? '');
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return !!signal?.aborted || (error instanceof Error && error.name === 'AbortError');
}

/**
 * 运行两阶段导演。除「用户中止」外不抛错——任何导演层失败都降级为基础直生成。
 */
export async function runTwoStageDirector(input: TwoStageDirectorInput): Promise<TwoStageDirectorOutput> {
  const {
    apiConfig, mode, sceneContext, selectedText, characterName,
    activePresetName, previousShotPlan, rendererProvider, signal,
  } = input;
  const options = input.options ?? DEFAULT_SCENE_IMAGE_OPTIONS;

  // 原文叙事优先：选中文本存在时，它是画面最高依据，场景上下文只作补充。
  const trimmedSelection = selectedText?.trim();
  const isSelected = !!trimmedSelection;
  const narrativeText = isSelected
    ? `【本次拍摄原文（最高依据）】\n${trimmedSelection}\n\n【补充场景上下文】\n${sceneContext}`
    : sceneContext;

  const chatConfig = toChatApiConfig(apiConfig);

  // ── 阶段一：场景解析（失败不致命） ──
  let sceneAnalysis: SceneAnalysis | undefined;
  let stage1Notice: string | undefined;
  try {
    const analysisResponse = await completeChat(chatConfig, {
      model: apiConfig.model,
      messages: [
        { role: 'system', content: buildSceneAnalysisSystemPrompt() },
        { role: 'user', content: buildSceneAnalysisUserPrompt({ narrativeText, characterName }) },
      ],
      temperature: 0.4,
      max_tokens: 1024,
      stream: false,
    }, { signal });
    sceneAnalysis = parseSceneAnalysis(extractContent(analysisResponse));
  } catch (error) {
    if (isAbortError(error, signal)) throw error;
    stage1Notice = '场景解析未成功，已直接依据原文导演';
  }

  // ── 阶段二：视觉导演（失败 → 基础直生成 fallback） ──
  try {
    const directingResponse = await completeChat(chatConfig, {
      model: apiConfig.model,
      messages: [
        { role: 'system', content: buildSceneDirectingSystemPrompt(options) },
        { role: 'user', content: buildSceneDirectingUserPrompt({
          mode,
          narrativeText,
          isSelectedText: isSelected,
          sceneAnalysis,
          characterName,
          activePresetName,
          options,
          rendererProvider,
          previousShotPlan,
        }) },
      ],
      temperature: 0.7,
      max_tokens: 2048,
      stream: false,
    }, { signal });

    const raw = extractContent(directingResponse);
    let shotPlan = parseShotPlanFromJson(raw, mode);
    shotPlan.sceneAnalysis = sceneAnalysis;
    if (stage1Notice) shotPlan.directorFallbackReason = stage1Notice;
    shotPlan = enrichAvoidConstraints(shotPlan, previousShotPlan);
    shotPlan.directorProvider = apiConfig.provider;
    shotPlan.directorModel = apiConfig.model;

    return {
      shotPlan,
      sceneAnalysis,
      fallbackNotice: stage1Notice,
      rawResponse: raw,
    };
  } catch (error) {
    if (isAbortError(error, signal)) throw error;

    // 完全回退：基础 prompt 生成模式（原文 + 基础设定 + 选项取向），生图流程不被阻断。
    const shotPlan = buildBasicShotPlan({
      mode,
      narrativeText,
      characterName,
      options,
      fallbackReason: DIRECTOR_FALLBACK_NOTICE,
      sceneAnalysis,
    });
    const enriched = enrichAvoidConstraints(shotPlan, previousShotPlan);
    return {
      shotPlan: enriched,
      sceneAnalysis,
      fallbackNotice: DIRECTOR_FALLBACK_NOTICE,
      rawResponse: '',
    };
  }
}
