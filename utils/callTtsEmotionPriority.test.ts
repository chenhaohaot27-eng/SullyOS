import { readFileSync } from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';

// prepareCallAssistantReply 是 CallApp 组件内函数，无法直接单测；
// 按 callAppRuntimeReferences.test.ts 的惯例做源码级断言，锁定
// 「本地关键词推断不得再直达 MiniMax TTS emotion」的接线。
const source = readFileSync(path.resolve(__dirname, '../apps/CallApp.tsx'), 'utf-8');

describe('Call TTS speechEmotion 优先级', () => {
  it('speechEmotion 只来自明确标签（<语音 emotion> / leading [emotion]），不再回落关键词推断', () => {
    expect(source).toContain('const speechEmotion = voiceTag.emotion || leadingEmotion;');
    expect(source).not.toContain('voiceTag.emotion || leadingEmotion || inferredPerformance.emotion');
  });
  it('avatar 表演 fallback 仍使用 inferredPerformance（不因 TTS 修复破坏头像动画）', () => {
    expect(source).toContain('emotion: normalizeAvatarEmotion(speechEmotion || inferredPerformance.emotion)');
    expect(source).toContain('resolveAvatarPerformance(reply.performance || fallbackPerformance, speechEmotion || inferredPerformance.emotion)');
  });
  it('明确动态 emotion 的校验链仍在（VALID_EMOTIONS 门禁）', () => {
    expect(source).toContain('VALID_EMOTIONS.has(rawEmotion)');
  });
});
