import { describe, expect, it } from 'vitest';
import type { Message } from '../types';
import { ChatPrompts } from './chatPrompts';
import {
    collectVoiceTexts,
    formatLegacyVoiceHistoryForPrompt,
    isDuplicateVoiceTranscriptChunk,
} from './chatVoiceHistory';

const legacyVoice = (voiceText?: string): Message => ({
    id: 1,
    charId: 'char-1',
    role: 'assistant',
    type: 'text',
    content: '【语音消息 · 11s】\n我现在过去接你。',
    timestamp: Date.now(),
    metadata: {
        migrationSource: 'legacy_xiaoyu_messages',
        legacy: { isVoice: true, ...(voiceText === undefined ? {} : { voiceText }) },
    },
});

describe('legacy voice prompt history', () => {
    it('优先使用 voiceText，且不向 LLM 暴露旧语音占位符', () => {
        const message = legacyVoice('我现在过去接你。');
        const formatted = formatLegacyVoiceHistoryForPrompt(message);
        expect(formatted).toBe('[历史语音转写]\n我现在过去接你。');
        expect(formatted).not.toContain('【语音消息 · 11s】');

        const { apiMessages } = ChatPrompts.buildMessageHistory(
            [message],
            10,
            { id: 'char-1', name: '角色' } as any,
            { name: '用户' } as any,
            [],
        );
        expect(String(apiMessages[0].content)).toContain('[历史语音转写]\n我现在过去接你。');
        expect(String(apiMessages[0].content)).not.toContain('【语音消息 · 11s】');
    });

    it('voiceText 缺失时从旧 content 安全提取转写', () => {
        expect(formatLegacyVoiceHistoryForPrompt(legacyVoice()))
            .toBe('[历史语音转写]\n我现在过去接你。');
    });
});

describe('native voice echo guard', () => {
    it('只识别与语音完全相同的独立文字，保留不同内容', () => {
        const response = '<语音>我现在过去接你。</语音>\n我现在过去接你。\n你先别出门。';
        const voiceTexts = collectVoiceTexts(response);
        expect(isDuplicateVoiceTranscriptChunk('我现在过去接你。', voiceTexts)).toBe(true);
        expect(isDuplicateVoiceTranscriptChunk('你先别出门。', voiceTexts)).toBe(false);
        expect(isDuplicateVoiceTranscriptChunk('<语音>我现在过去接你。</语音>', voiceTexts)).toBe(false);
    });
});
