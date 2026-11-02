/**
 * 两阶段导演（场景解析 + 视觉导演）与画面选项 Tests
 *
 * 覆盖任务验收点：
 * 1. compositionMode / environmentDetail / subjectFocus 对导演 prompt 的影响
 * 2. text_faithful + npc_allowed + full_scene 组合不会强制双人图导向
 * 3. 导演失败（网络 / JSON 无效）后的 fallback：不抛错、降级为基础直生成、给出提示
 * 4. 两阶段 happy path：先场景解析、再视觉导演；阶段一失败可跳过
 * 5. 选项持久化（localStorage 记住上次选择）与基础直生成 prompt 的选项取向
 * 6. 导演 prompt 不含防御性 / 净化性措辞
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SceneImageOptions } from '../types';

vi.mock('./chatCompletionClient', () => ({
  completeChat: vi.fn(),
}));

import { completeChat } from './chatCompletionClient';
import { runTwoStageDirector, DIRECTOR_FALLBACK_NOTICE } from './sceneImageDirector';
import {
  buildSceneDirectingSystemPrompt,
  buildSceneDirectingUserPrompt,
  buildBasicScenePrompt,
  describeCompositionMode,
  describeEnvironmentDetail,
  describeSubjectFocus,
} from './buildSceneImagePrompt';
import { parseSceneAnalysis, buildSceneAnalysisSystemPrompt } from './buildSceneAnalysisPrompt';
import {
  loadSceneImageOptions,
  saveSceneImageOptions,
  normalizeSceneImageOptions,
  SCENE_IMAGE_OPTIONS_STORAGE_KEY,
  DEFAULT_SCENE_IMAGE_OPTIONS,
} from './imageGenerationOptions';

const mockCompleteChat = vi.mocked(completeChat);

const apiConfig = {
  provider: 'openai-compatible' as const,
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'test-key',
  model: 'director-model',
};

const baseOptions: SceneImageOptions = {
  compositionMode: 'narrative_balanced',
  environmentDetail: 'key_elements',
  subjectFocus: 'auto',
  directorEnabled: true,
};

const ANALYSIS_JSON = JSON.stringify({
  characters_present: ['小满', '玩家', '老陈'],
  primary_subject: '老陈（NPC，叙事重心）',
  secondary_subjects: ['小满', '玩家'],
  key_actions: ['老陈把信拍在桌上'],
  setting: '雨夜的当铺柜台',
  important_objects: ['一封拆开的信', '台灯'],
  mood_tone: '压抑、剑拔弩张',
  relationship_dynamics: '债务对峙',
  camera_suggestion: '中景，低机位，老陈居中',
  composition_reasoning: '文本重心全在老陈的动作与神情上',
  environment_priority: 'high',
  npc_visual_priority: 'primary',
});

const SHOT_PLAN_JSON = JSON.stringify({
  mode: 'scene-snapshot',
  subjects: ['老陈'],
  finalPrompt: 'A rain-soaked pawnshop counter at night, the shopkeeper slams an opened letter on the counter, low-angle medium shot',
});

function openAiTextResponse(text: string) {
  return { choices: [{ message: { content: text } }] };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('选项 → 导演指令', () => {
  it('compositionMode 三种取值产生不同的构图指令', () => {
    const focus = describeCompositionMode('character_focus');
    const balanced = describeCompositionMode('narrative_balanced');
    const faithful = describeCompositionMode('text_faithful');

    expect(focus).toContain('优先突出玩家与当前主角色');
    expect(balanced).toContain('不强制双人居中');
    expect(faithful).toContain('画面完全服从文本叙事重心');
    expect(faithful).toContain('不强行突出玩家与当前角色');
    // 三者互不包含对方的关键语义
    expect(focus).not.toContain('画面完全服从文本叙事重心');
    expect(balanced).not.toContain('优先突出玩家与当前主角色');
  });

  it('environmentDetail 三档改变环境保留指令', () => {
    expect(describeEnvironmentDetail('minimal')).toContain('保留最必要的背景线索');
    expect(describeEnvironmentDetail('key_elements')).toContain('保留对剧情有意义的空间与道具');
    expect(describeEnvironmentDetail('full_scene')).toContain('尽量完整还原空间结构');
  });

  it('subjectFocus 四种焦点改变人物主次指令', () => {
    expect(describeSubjectFocus('duo')).toContain('默认突出玩家与当前角色');
    expect(describeSubjectFocus('current_character')).toContain('当前角色优先成为画面主体');
    expect(describeSubjectFocus('auto')).toContain('根据文本判断画面主体');
    expect(describeSubjectFocus('npc_allowed')).toContain('明确允许 NPC、群像或其他叙事主体成为视觉中心');
  });

  it('导演 system prompt 嵌入用户选项且包含导演总原则，无保守倾向措辞', () => {
    const prompt = buildSceneDirectingSystemPrompt({ ...baseOptions, compositionMode: 'text_faithful' });
    expect(prompt).toContain('你是一名擅长将叙事文本转译为画面的电影导演');
    expect(prompt).toContain('允许 NPC 成为画面主体');
    expect(prompt).toContain('原文还原（text_faithful）');
    expect(prompt).not.toContain('尽量回避');
    expect(prompt).not.toContain('优先容易生成');
    expect(prompt).not.toContain('尽量简化冲突');
  });

  it('导演 user prompt 携带原文、解析结果与选项；选中文本时标注最高依据', () => {
    const prompt = buildSceneDirectingUserPrompt({
      mode: 'scene-snapshot',
      narrativeText: '老陈把信拍在桌上，雨水顺着屋檐砸进当铺。',
      isSelectedText: true,
      characterName: '小满',
      options: baseOptions,
      rendererProvider: 'gpt-images',
    });
    expect(prompt).toContain('用户主动选中的原文片段');
    expect(prompt).toContain('老陈把信拍在桌上');
    expect(prompt).toContain('gpt-images');
    expect(prompt).toContain('剧情平衡（narrative_balanced）');
  });

  it('text_faithful + npc_allowed + full_scene 组合：不会残留双人图导向', () => {
    const combo: SceneImageOptions = {
      compositionMode: 'text_faithful',
      environmentDetail: 'full_scene',
      subjectFocus: 'npc_allowed',
      directorEnabled: true,
    };
    const system = buildSceneDirectingSystemPrompt(combo);
    const user = buildSceneDirectingUserPrompt({
      mode: 'scene-snapshot',
      narrativeText: '三人在雨夜的当铺里对峙',
      isSelectedText: true,
      characterName: '小满',
      options: combo,
    });
    const combined = system + user;
    expect(combined).toContain('画面完全服从文本叙事重心');
    expect(combined).toContain('明确允许 NPC、群像或其他叙事主体成为视觉中心');
    expect(combined).toContain('尽量完整还原空间结构');
    // duo 指令（默认突出玩家与当前角色，两人是画面主体）不应出现在该组合里
    expect(combined).not.toContain('默认突出玩家与当前角色，两人是画面主体');
    // duo-photo 模式才应有的双人指令不出现在 scene-snapshot 组合里
    expect(user).not.toContain('用户明确要一张双人构图的照片');
  });
});

describe('场景解析（阶段一）', () => {
  it('容错解析 code fence 与缺字段', () => {
    const parsed = parseSceneAnalysis('```json\n' + ANALYSIS_JSON + '\n```');
    expect(parsed.primary_subject).toContain('老陈');
    expect(parsed.environment_priority).toBe('high');

    const minimal = parseSceneAnalysis('{}');
    expect(minimal.characters_present).toEqual([]);
    expect(minimal.environment_priority).toBe('medium'); // 默认值
  });

  it('解析 system prompt 要求不净化原文', () => {
    const prompt = buildSceneAnalysisSystemPrompt();
    expect(prompt).toContain('不净化、不弱化');
    expect(prompt).toContain('成人向内容');
    expect(prompt).toContain('primary_subject');
  });

  it('JSON 完全无效时抛错（由两阶段导演降级处理）', () => {
    expect(() => parseSceneAnalysis('not-json-at-all')).toThrow();
  });
});

describe('runTwoStageDirector 两阶段编排', () => {
  it('happy path：先场景解析、再视觉导演，解析结果挂到 ShotPlan', async () => {
    mockCompleteChat
      .mockResolvedValueOnce(openAiTextResponse(ANALYSIS_JSON))
      .mockResolvedValueOnce(openAiTextResponse(SHOT_PLAN_JSON));

    const result = await runTwoStageDirector({
      apiConfig,
      mode: 'scene-snapshot',
      sceneContext: '当铺里三人正在对峙',
      characterName: '小满',
      options: baseOptions,
      rendererProvider: 'gpt-images',
    });

    expect(mockCompleteChat).toHaveBeenCalledTimes(2);
    // 第一次调用：场景解析 prompt
    const firstMessages = mockCompleteChat.mock.calls[0][1].messages as Array<{ role: string; content: string }>;
    expect(firstMessages[0].content).toContain('Scene Analysis');
    // 第二次调用：视觉导演 prompt（包含解析结果）
    const secondMessages = mockCompleteChat.mock.calls[1][1].messages as Array<{ role: string; content: string }>;
    expect(secondMessages[0].content).toContain('Scene Image Director');
    expect(secondMessages[1].content).toContain('老陈（NPC，叙事重心）');

    expect(result.shotPlan.finalPrompt).toContain('pawnshop');
    expect(result.sceneAnalysis?.primary_subject).toContain('老陈');
    expect(result.fallbackNotice).toBeUndefined();
  });

  it('选中文本存在时成为最高依据（narrativeText 前缀标注）', async () => {
    mockCompleteChat
      .mockResolvedValueOnce(openAiTextResponse(ANALYSIS_JSON))
      .mockResolvedValueOnce(openAiTextResponse(SHOT_PLAN_JSON));

    await runTwoStageDirector({
      apiConfig,
      mode: 'scene-snapshot',
      sceneContext: '其他上下文',
      selectedText: '老陈把信拍在桌上',
      characterName: '小满',
      options: baseOptions,
    });

    const analysisMessages = mockCompleteChat.mock.calls[0][1].messages as Array<{ role: string; content: string }>;
    expect(analysisMessages[1].content).toContain('老陈把信拍在桌上');
    const directingMessages = mockCompleteChat.mock.calls[1][1].messages as Array<{ role: string; content: string }>;
    expect(directingMessages[1].content).toContain('本次拍摄原文（最高依据）');
  });

  it('阶段一失败 → 跳过解析直接导演，不阻断流程', async () => {
    mockCompleteChat
      .mockRejectedValueOnce(new Error('analysis network error'))
      .mockResolvedValueOnce(openAiTextResponse(SHOT_PLAN_JSON));

    const result = await runTwoStageDirector({
      apiConfig, mode: 'scene-snapshot', sceneContext: '场景', characterName: '小满', options: baseOptions,
    });

    expect(result.shotPlan.finalPrompt).toContain('pawnshop');
    expect(result.sceneAnalysis).toBeUndefined();
    expect(result.fallbackNotice).toContain('场景解析未成功');
    expect(result.shotPlan.directorFallbackReason).toContain('场景解析未成功');
  });

  it('导演模型彻底失败 → 降级基础直生成，不抛错，给出明确提示', async () => {
    mockCompleteChat.mockRejectedValue(new Error('all director calls failed'));

    const result = await runTwoStageDirector({
      apiConfig,
      mode: 'scene-snapshot',
      sceneContext: '老陈在雨夜当铺把信拍在桌上',
      selectedText: '老陈在雨夜当铺把信拍在桌上',
      characterName: '小满',
      options: { ...baseOptions, compositionMode: 'text_faithful', subjectFocus: 'npc_allowed' },
    });

    expect(result.fallbackNotice).toBe(DIRECTOR_FALLBACK_NOTICE);
    expect(result.fallbackNotice).toContain('导演解析失败');
    // 基础 prompt 保留原文与选项取向
    expect(result.shotPlan.finalPrompt).toContain('老陈在雨夜当铺把信拍在桌上');
    expect(result.shotPlan.finalPrompt).toContain('NPCs, group compositions or other narrative subjects');
    expect(result.shotPlan.directorFallbackReason).toBe(DIRECTOR_FALLBACK_NOTICE);
  });

  it('阶段二返回无效 JSON → 同样降级基础直生成', async () => {
    mockCompleteChat
      .mockResolvedValueOnce(openAiTextResponse(ANALYSIS_JSON))
      .mockResolvedValueOnce(openAiTextResponse('这是无法解析的导演输出'));

    const result = await runTwoStageDirector({
      apiConfig, mode: 'scene-snapshot', sceneContext: '场景', characterName: '小满', options: baseOptions,
    });

    expect(result.fallbackNotice).toBe(DIRECTOR_FALLBACK_NOTICE);
    expect(result.shotPlan.finalPrompt).toContain('Narrative source text');
  });

  it('用户中止（AbortSignal）不是失败：原样上抛', async () => {
    const controller = new AbortController();
    controller.abort();
    mockCompleteChat.mockRejectedValue(Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' }));

    await expect(runTwoStageDirector({
      apiConfig, mode: 'scene-snapshot', sceneContext: '场景', characterName: '小满', options: baseOptions, signal: controller.signal,
    })).rejects.toThrow();
  });
});

describe('基础直生成（导演关闭 / 失败 fallback 共用）', () => {
  it('prompt 保留原文、不做净化、携带选项取向', () => {
    const prompt = buildBasicScenePrompt({
      narrativeText: '她攥紧了他的手腕，指节发白。',
      characterName: '小满',
      options: { ...baseOptions, compositionMode: 'text_faithful', environmentDetail: 'full_scene', subjectFocus: 'npc_allowed' },
    });
    expect(prompt).toContain('她攥紧了他的手腕，指节发白。');
    expect(prompt).toContain('without sanitizing, softening or omitting');
    expect(prompt).toContain('do not force the player or the main character into the center');
    expect(prompt).toContain('Render the setting as completely as possible');
  });
});

describe('选项持久化（记住上次选择）', () => {
  it('normalize：非法值回落默认值，合法值保留', () => {
    expect(normalizeSceneImageOptions({ compositionMode: 'evil', environmentDetail: null, subjectFocus: 42, directorEnabled: 'yes' }))
      .toEqual(DEFAULT_SCENE_IMAGE_OPTIONS);
    expect(normalizeSceneImageOptions({ compositionMode: 'text_faithful', subjectFocus: 'npc_allowed' }))
      .toEqual({ ...DEFAULT_SCENE_IMAGE_OPTIONS, compositionMode: 'text_faithful', subjectFocus: 'npc_allowed' });
  });

  it('save → load 往返一致；坏 JSON 回落默认值', () => {
    const storage = new Map<string, string>();
    const storageShim = {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => { storage.set(k, v); },
    };
    const custom: SceneImageOptions = {
      compositionMode: 'text_faithful',
      environmentDetail: 'full_scene',
      subjectFocus: 'npc_allowed',
      directorEnabled: false,
    };
    saveSceneImageOptions(custom, storageShim as unknown as Storage);
    expect(storage.has(SCENE_IMAGE_OPTIONS_STORAGE_KEY)).toBe(true);
    expect(loadSceneImageOptions(storageShim as unknown as Storage)).toEqual(custom);

    storage.set(SCENE_IMAGE_OPTIONS_STORAGE_KEY, '{broken json');
    expect(loadSceneImageOptions(storageShim as unknown as Storage)).toEqual(DEFAULT_SCENE_IMAGE_OPTIONS);
  });
});
