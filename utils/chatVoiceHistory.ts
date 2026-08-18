import type { Message } from '../types';
import { cleanVoiceMarkupForDisplay } from './minimaxTts';
import { normalizeVoiceTags } from './sanitize';

const LEGACY_VOICE_MARKER_RE = /[【[]\s*语音消息\s*(?:[·:：]\s*)?(?:\d+(?:\.\d+)?\s*(?:s|秒))?\s*[】\]]/gi;
const LEGACY_TRANSCRIPT_LABEL_RE = /^\s*(?:语音转写|转写|文字稿)\s*[：:]\s*/i;

const cleanLegacyTranscript = (value: unknown): string => {
    if (typeof value !== 'string') return '';
    return value
        .replace(LEGACY_VOICE_MARKER_RE, '')
        .replace(LEGACY_TRANSCRIPT_LABEL_RE, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
};

/** Convert a migrated voice message into semantic prompt history without changing stored data. */
export const formatLegacyVoiceHistoryForPrompt = (message: Message): string | null => {
    const metadata = message.metadata;
    if (metadata?.migrationSource !== 'legacy_xiaoyu_messages' || metadata?.legacy?.isVoice !== true) {
        return null;
    }
    const transcript = cleanLegacyTranscript(metadata.legacy.voiceText)
        || cleanLegacyTranscript(message.content);
    return `[历史语音转写]\n${transcript || '（无可用转写）'}`;
};

const canonicalVoiceText = (value: string): string => cleanVoiceMarkupForDisplay(value)
    .replace(/\s+/g, '')
    .trim();

/** Extract the spoken text from every native voice block in one assistant turn. */
export const collectVoiceTexts = (rawResponse: string): Set<string> => {
    const normalized = normalizeVoiceTags(rawResponse || '');
    const texts = new Set<string>();
    const pattern = /<[语語]音[^>]*>([\s\S]*?)<\/\s*[语語]音\s*>/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(normalized)) !== null) {
        const canonical = canonicalVoiceText(match[1]);
        if (canonical) texts.add(canonical);
    }
    return texts;
};

/** True only for a standalone text chunk that exactly repeats native voice content. */
export const isDuplicateVoiceTranscriptChunk = (chunk: string, voiceTexts: Set<string>): boolean => {
    if (!chunk || /<[语語]音[^>]*>/.test(chunk)) return false;
    const canonical = canonicalVoiceText(chunk);
    return !!canonical && voiceTexts.has(canonical);
};
