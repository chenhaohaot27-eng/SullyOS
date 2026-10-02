import { describe, it, expect } from 'vitest';
import { shouldAutoGenerateVoice, shouldAutoPlayGeneratedVoice } from './voicePlayback';

describe('shouldAutoGenerateVoice', () => {
  it('语音功能、合法标签和 TTS 均可用时自动合成，与 auto play 无关', () => {
    expect(shouldAutoGenerateVoice({
      voiceEnabled: true,
      hasVoiceTag: true,
      ttsReady: true,
    })).toBe(true);
  });

  it('普通文字、未配置 TTS 或已处理状态不发起自动合成', () => {
    const ready = { voiceEnabled: true, hasVoiceTag: true, ttsReady: true };
    expect(shouldAutoGenerateVoice({ ...ready, hasVoiceTag: false })).toBe(false);
    expect(shouldAutoGenerateVoice({ ...ready, ttsReady: false })).toBe(false);
    expect(shouldAutoGenerateVoice({ ...ready, hasVoiceData: true })).toBe(false);
    expect(shouldAutoGenerateVoice({ ...ready, loading: true })).toBe(false);
    expect(shouldAutoGenerateVoice({ ...ready, failed: true })).toBe(false);
  });
});

// 语音条合成完的播放时机。以前是无条件播（收到 AI 语音就直接响），
// 用户「有时候不想听」没有出口 —— 这里把两条规则钉住：
// 自动来的跟开关走、用户自己点的一定响。
describe('shouldAutoPlayGeneratedVoice', () => {
  it('AI 自动发来的语音：没开开关 → 不播', () => {
    expect(shouldAutoPlayGeneratedVoice({ autoTriggered: true })).toBe(false);
    expect(shouldAutoPlayGeneratedVoice({ autoTriggered: true, autoPlayEnabled: false })).toBe(false);
    expect(shouldAutoPlayGeneratedVoice({ autoTriggered: true, autoPlayEnabled: undefined })).toBe(false);
  });

  it('AI 自动发来的语音：开了「收到就自动播放」→ 播', () => {
    expect(shouldAutoPlayGeneratedVoice({ autoTriggered: true, autoPlayEnabled: true })).toBe(true);
  });

  it('用户主动点的（转换语音 / 点空语音条）：不管开关都播', () => {
    expect(shouldAutoPlayGeneratedVoice({ autoTriggered: false })).toBe(true);
    expect(shouldAutoPlayGeneratedVoice({ autoTriggered: false, autoPlayEnabled: false })).toBe(true);
    expect(shouldAutoPlayGeneratedVoice({ autoTriggered: false, autoPlayEnabled: true })).toBe(true);
  });
});

describe('auto generate / auto play matrix', () => {
  const validVoice = { voiceEnabled: true, hasVoiceTag: true, ttsReady: true };

  it('auto play 关闭：提前合成，但合成完成后不自动响', () => {
    expect(shouldAutoGenerateVoice(validVoice)).toBe(true);
    expect(shouldAutoPlayGeneratedVoice({ autoTriggered: true, autoPlayEnabled: false })).toBe(false);
  });

  it('auto play 开启：提前合成，合成完成后自动响', () => {
    expect(shouldAutoGenerateVoice(validVoice)).toBe(true);
    expect(shouldAutoPlayGeneratedVoice({ autoTriggered: true, autoPlayEnabled: true })).toBe(true);
  });
});
