/**
 * Scene Camera Prompt Builder Tests (Phase 3B)
 *
 * 测试目标：
 * 1. ShotPlan JSON 解析与容错
 * 2. Director prompt 构建
 * 3. avoidConstraints 差异化逻辑
 * 4. 默认值填充
 */

import { describe, it, expect } from 'vitest';
import type { SceneCameraShotPlan, SceneCameraMode } from '../types';
import {
  buildDirectorSystemPrompt,
  buildDirectorUserPrompt,
  parseShotPlanFromJson,
  enrichAvoidConstraints,
} from './sceneCameraPrompt';

describe('buildDirectorSystemPrompt', () => {
  it('应返回包含核心规则的 system prompt', () => {
    const prompt = buildDirectorSystemPrompt();

    // 核心规则检查
    expect(prompt).toContain('Scene Camera Director');
    expect(prompt).toContain('Visual Identity');
    expect(prompt).toContain('推进剧情'); // "你不得：- 推进剧情（不添加场景中未发生的事件）"
    expect(prompt).toContain('finalPrompt');
    expect(prompt).toContain('JSON');
  });

  it('应包含 playerVisibility 处理规则', () => {
    const prompt = buildDirectorSystemPrompt();
    expect(prompt).toContain('玩家无 Visual Identity');
    expect(prompt).toContain('scene-snapshot');
    expect(prompt).toContain('duo-photo');
  });
});

describe('buildDirectorUserPrompt', () => {
  it('应为 scene-snapshot 模式构建正确的 user prompt', () => {
    const prompt = buildDirectorUserPrompt({
      mode: 'scene-snapshot',
      sceneContext: '角色正在咖啡厅看书',
      characterName: '测试角色',
      activePresetName: '日常形态',
    });

    expect(prompt).toContain('scene-snapshot');
    expect(prompt).toContain('角色正在咖啡厅看书');
    expect(prompt).toContain('测试角色');
    expect(prompt).toContain('日常形态');
  });

  it('应为 duo-photo 模式构建正确的 user prompt', () => {
    const prompt = buildDirectorUserPrompt({
      mode: 'duo-photo',
      sceneContext: '角色和玩家在公园散步',
      characterName: '测试角色',
    });

    expect(prompt).toContain('duo-photo');
    expect(prompt).toContain('双人');
    expect(prompt).toContain('角色和玩家在公园散步');
  });

  it('应包含 previousShotPlan 差异化提示', () => {
    const previousShot: SceneCameraShotPlan = {
      version: 1,
      mode: 'scene-snapshot',
      subjects: ['角色'],
      characterState: '看书',
      playerVisibility: 'none',
      environment: '咖啡厅',
      moment: '阅读时刻',
      bodyOrientation: '侧身',
      expression: '专注',
      gaze: '看向书本',
      cameraPosition: '平视',
      shotSize: '半身',
      cameraFeel: '50mm',
      composition: '三分法',
      background: '咖啡厅内景',
      lighting: '自然光',
      continuityConstraints: [],
      avoidConstraints: [],
      finalPrompt: 'test prompt',
      createdAt: Date.now(),
    };

    const prompt = buildDirectorUserPrompt({
      mode: 'scene-snapshot',
      sceneContext: '角色继续看书',
      characterName: '测试角色',
      previousShotPlan: previousShot,
    });

    expect(prompt).toContain('上一镜头');
    expect(prompt).toContain('侧身');
    expect(prompt).toContain('半身');
    expect(prompt).toContain('三分法');
  });
});

describe('parseShotPlanFromJson', () => {
  it('应解析完整的 JSON ShotPlan', () => {
    const json = JSON.stringify({
      mode: 'scene-snapshot',
      subjects: ['角色'],
      characterState: '看书',
      playerVisibility: 'none',
      environment: '咖啡厅',
      moment: '安静的下午',
      bodyOrientation: '正面',
      expression: '平静',
      gaze: '看向书本',
      cameraPosition: '平视',
      shotSize: '半身',
      cameraFeel: '50mm',
      composition: '三分法',
      background: '咖啡厅',
      lighting: '柔和自然光',
      continuityConstraints: ['保持日常形态'],
      avoidConstraints: [],
      finalPrompt: 'A character reading in a cafe',
    });

    const result = parseShotPlanFromJson(json, 'scene-snapshot');

    expect(result.version).toBe(1);
    expect(result.mode).toBe('scene-snapshot');
    expect(result.subjects).toEqual(['角色']);
    expect(result.finalPrompt).toBe('A character reading in a cafe');
    expect(result.characterState).toBe('看书');
    expect(result.playerVisibility).toBe('none');
  });

  it('应去除 markdown code fence', () => {
    const json = '```json\n{"finalPrompt": "test"}\n```';
    const result = parseShotPlanFromJson(json, 'scene-snapshot');
    expect(result.finalPrompt).toBe('test');
  });

  it('应去除无 json 标记的 code fence', () => {
    const json = '```\n{"finalPrompt": "test"}\n```';
    const result = parseShotPlanFromJson(json, 'scene-snapshot');
    expect(result.finalPrompt).toBe('test');
  });

  it('应填充缺失的字段为安全默认值', () => {
    const json = JSON.stringify({ finalPrompt: 'minimal test' });
    const result = parseShotPlanFromJson(json, 'duo-photo');

    expect(result.finalPrompt).toBe('minimal test');
    expect(result.mode).toBe('duo-photo');
    expect(result.playerVisibility).toBe('partial'); // duo-photo 默认值
    expect(result.characterState).toBe('当前状态');
    expect(result.bodyOrientation).toBe('自然姿态');
    expect(result.expression).toBe('自然表情');
  });

  it('应在缺少 finalPrompt 时抛出错误', () => {
    const json = JSON.stringify({ mode: 'scene-snapshot' });
    expect(() => parseShotPlanFromJson(json, 'scene-snapshot')).toThrow('Missing or invalid finalPrompt');
  });

  it('应在 JSON 语法错误时抛出错误', () => {
    const json = '{invalid json}';
    expect(() => parseShotPlanFromJson(json, 'scene-snapshot')).toThrow('Failed to parse ShotPlan JSON');
  });
});

describe('enrichAvoidConstraints', () => {
  it('当没有 previousShotPlan 时应返回原 shotPlan', () => {
    const shotPlan: SceneCameraShotPlan = {
      version: 1,
      mode: 'scene-snapshot',
      subjects: ['角色'],
      characterState: '站立',
      playerVisibility: 'none',
      environment: '室内',
      moment: '此刻',
      bodyOrientation: '正面',
      expression: '微笑',
      gaze: '看向镜头',
      cameraPosition: '平视',
      shotSize: '全身',
      cameraFeel: '50mm',
      composition: '中心构图',
      background: '简洁背景',
      lighting: '自然光',
      continuityConstraints: [],
      avoidConstraints: [],
      finalPrompt: 'test',
      createdAt: Date.now(),
    };

    const result = enrichAvoidConstraints(shotPlan);
    expect(result.avoidConstraints).toEqual([]);
  });

  it('应基于 previousShotPlan 生成差异化约束', () => {
    const previousShot: SceneCameraShotPlan = {
      version: 1,
      mode: 'scene-snapshot',
      subjects: ['角色'],
      characterState: '坐着',
      playerVisibility: 'none',
      environment: '咖啡厅',
      moment: '下午',
      bodyOrientation: '侧身45度',
      expression: '专注',
      gaze: '看向书本',
      cameraPosition: '低角度仰拍',
      shotSize: '特写',
      cameraFeel: '85mm',
      composition: '三分法',
      foreground: '咖啡杯',
      background: '咖啡厅',
      lighting: '侧光',
      continuityConstraints: [],
      avoidConstraints: [],
      finalPrompt: 'previous',
      createdAt: Date.now(),
    };

    const currentShot: SceneCameraShotPlan = {
      version: 1,
      mode: 'scene-snapshot',
      subjects: ['角色'],
      characterState: '站立',
      playerVisibility: 'none',
      environment: '咖啡厅',
      moment: '傍晚',
      bodyOrientation: '正面',
      expression: '微笑',
      gaze: '看向镜头',
      cameraPosition: '平视',
      shotSize: '全身',
      cameraFeel: '50mm',
      composition: '中心构图',
      background: '咖啡厅',
      lighting: '自然光',
      continuityConstraints: [],
      avoidConstraints: ['不要用室外场景'],
      finalPrompt: 'current',
      createdAt: Date.now(),
    };

    const result = enrichAvoidConstraints(currentShot, previousShot);

    // 应包含原有约束
    expect(result.avoidConstraints).toContain('不要用室外场景');
    // 应包含基于 previousShot 生成的约束
    expect(result.avoidConstraints.some(c => c.includes('低角度仰拍'))).toBe(true);
    expect(result.avoidConstraints.some(c => c.includes('特写'))).toBe(true);
    expect(result.avoidConstraints.some(c => c.includes('侧身45度'))).toBe(true);
    expect(result.avoidConstraints.some(c => c.includes('三分法'))).toBe(true);
    expect(result.avoidConstraints.some(c => c.includes('咖啡杯'))).toBe(true);
    expect(result.avoidConstraints.some(c => c.includes('专注'))).toBe(true);
  });

  it('应去重约束（避免重复项）', () => {
    const previousShot: SceneCameraShotPlan = {
      version: 1,
      mode: 'scene-snapshot',
      subjects: ['角色'],
      characterState: '坐着',
      playerVisibility: 'none',
      environment: '室内',
      moment: '此刻',
      bodyOrientation: '侧身',
      expression: '平静',
      gaze: '自然',
      cameraPosition: '平视',
      shotSize: '半身',
      cameraFeel: '50mm',
      composition: '三分法',
      background: '简洁',
      lighting: '自然光',
      continuityConstraints: [],
      avoidConstraints: [],
      finalPrompt: 'previous',
      createdAt: Date.now(),
    };

    const currentShot: SceneCameraShotPlan = {
      version: 1,
      mode: 'scene-snapshot',
      subjects: ['角色'],
      characterState: '站立',
      playerVisibility: 'none',
      environment: '室内',
      moment: '此刻',
      bodyOrientation: '正面',
      expression: '微笑',
      gaze: '看向镜头',
      cameraPosition: '俯拍',
      shotSize: '全身',
      cameraFeel: '50mm',
      composition: '中心构图',
      background: '简洁',
      lighting: '自然光',
      continuityConstraints: [],
      avoidConstraints: ['不要复用上一镜头的机位: 平视'], // 手动添加的约束与自动生成重复
      finalPrompt: 'current',
      createdAt: Date.now(),
    };

    const result = enrichAvoidConstraints(currentShot, previousShot);
    const countMatches = result.avoidConstraints.filter(c => c.includes('平视')).length;
    expect(countMatches).toBe(1); // 应去重
  });
});
