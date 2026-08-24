import type { Emoji } from '../types';

export type EmojiResolutionReason =
    | 'empty-reference'
    | 'ambiguous-exact'
    | 'ambiguous-normalized'
    | 'ambiguous-substring'
    | 'no-safe-match';

export type EmojiResolution =
    | { emoji: Emoji; match: 'exact' | 'normalized' | 'substring' }
    | { emoji: null; reason: EmojiResolutionReason };

const WRAPPER_PAIRS: Readonly<Record<string, string>> = {
    '"': '"',
    "'": "'",
    '“': '”',
    '‘': '’',
    '「': '」',
    '『': '』',
    '(': ')',
    '（': '）',
    '[': ']',
    '【': '】',
    '<': '>',
    '《': '》',
};

const GENERIC_SUBSTRING_NAMES = new Set([
    'emoji', 'sticker', '表情', '表情包',
    '笑', '哭', '哈', '嗯', '好', 'ok', 'yes', 'no',
]);

const stripOuterWrappers = (value: string): string => {
    let result = value.trim();
    let changed = true;
    while (changed && result.length >= 2) {
        changed = false;
        const expectedEnd = WRAPPER_PAIRS[result[0]];
        if (expectedEnd && result.endsWith(expectedEnd)) {
            result = result.slice(1, -1).trim();
            changed = true;
        }
    }
    return result;
};

export const normalizeEmojiModelReference = (rawName: string): string => {
    let value = String(rawName || '')
        .normalize('NFKC')
        .replace(/\u00a0/g, ' ')
        .replace(/[﹕：]/g, ':')
        .trim();

    value = stripOuterWrappers(value);
    value = value
        .replace(/^(?:(?:发送|发个|来个|使用|选择)\s*)?(?:表情包|表情|emoji|sticker)\s*:?\s*/i, '')
        .replace(/\s*:?\s*(?:表情包|表情|emoji|sticker)$/i, '');
    value = stripOuterWrappers(value)
        .replace(/\s*:\s*/g, ':')
        .replace(/\s+/g, ' ')
        .trim();

    return value.toLocaleLowerCase();
};

const isSafeSubstringName = (normalizedName: string): boolean => {
    const semantic = normalizedName.replace(/[\s:.,!?;_\-，。！？；]/g, '');
    if (GENERIC_SUBSTRING_NAMES.has(semantic)) return false;
    return Array.from(semantic).length >= 3;
};

const uniqueResult = (
    matches: Emoji[],
    match: 'exact' | 'normalized',
): EmojiResolution | null => {
    if (matches.length === 1) return { emoji: matches[0], match };
    if (matches.length > 1) {
        return {
            emoji: null,
            reason: match === 'exact' ? 'ambiguous-exact' : 'ambiguous-normalized',
        };
    }
    return null;
};

export const resolveEmojiByModelReference = (
    rawName: string,
    emojis: readonly Emoji[],
): EmojiResolution => {
    const trimmed = String(rawName || '').trim();
    if (!trimmed) return { emoji: null, reason: 'empty-reference' };

    const exact = uniqueResult(emojis.filter(emoji => emoji.name === trimmed), 'exact');
    if (exact) return exact;

    const normalizedReference = normalizeEmojiModelReference(trimmed);
    if (!normalizedReference) return { emoji: null, reason: 'empty-reference' };

    const normalizedNames = emojis.map(emoji => ({
        emoji,
        normalized: normalizeEmojiModelReference(emoji.name),
    }));
    const normalized = uniqueResult(
        normalizedNames
            .filter(candidate => candidate.normalized === normalizedReference)
            .map(candidate => candidate.emoji),
        'normalized',
    );
    if (normalized) return normalized;

    const substringMatches = normalizedNames.filter(candidate =>
        candidate.normalized
        && isSafeSubstringName(candidate.normalized)
        && normalizedReference.includes(candidate.normalized),
    );
    if (substringMatches.length === 0) return { emoji: null, reason: 'no-safe-match' };

    const maxLength = Math.max(...substringMatches.map(candidate => Array.from(candidate.normalized).length));
    const longest = substringMatches.filter(candidate => Array.from(candidate.normalized).length === maxLength);
    if (longest.length !== 1) return { emoji: null, reason: 'ambiguous-substring' };

    return { emoji: longest[0].emoji, match: 'substring' };
};
