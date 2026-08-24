import type { Emoji, EmojiCategory } from '../types';

export type EmojiRuntimeLoadResult = 'success' | 'fail';

export interface EmojiRuntimeDiagnosticEntry {
    category: string;
    name: string;
    url: string;
    host: string;
    scheme: string;
    load: EmojiRuntimeLoadResult;
}

export interface EmojiRuntimeDiagnosticReport {
    emojis: EmojiRuntimeDiagnosticEntry[];
    summary: {
        categories: Array<{ category: string; success: number; fail: number }>;
        hosts: Array<{ host: string; success: number; fail: number }>;
    };
}

type LoadImage = (url: string) => Promise<EmojiRuntimeLoadResult>;

const sourceParts = (rawUrl: string): { host: string; scheme: string } => {
    const url = rawUrl.trim();
    if (!url) return { host: '(empty)', scheme: 'empty' };
    if (/^data:/i.test(url)) return { host: '(inline-data)', scheme: 'data' };
    if (/^blob:/i.test(url)) return { host: '(blob)', scheme: 'blob' };

    try {
        const parsed = new URL(url, typeof location !== 'undefined' ? location.href : 'https://runtime.invalid/');
        const explicitScheme = url.match(/^([a-z][a-z\d+.-]*):/i)?.[1]?.toLowerCase();
        return {
            host: parsed.host || '(local)',
            scheme: explicitScheme || 'relative',
        };
    } catch {
        return { host: '(invalid)', scheme: 'invalid' };
    }
};

export const probeEmojiImage = (url: string, timeoutMs = 10_000): Promise<EmojiRuntimeLoadResult> => {
    if (!url.trim() || typeof Image === 'undefined') return Promise.resolve('fail');

    return new Promise(resolve => {
        const image = new Image();
        let settled = false;
        const finish = (result: EmojiRuntimeLoadResult) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            image.onload = null;
            image.onerror = null;
            if (result === 'fail') image.src = '';
            resolve(result);
        };
        const timer = window.setTimeout(() => finish('fail'), timeoutMs);
        image.referrerPolicy = 'no-referrer';
        image.onload = () => finish(image.naturalWidth > 0 && image.naturalHeight > 0 ? 'success' : 'fail');
        image.onerror = () => finish('fail');
        image.src = url;
    });
};

const mapWithConcurrency = async <T, R>(
    items: T[],
    concurrency: number,
    mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
    const results = new Array<R>(items.length);
    let nextIndex = 0;
    const worker = async () => {
        while (nextIndex < items.length) {
            const index = nextIndex++;
            results[index] = await mapper(items[index], index);
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
    return results;
};

const summarize = (entries: EmojiRuntimeDiagnosticEntry[], key: 'category' | 'host') => {
    const counts = new Map<string, { success: number; fail: number }>();
    for (const entry of entries) {
        const label = entry[key];
        const count = counts.get(label) || { success: 0, fail: 0 };
        count[entry.load] += 1;
        counts.set(label, count);
    }
    return Array.from(counts, ([label, count]) => ({ [key]: label, ...count }))
        .sort((a, b) => String(a[key]).localeCompare(String(b[key]), 'zh-CN'));
};

export const buildEmojiRuntimeDiagnostic = async (
    emojis: Emoji[],
    categories: EmojiCategory[],
    options: { loadImage?: LoadImage; concurrency?: number } = {},
): Promise<EmojiRuntimeDiagnosticReport> => {
    const categoryNames = new Map(categories.map(category => [category.id, category.name]));
    const loadImage = options.loadImage || probeEmojiImage;
    const entries = await mapWithConcurrency(emojis, Math.max(1, options.concurrency || 6), async emoji => {
        const url = typeof emoji.url === 'string' ? emoji.url : '';
        const { host, scheme } = sourceParts(url);
        return {
            category: emoji.categoryId
                ? categoryNames.get(emoji.categoryId) || emoji.categoryId
                : categoryNames.get('default') || '默认',
            name: emoji.name,
            url,
            host,
            scheme,
            load: await loadImage(url),
        };
    });

    return {
        emojis: entries,
        summary: {
            categories: summarize(entries, 'category') as EmojiRuntimeDiagnosticReport['summary']['categories'],
            hosts: summarize(entries, 'host') as EmojiRuntimeDiagnosticReport['summary']['hosts'],
        },
    };
};
