/**
 * Scene Analysis Prompt Builder（两阶段导演 · 阶段一：场景解析）
 *
 * 职责：把「被选中的原文 / 场景上下文」转译成结构化 SceneAnalysis JSON。
 *
 * 核心原则（原文叙事优先）：
 * - 只做忠实转译，不做价值判断：原文里的人物、动作、情绪、物件、空间、
 *   人物关系（包括亲密、冲突、成人向内容）原样提取，不得净化、省略或弱化；
 * - 解析结果服务于阶段二「视觉导演」，谁重要就标注谁，不预设双人构图；
 * - 解析失败不致命：调用方（sceneImageDirector）会降级继续。
 */

import type { SceneAnalysis } from '../types';

/** 阶段一 system prompt：只提取、不改写、不净化。 */
export function buildSceneAnalysisSystemPrompt(): string {
  return `# Scene Analysis（场景解析）

你是一名电影的前期场景分析师。你的唯一任务是阅读一段叙事文本，提取出结构化的场景信息，供后续视觉导演使用。

## 解析原则

1. 忠实转译，不改写剧情：只提取文本中真实存在的信息，不添加未发生的事件，也不删改既有事实。
2. 不净化、不弱化：原文中的人物关系、动作、情绪、张力（包括亲密、冲突、暴力或成人向内容）都必须原样保留在解析结果里。你的职责是帮助后续画面忠实还原原文，不是审查原文。
3. 叙事主体由文本决定：谁在文本中占据叙事重心，谁就是 primary_subject 的候选——主角、玩家、NPC、群像、甚至环境或事件本身都可以。不要预设「必须以某两个人为中心」。
4. 不替玩家编造关键行为；玩家未在原文出现时不要硬加进画面建议。

## 输出格式

必须输出严格的 JSON（不要 markdown code fence，不要额外解释）：

{
  "characters_present": ["出场人物（含玩家/NPC，用文本中的称呼）"],
  "primary_subject": "当前叙事主体 / 画面主体建议（一段短语）",
  "secondary_subjects": ["次要主体"],
  "key_actions": ["关键动作"],
  "setting": "场景空间",
  "important_objects": ["关键物件"],
  "mood_tone": "情绪与氛围",
  "relationship_dynamics": "人物关系 / 互动性质",
  "camera_suggestion": "建议景别 / 机位 / 视角（由文本重心推导，不套模板）",
  "composition_reasoning": "为什么这样构图（一两句）",
  "environment_priority": "low | medium | high（环境在文本中的分量）",
  "npc_visual_priority": "none | secondary | primary（NPC 是否应成为画面主体）"
}`;
}

/** 阶段一 user prompt：携带需要解析的叙事文本。 */
export function buildSceneAnalysisUserPrompt(input: {
  /** 叙事文本：优先为用户选中的原文；否则为场景上下文。 */
  narrativeText: string;
  /** 当前角色名（帮助区分「当前角色 / 玩家 / NPC」）。 */
  characterName: string;
}): string {
  return `## 待解析文本

${input.narrativeText}

## 角色信息

当前主角色名：${input.characterName}（文本中其他人物若无特殊说明视为 NPC；「玩家/你」指用户本人）

请严格按照 JSON 格式输出场景解析结果。`;
}

/** 去除 markdown code fence 与首尾杂质的容错清洗。 */
function stripCodeFence(text: string): string {
  let cleaned = text.trim();
  if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
  else if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
  if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
  return cleaned.trim();
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

/**
 * 解析阶段一返回的 SceneAnalysis JSON（容错：code fence / 缺字段补默认值）。
 * @throws JSON 语法完全无法解析时抛错（由调用方决定降级策略）
 */
export function parseSceneAnalysis(rawText: string): SceneAnalysis {
  const cleaned = stripCodeFence(rawText);
  // 容错：截取第一个 { 到最后一个 } 之间的内容（模型偶尔前后带说明文字）
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  const candidate = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;

  const parsed = JSON.parse(candidate) as Record<string, unknown>;
  return {
    characters_present: asStringArray(parsed.characters_present),
    primary_subject: asString(parsed.primary_subject, '由文本决定的叙事主体'),
    secondary_subjects: asStringArray(parsed.secondary_subjects),
    key_actions: asStringArray(parsed.key_actions),
    setting: asString(parsed.setting, '文本描述的空间'),
    important_objects: asStringArray(parsed.important_objects),
    mood_tone: asString(parsed.mood_tone, '文本传达的情绪氛围'),
    relationship_dynamics: asString(parsed.relationship_dynamics, '文本中呈现的人物关系'),
    camera_suggestion: asString(parsed.camera_suggestion, '由文本重心决定的景别与机位'),
    composition_reasoning: asString(parsed.composition_reasoning, '按文本叙事重心构图'),
    environment_priority: asString(parsed.environment_priority, 'medium'),
    npc_visual_priority: asString(parsed.npc_visual_priority, 'none'),
  };
}

/** UI「导演思路预览」用的摘要行（不暴露完整 JSON，控制信息量）。 */
export function summarizeSceneAnalysis(analysis: SceneAnalysis): string[] {
  const lines: string[] = [];
  if (analysis.characters_present.length) lines.push(`出场：${analysis.characters_present.join('、')}`);
  lines.push(`画面主体：${analysis.primary_subject}`);
  if (analysis.secondary_subjects.length) lines.push(`次要：${analysis.secondary_subjects.join('、')}`);
  if (analysis.key_actions.length) lines.push(`动作：${analysis.key_actions.join('；')}`);
  if (analysis.setting) lines.push(`空间：${analysis.setting}`);
  if (analysis.important_objects.length) lines.push(`关键物件：${analysis.important_objects.join('、')}`);
  if (analysis.mood_tone) lines.push(`氛围：${analysis.mood_tone}`);
  if (analysis.relationship_dynamics) lines.push(`关系：${analysis.relationship_dynamics}`);
  if (analysis.camera_suggestion) lines.push(`镜头：${analysis.camera_suggestion}`);
  if (analysis.composition_reasoning) lines.push(`构图理由：${analysis.composition_reasoning}`);
  return lines;
}
