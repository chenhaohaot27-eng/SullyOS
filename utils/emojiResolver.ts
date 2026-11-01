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

/** 图片文件扩展名：模型常把库存名写成 `敲头.jpg` / `抱抱.gif`。 */
const EMOJI_FILE_EXTENSION_RE = /\.(?:png|jpe?g|gif|webp|bmp|avif)$/i;

/**
 * 名称前的修饰词 / 残留动词：`那个敲头`、`一张委屈`、`发个猫猫`。
 * 每轮只剥一组且必须还剩内容（(?=\S) 守卫），避免把「那咋了」这类真实名称剥成空。
 * 库存名本身也走同一归一化，所以对称名称（如名字就叫「发小」）不受影响——
 * 精确层先用原始名称比对，归一化层两边同样剥修饰词。
 */
const LEADING_FILLER_RE = /^(?:(?:那个|这个|那张|这张|那种|这种|一个|一张|一只|一枚|一幅|某张|某个)[\s:：、\-]*|(?:发送|发个|发张|丢个|丢张|甩个|甩张|扔个|扔张|来个|来张|发来|发给|使用|选择)[\s:：、\-]*)(?=\S)/i;

const stripLeadingFiller = (value: string): string => {
    let result = value;
    // 上限防死循环（正则本身带 (?=\S) 守卫，理论上不会空转）
    for (let i = 0; i < 8; i += 1) {
        const next = result.replace(LEADING_FILLER_RE, '');
        if (next === result) break;
        result = next;
    }
    return result;
};

export const normalizeEmojiModelReference = (rawName: string): string => {
    let value = String(rawName || '')
        .normalize('NFKC')
        .replace(/\u00a0/g, ' ')
        .replace(/[﹕：]/g, ':')
        .trim();

    // 文件扩展名先剥一层（`敲头.jpg`），包裹符号里面可能还有一层（`「敲头.jpg」`）
    value = value.replace(EMOJI_FILE_EXTENSION_RE, '');
    value = stripOuterWrappers(value);
    value = value.replace(EMOJI_FILE_EXTENSION_RE, '');
    value = value
        .replace(/^(?:(?:发送|发个|来个|使用|选择)\s*)?(?:表情包|表情|emoji|sticker)\s*:?\s*/i, '')
        .replace(/\s*:?\s*(?:表情包|表情|emoji|sticker)$/i, '');
    value = stripOuterWrappers(value)
        .replace(EMOJI_FILE_EXTENSION_RE, '');
    // 指示词 / 量词 / 残留发送动词：`那个敲头表情` → `敲头`（上面的后缀规则已剥掉「表情」）
    value = stripLeadingFiller(value)
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
