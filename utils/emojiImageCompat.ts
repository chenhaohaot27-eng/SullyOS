import type { Emoji } from '../types';

type LegacyEmojiRecord = Partial<Emoji> & Record<string, unknown>;

const URL_FIELDS = ['url', 'imageUrl', 'image', 'src', 'emojiUrl', 'stickerUrl', 'dataUrl'] as const;

const readUrl = (value: unknown): string => {
    if (typeof value === 'string') return value.trim();
    if (value && typeof value === 'object') {
        const nested = value as Record<string, unknown>;
        for (const key of ['url', 'src', 'dataUrl']) {
            if (typeof nested[key] === 'string') return nested[key].trim();
        }
    }
    return '';
};

const chooseImageUrl = (record: LegacyEmojiRecord): string => {
    const candidates = URL_FIELDS.map(key => readUrl(record[key])).filter(Boolean);
    if (candidates.length === 0) return '';

    // blob: URLs expire with their creating browser session. Prefer a persistent
    // source if an older import kept one alongside the transient URL.
    return candidates.find(url => !url.startsWith('blob:')) || candidates[0];
};

export const normalizeEmojiRecord = (record: LegacyEmojiRecord): Emoji | null => {
    const name = typeof record?.name === 'string' ? record.name.trim() : '';
    if (!name) return null;

    const categoryId = typeof record.categoryId === 'string'
        ? record.categoryId
        : typeof record.groupId === 'string'
            ? record.groupId
            : typeof record.category === 'string'
                ? record.category
                : undefined;

    return {
        name,
        url: chooseImageUrl(record),
        ...(categoryId ? { categoryId } : {}),
    };
};

export const normalizeEmojiRecords = (records: unknown[]): Emoji[] => records
    .map(record => normalizeEmojiRecord((record || {}) as LegacyEmojiRecord))
    .filter((record): record is Emoji => record !== null);

export const reportEmojiImageLoadFailure = (url: string): void => {
    const reason = url.startsWith('blob:')
        ? 'expired-or-unavailable-object-url'
        : /^http:\/\//i.test(url) && typeof location !== 'undefined' && location.protocol === 'https:'
            ? 'mixed-content-http-url'
            : /^https?:\/\//i.test(url)
                ? 'remote-resource-unreachable-or-rejected'
                : url
                    ? 'unsupported-or-invalid-image-source'
                    : 'missing-image-source';
    console.warn('[emoji] image failed to load', { url, reason });
};
