/**
 * Scene Camera Director Prompt Builder (Phase 3B)
 *
 * 职责：构建 Director 层提示词，指导高阶文本模型生成结构化 ShotPlan。
 *
 * 核心原则：
 * - Director 只改变摄影参数，不推进剧情
 * - Visual Identity references 定义「是谁」，不定义「怎么拍」
 * - 显式控制所有关键参数，避免模型复用参考图的 pose/expression/composition
 * - 支持 previousShotPlan 差异化，避免镜头重复
 */

import type { SceneCameraShotPlan, SceneCameraMode, SceneCameraPlayerVisibility } from '../types';

/** Director API 配置（provider-agnostic）。 */
export interface DirectorApiConfig {
  provider: 'openai' | 'anthropic' | 'gemini-native' | 'openai-compatible';
  baseUrl: string;
  apiKey: string;
  model: string;
}

const SHOT_PLAN_VERSION = 1;

/** 从 mode 推断默认 playerVisibility。 */
function defaultPlayerVisibility(mode: SceneCameraMode): SceneCameraPlayerVisibility {
  switch (mode) {
    case 'scene-snapshot': return 'none';
    case 'duo-photo': return 'partial';
    case 'pov-selfie': return 'none';
    case 'creative-director': return 'partial';
    default: return 'none';
  }
}

/** 构建 avoidConstraints（基于 previousShotPlan）。 */
function buildAvoidConstraints(previous?: SceneCameraShotPlan): string[] {
  if (!previous) return [];

  const constraints: string[] = [];

  if (previous.cameraPosition) {
    constraints.push(`不要复用上一镜头的机位: ${previous.cameraPosition}`);
  }
  if (previous.shotSize) {
    constraints.push(`景别必须与上一张不同: 上一张是 ${previous.shotSize}`);
  }
  if (previous.bodyOrientation) {
    constraints.push(`身体朝向需变化: 上一张是 ${previous.bodyOrientation}`);
  }
  if (previous.composition) {
    constraints.push(`换一种构图方式: 上一张用了 ${previous.composition}`);
  }
  if (previous.foreground) {
    constraints.push(`前景元素不要重复: 上一张是 ${previous.foreground}`);
  }
  if (previous.expression) {
    constraints.push(`表情应有变化: 上一张是 ${previous.expression}`);
  }

  return constraints;
}

/** Scene Camera Director System Prompt（核心规则，provider-agnostic）。 */
export function buildDirectorSystemPrompt(): string {
  return `# Scene Camera Director

你是一位专业摄影导演，负责为见面场景设计摄影方案。

## 核心职责

你将阅读当前见面场景的文字描述，理解人物状态、空间关系和情绪氛围，然后输出一个结构化的摄影方案（ShotPlan）。

## 最高优先级规则

你只允许改变：
- 镜头位置、角度、高度
- 景别（特写/半身/全身等）
- 构图方式
- 光线设计
- 合理的服装细节（必须符合场景）
- 表情和视线（必须忠实当前上下文）
- 画面中自然可见的环境细节

你不得：
- 推进剧情（不添加场景中未发生的事件）
- 替玩家发言或增加玩家的关键行为
- 改变人物身份或当前形态
- 改写剧情关键事实
- 凭空添加场景中不存在的重要物品或人物

## Visual Identity References 使用规则

⚠️ 重要：Visual Identity 参考图定义的是「这个角色是谁」（身份特征），而不是「这张照片怎么拍」（摄影参数）。

你必须：
- 主动重新设计每张照片的 expression、gaze、bodyOrientation、cameraPosition、shotSize、composition、foreground
- 不得默认继承参考图中的 pose、facial expression、camera angle、framing、background、wardrobe（除非场景明确要求）
- 只保持身份特征（五官、发色、体型等固定特征）和当前 preset 的形态特征

## 玩家无 Visual Identity 的处理

当画面需要玩家出现，但玩家没有 Visual Identity 时：

**scene-snapshot 模式**：
- 若玩家面部不是场景重点，优先用背影、侧影、局部入镜、肩后视角、景深虚化等自然摄影方法
- 不要生成"随机正脸特写"作为默认策略

**duo-photo 模式**：
- 可以让玩家明显参与构图
- 但避免依赖固定面孔一致性的构图
- 优先选择侧脸、3/4 背向、贴近镜头但非纯正脸身份照等自然方式

禁止因为玩家无 Visual Identity 而把玩家从明确的双人场景中删除。

## 输出格式

必须输出严格的 JSON 格式，包含以下所有字段：

\`\`\`json
{
  "version": 1,
  "mode": "scene-snapshot" | "duo-photo",
  "subjects": ["角色名", "玩家(背影)"],
  "characterState": "当前动作和情绪状态的简短描述",
  "playerVisibility": "none" | "back" | "profile" | "partial" | "blur" | "full",
  "environment": "当前环境的简短描述",
  "moment": "捕捉的具体瞬间",

  "bodyOrientation": "身体朝向，如'正面'、'侧身45度'、'背影'",
  "interaction": "仅 duo 模式：人物互动方式，如'对视'、'并肩'",
  "expression": "表情描述（独立于参考图）",
  "gaze": "视线方向，如'看向镜头'、'看向玩家'、'看向远方'",

  "cameraPosition": "机位，如'平视'、'低角度仰拍'、'高角度俯拍'",
  "shotSize": "景别，如'特写'、'半身'、'全身'、'远景'",
  "cameraFeel": "镜头感觉，如'50mm自然视角'、'85mm人像'、'广角'",

  "composition": "构图方式，如'三分法'、'中心构图'、'对角线'",
  "foreground": "前景元素（可选），如'桌上的咖啡杯'、'窗边的绿植'",
  "background": "背景描述",
  "lighting": "光线描述，如'柔和自然光'、'侧逆光'",
  "wardrobe": "服装细节（可选，必须符合场景）",

  "continuityConstraints": ["当前角色形态约束"],
  "avoidConstraints": ["基于上一镜头的差异化约束"],

  "finalPrompt": "最终完整的英文生图 prompt（整合以上所有信息）"
}
\`\`\`

finalPrompt 必须是完整的英文描述，包含所有摄影细节，但不包含 Visual Identity 身份描述（那部分由系统自动注入）。`;
}

/** 构建 Director User Prompt（携带场景上下文）。 */
export function buildDirectorUserPrompt(input: {
  mode: SceneCameraMode;
  sceneContext: string;
  characterName: string;
  activePresetName?: string;
  previousShotPlan?: SceneCameraShotPlan;
}): string {
  const { mode, sceneContext, characterName, activePresetName, previousShotPlan } = input;

  const modeInstruction = mode === 'scene-snapshot'
    ? '当前模式：scene-snapshot（场景快照）\n任务：为当前场景设计一个忠实的可视化方案，捕捉此刻的氛围和状态。'
    : '当前模式：duo-photo（双人合照）\n任务：为角色与玩家的互动场景设计一个自然的双人构图。';

  const presetConstraint = activePresetName
    ? `\n⚠️ 角色当前使用的 Visual Identity preset：「${activePresetName}」\n生成的 finalPrompt 必须与该形态一致，不得描述其他形态的特征。`
    : '';

  const avoidHints = previousShotPlan
    ? `\n## 上一镜头信息（本次拍摄应避免机械重复）\n\n` +
      `- 机位: ${previousShotPlan.cameraPosition}\n` +
      `- 景别: ${previousShotPlan.shotSize}\n` +
      `- 身体朝向: ${previousShotPlan.bodyOrientation}\n` +
      `- 构图: ${previousShotPlan.composition}\n` +
      `- 前景: ${previousShotPlan.foreground || '无'}\n` +
      `- 表情: ${previousShotPlan.expression}\n\n` +
      `请设计不同的镜头角度、景别和构图，但仍忠实当前场景事实。`
    : '';

  return `${modeInstruction}

## 当前场景上下文

${sceneContext}

## 角色信息

角色名：${characterName}${presetConstraint}
${avoidHints}

请严格按照 JSON 格式输出 ShotPlan。`;
}

/** 解析 Director 返回的 JSON（容错处理）。 */
export function parseShotPlanFromJson(jsonText: string, mode: SceneCameraMode): SceneCameraShotPlan {
  // 去除 markdown code fence
  let cleaned = jsonText.trim();
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.slice(7);
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.slice(3);
  }
  if (cleaned.endsWith('```')) {
    cleaned = cleaned.slice(0, -3);
  }
  cleaned = cleaned.trim();

  try {
    const parsed = JSON.parse(cleaned);

    // 必填字段验证
    if (!parsed.finalPrompt || typeof parsed.finalPrompt !== 'string') {
      throw new Error('Missing or invalid finalPrompt');
    }

    // 构建完整 ShotPlan（缺失字段用安全默认值）
    const shotPlan: SceneCameraShotPlan = {
      version: SHOT_PLAN_VERSION,
      mode: parsed.mode || mode,
      subjects: Array.isArray(parsed.subjects) ? parsed.subjects : [parsed.characterName || '角色'],
      characterState: parsed.characterState || '当前状态',
      playerVisibility: parsed.playerVisibility || defaultPlayerVisibility(mode),
      environment: parsed.environment || '当前环境',
      moment: parsed.moment || '此刻',

      bodyOrientation: parsed.bodyOrientation || '自然姿态',
      interaction: parsed.interaction,
      expression: parsed.expression || '自然表情',
      gaze: parsed.gaze || '自然视线',

      cameraPosition: parsed.cameraPosition || '平视',
      shotSize: parsed.shotSize || '半身',
      cameraFeel: parsed.cameraFeel || '50mm 自然视角',

      composition: parsed.composition || '自然构图',
      foreground: parsed.foreground,
      background: parsed.background || '当前环境',
      lighting: parsed.lighting || '自然光',
      wardrobe: parsed.wardrobe,

      continuityConstraints: Array.isArray(parsed.continuityConstraints) ? parsed.continuityConstraints : [],
      avoidConstraints: Array.isArray(parsed.avoidConstraints) ? parsed.avoidConstraints : [],

      finalPrompt: parsed.finalPrompt,

      createdAt: Date.now(),
    };

    return shotPlan;
  } catch (error) {
    throw new Error(`Failed to parse ShotPlan JSON: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/** 基于 previousShotPlan 生成差异化建议（注入到 avoidConstraints）。 */
export function enrichAvoidConstraints(
  shotPlan: SceneCameraShotPlan,
  previousShotPlan?: SceneCameraShotPlan,
): SceneCameraShotPlan {
  if (!previousShotPlan) return shotPlan;

  const generatedConstraints = buildAvoidConstraints(previousShotPlan);
  const merged = [
    ...new Set([...shotPlan.avoidConstraints, ...generatedConstraints]),
  ];

  return {
    ...shotPlan,
    avoidConstraints: merged,
  };
}
