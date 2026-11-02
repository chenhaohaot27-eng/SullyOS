/**
 * Scene Image Prompt Builder（两阶段导演 · 阶段二：视觉导演 + 基础直生成）
 *
 * 职责：
 * - 依据「原文 + 场景解析结果 + 用户选项（构图方式 / 环境保留 / 人物焦点）」构建最终生图 prompt 的导演指令
 * - 提供不走导演模型的「基础 prompt 生成模式」（导演关闭或导演失败时的 fallback）
 *
 * 核心原则（原文叙事优先，避免模板化双人图）：
 * - 画面主体、构图中心、景别、镜头、环境保留程度由文本叙事决定
 * - 允许 NPC / 环境 / 群像 / 事件成为视觉中心，允许玩家与当前角色退居次要构图位置
 * - 不加入泛化的自我审查与过度保守措辞；忠实保留原文的人物关系、动作、情绪、
 *   空间、物件与戏剧张力（包括成人向内容），目标是「忠于原文的最好画面」
 */

import type {
  SceneCameraMode,
  SceneCameraShotPlan,
  SceneAnalysis,
  SceneCompositionMode,
  SceneEnvironmentDetail,
  SceneImageOptions,
  SceneSubjectFocus,
} from '../types';

// ─────────────────────────────────────────────────────────────
// 选项 → 导演指令（同一份语义同时被阶段二 prompt 与基础直生成复用）
// ─────────────────────────────────────────────────────────────

export function describeCompositionMode(mode: SceneCompositionMode): string {
  switch (mode) {
    case 'character_focus':
      return '构图方式：角色主画面（character_focus）——优先突出玩家与当前主角色，以情绪互动和人物表现为画面重心；环境可适度简化，次要 NPC 可弱化。这只是优先级偏向人物，不是忽略文本内容；原文中的动作、情绪与关系仍然必须忠实呈现。';
    case 'text_faithful':
      return '构图方式：原文还原（text_faithful）——画面完全服从文本叙事重心，谁重要画谁。如果文本重点是 NPC，就让 NPC 成为视觉中心；如果重点是空间、仪式、群像或事件，就允许人物退居次要位置甚至成为构图点缀。不强行突出玩家与当前角色，不把任何文本都套成双人图。';
    case 'narrative_balanced':
    default:
      return '构图方式：剧情平衡（narrative_balanced）——平衡人物、环境、动作、关系与氛围，不强制双人居中；像一张忠于原文的剧情 CG，画面重心由文本决定。';
  }
}

export function describeEnvironmentDetail(level: SceneEnvironmentDetail): string {
  switch (level) {
    case 'minimal':
      return '环境保留：简化环境（minimal）——保留最必要的背景线索即可，可降低环境描述权重，背景允许概括化处理；但原文点明的关键空间线索不要丢。';
    case 'full_scene':
      return '环境保留：尽量完整还原（full_scene）——尽量完整还原空间结构、环境层次、灯光氛围、关键物件与多人站位；鼓励较完整的场景构建，不要把环境抹成模糊色块。';
    case 'key_elements':
    default:
      return '环境保留：保留关键元素（key_elements）——保留对剧情有意义的空间与道具；无关细节可概括，但叙事上有分量的环境信息必须留在画面里。';
  }
}

export function describeSubjectFocus(focus: SceneSubjectFocus): string {
  switch (focus) {
    case 'duo':
      return '人物焦点：双人为主（duo）——默认突出玩家与当前角色，两人是画面主体；其他人物作次要处理。';
    case 'current_character':
      return '人物焦点：当前角色为主（current_character）——当前角色优先成为画面主体，玩家可作辅助或局部入镜。';
    case 'npc_allowed':
      return '人物焦点：允许 NPC 为主（npc_allowed）——明确允许 NPC、群像或其他叙事主体成为视觉中心，不强保玩家和当前角色的主位；谁在文本中最重要，谁就在画面中心。';
    case 'auto':
    default:
      return '人物焦点：自动判断（auto）——根据文本判断画面主体：文本重心在哪个人物 / 群像 / 环境上，画面主体就跟随它，不预设双人构图。';
  }
}

/** 汇总用户三项选项为一段导演指令。 */
export function describeSceneImageOptions(options: SceneImageOptions): string {
  return [
    describeCompositionMode(options.compositionMode),
    describeEnvironmentDetail(options.environmentDetail),
    describeSubjectFocus(options.subjectFocus),
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────
// 阶段二：视觉导演 Prompt
// ─────────────────────────────────────────────────────────────

/**
 * 阶段二 system prompt：电影导演总原则 + 用户选项的导演语义。
 * 注意：刻意不写任何「安全 / 稳妥 / 简化 / 回避」类防御性措辞——
 * 导演的职责是把原文导演成最合适且忠于原文的画面，不是净化原文。
 */
export function buildSceneDirectingSystemPrompt(options: SceneImageOptions): string {
  return `# Scene Image Director（视觉导演）

你是一名擅长将叙事文本转译为画面的电影导演。

## 导演总原则

你的任务不是把任何文本都处理成固定的双人角色图，而是根据文本本身决定画面的主体、构图中心、景别、镜头、环境保留程度与人物主次。

- 优先忠实保留原文中的人物关系、动作、情绪、空间、物件、事件与氛围。
- 允许 NPC 成为画面主体，允许环境或事件成为视觉中心，允许玩家与当前角色处于次要构图位置。
- 不要为了降低生成难度而主动过度简化复杂场景，也不要出于保守倾向擅自弱化原文中的普通叙事细节。
- 避免过度净化、模板化和防御性改写；不要在 finalPrompt 里加入「安全、温和、适宜」之类的净化词。
- 你的职责是把这段文字导演成最合适且忠于原文的画面，而不是套用固定的人物插画模板。

## 你只改变摄影语言，不改写事实

你可以在忠于原文的前提下设计：镜头位置、角度、景别、构图、光线、合理的服装细节、表情与视线、画面中自然可见的环境细节。

你不得：推进剧情（添加原文未发生的事件）、替玩家发言或增加玩家的关键行为、改变人物身份或当前形态、改写剧情关键事实、凭空添加原文不存在的重要物品或人物。

## Visual Identity References 使用规则

参考图定义的是「这个角色是谁」（身份特征），不是「这张照片怎么拍」。你必须主动重新设计每张图的表情、视线、身体朝向、机位、景别、构图与前景；不得默认继承参考图的 pose / 表情 / 角度 / 框景（除非场景明确要求），只保持身份特征（五官、发色、体型）与当前 preset 的形态特征。

## 玩家无 Visual Identity 时的自然处理

画面需要玩家但玩家没有固定形象时：可用背影、侧影、局部入镜、肩后视角、景深虚化等自然摄影方式；不要因玩家无形象而把玩家从原文明确的双人场景中删除，也不要生成「随机正脸特写」。

## 用户指定的导演取向（必须遵守）

${describeSceneImageOptions(options)}

## 输出格式

必须输出严格的 JSON（不要 markdown code fence，不要额外解释）：

{
  "version": 1,
  "mode": "scene-snapshot" | "duo-photo",
  "subjects": ["画面主体（按主次排序）"],
  "characterState": "当前动作和情绪状态的简短描述",
  "playerVisibility": "none" | "back" | "profile" | "partial" | "blur" | "full",
  "environment": "当前环境的简短描述",
  "moment": "捕捉的具体瞬间",
  "bodyOrientation": "身体朝向，如'正面'、'侧身45度'、'背影'",
  "interaction": "人物互动方式（如有），如'对视'、'并肩'、'对峙'",
  "expression": "表情描述（独立于参考图）",
  "gaze": "视线方向",
  "cameraPosition": "机位，如'平视'、'低角度仰拍'、'高角度俯拍'",
  "shotSize": "景别，如'特写'、'半身'、'全身'、'远景'",
  "cameraFeel": "镜头感觉，如'50mm自然视角'、'85mm人像'、'广角'",
  "composition": "构图方式，如'三分法'、'中心构图'、'对角线'、'群像站位'",
  "foreground": "前景元素（可选）",
  "background": "背景描述",
  "lighting": "光线描述",
  "wardrobe": "服装细节（可选，必须符合场景）",
  "continuityConstraints": ["当前角色形态约束"],
  "avoidConstraints": ["差异化约束"],
  "finalPrompt": "最终完整的英文生图 prompt"
}

finalPrompt 要求：
- 完整的英文描述，明确：画面主体是谁、人物主次关系、景别与镜头 / 构图倾向、必须保留的重要环境与物件、情绪氛围；
- 忠实转译原文的人物关系、动作、情绪与张力，不净化、不软化、不概括掉关键细节；
- 不包含 Visual Identity 身份描述（那部分由系统自动注入）。`;
}

/** 阶段二 user prompt：原文 + 解析结果 + 模式 + 模型类型 + 差异化提示。 */
export function buildSceneDirectingUserPrompt(input: {
  mode: SceneCameraMode;
  /** 叙事文本（选中的原文优先，其次场景上下文）。 */
  narrativeText: string;
  /** 是否为用户主动选中的原文（原文叙事优先级最高）。 */
  isSelectedText: boolean;
  sceneAnalysis?: SceneAnalysis;
  characterName: string;
  activePresetName?: string;
  options: SceneImageOptions;
  /** 当前图像模型类型（gpt-images / openai-images / gemini-native 等）。 */
  rendererProvider?: string;
  previousShotPlan?: SceneCameraShotPlan;
}): string {
  const { mode, narrativeText, isSelectedText, sceneAnalysis, characterName, activePresetName, options, rendererProvider, previousShotPlan } = input;

  const modeInstruction = mode === 'duo-photo'
    ? '当前模式：duo-photo（双人合照）——用户明确要一张双人构图的照片；在此前提下依据原文设计自然的两人互动画面。'
    : '当前模式：scene-snapshot（场景快照）——忠实还原此刻的文字场景，画面重心由文本决定，不预设双人构图。';

  const sourceNote = isSelectedText
    ? '⚠️ 下面是用户主动选中的原文片段：它是本次画面的最高依据，画面主体、动作、情绪、环境都以此为准（可参考补充上下文，但不得覆盖原文）。'
    : '下面是当前场景上下文：画面应忠实于其中「此刻」发生的内容。';

  const analysisBlock = sceneAnalysis
    ? `## 阶段一 · 场景解析结果（可信参考，与原文冲突时以原文为准）\n\n${JSON.stringify(sceneAnalysis, null, 2)}`
    : '## 阶段一 · 场景解析结果\n\n（本次解析不可用：请直接依据原文自行完成画面判断）';

  const presetConstraint = activePresetName
    ? `\n⚠️ 角色当前使用的 Visual Identity preset：「${activePresetName}」\n生成的 finalPrompt 必须与该形态一致，不得描述其他形态的特征。`
    : '';

  const rendererHint = rendererProvider
    ? `\n当前图像模型类型：${rendererProvider}（请让 finalPrompt 的表达方式与该类模型习惯的描述风格兼容）。`
    : '';

  const avoidHints = previousShotPlan
    ? `\n## 上一镜头信息（本次拍摄应避免机械重复）\n\n- 机位: ${previousShotPlan.cameraPosition}\n- 景别: ${previousShotPlan.shotSize}\n- 构图: ${previousShotPlan.composition}\n- 前景: ${previousShotPlan.foreground || '无'}\n- 表情: ${previousShotPlan.expression}\n请设计不同的镜头角度、景别和构图，但仍忠实当前原文事实。`
    : '';

  return `${modeInstruction}

${sourceNote}

## 原文 / 场景文本

${narrativeText}

${analysisBlock}

## 角色信息

当前主角色名：${characterName}（其他人物默认视为 NPC）${presetConstraint}${rendererHint}${avoidHints}

## 用户指定的导演取向

${describeSceneImageOptions(options)}

请严格按照 JSON 格式输出 ShotPlan。`;
}

// ─────────────────────────────────────────────────────────────
// 基础直生成（导演关闭 / 导演失败的 fallback）
// ─────────────────────────────────────────────────────────────

/**
 * 基础模式 prompt：不用导演模型，直接用「原文 + 基础角色设定 + 必要技术参数」
 * 拼装最终 prompt。仍保留用户三项选项的取向，仍不做任何净化。
 */
export function buildBasicScenePrompt(input: {
  narrativeText: string;
  characterName: string;
  options: SceneImageOptions;
}): string {
  const { narrativeText, characterName, options } = input;
  const compositionLine: Record<SceneCompositionMode, string> = {
    character_focus: 'Prioritize the player and the current main character as the visual focus of the frame.',
    narrative_balanced: 'Balance characters, environment, action and mood as told by the text; the frame follows the narrative, not a fixed duo template.',
    text_faithful: 'The composition must fully follow the narrative focus of the source text: whoever or whatever matters most in the text becomes the visual center — it may be an NPC, a group of characters, the environment or the event itself; do not force the player or the main character into the center.',
  };
  const environmentLine: Record<SceneEnvironmentDetail, string> = {
    minimal: 'Keep only the essential background cues mentioned in the text; the background may be simplified.',
    key_elements: 'Keep the spatial details and props that matter to the story.',
    full_scene: 'Render the setting as completely as possible: spatial structure, layered environment, lighting atmosphere, key props and the positions of multiple characters.',
  };
  const subjectLine: Record<SceneSubjectFocus, string> = {
    duo: 'The player and the current main character are the main subjects of the image.',
    current_character: 'The current main character is the main subject; the player may appear partially or secondarily.',
    auto: 'Decide the main subject from the text itself: whoever carries the narrative weight becomes the visual center.',
    npc_allowed: 'NPCs, group compositions or other narrative subjects are explicitly allowed to be the visual center; do not force the player and the main character into the primary position.',
  };

  return [
    'A cinematic scene faithfully translated from the following narrative text.',
    'Translate the narrative below into the image exactly as written — keep its character relationships, actions, emotions, objects, setting and dramatic tension (including mature or intense content) without sanitizing, softening or omitting them.',
    `Current main character referenced by the system: ${characterName} (identity details are injected separately).`,
    compositionLine[options.compositionMode],
    environmentLine[options.environmentDetail],
    subjectLine[options.subjectFocus],
    '--- Narrative source text ---',
    narrativeText,
    '--- End of source text ---',
  ].join('\n');
}

/**
 * 基础模式 ShotPlan：不走导演模型时本地构造（字段语义交给 finalPrompt 承载）。
 * directorFallbackReason 记录走基础模式的原因，供 UI 给出「不烦人」的提示。
 */
export function buildBasicShotPlan(input: {
  mode: SceneCameraMode;
  narrativeText: string;
  characterName: string;
  options: SceneImageOptions;
  fallbackReason?: string;
  sceneAnalysis?: SceneAnalysis;
}): SceneCameraShotPlan {
  const { mode, narrativeText, characterName, options, fallbackReason, sceneAnalysis } = input;
  return {
    version: 1,
    mode,
    subjects: [characterName],
    characterState: '以原文描述为准',
    playerVisibility: mode === 'duo-photo' ? 'partial' : 'none',
    environment: '以原文描述为准',
    moment: '原文此刻',
    bodyOrientation: '以原文描述为准',
    expression: '以原文描述为准',
    gaze: '以原文描述为准',
    cameraPosition: '由原文叙事重心决定',
    shotSize: '由原文叙事重心决定',
    cameraFeel: '自然叙事视角',
    composition: options.compositionMode,
    background: '以原文描述为准',
    lighting: '以原文氛围为准',
    continuityConstraints: [],
    avoidConstraints: [],
    finalPrompt: buildBasicScenePrompt({ narrativeText, characterName, options }),
    sceneAnalysis,
    ...(fallbackReason ? { directorFallbackReason: fallbackReason } : {}),
    createdAt: Date.now(),
  };
}
