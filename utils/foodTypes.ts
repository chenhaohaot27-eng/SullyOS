export type FoodCatalogSource =
    | 'imported_share'
    | 'imported_screenshot'
    | 'manual'
    | 'simulated';

export type FoodPlatform = 'meituan' | 'eleme' | 'other' | 'unknown';

export interface FoodCatalogItem {
    schemaVersion: 1;
    id: string;
    fingerprint: string;
    source: FoodCatalogSource;
    platform: FoodPlatform;
    merchantName?: string;
    name: string;
    description?: string;
    price?: number;
    currency: 'CNY';
    originalUrl?: string;
    rawShareText?: string;
    imageRef?: string;
    visualSummary?: string;
    favorite?: boolean;
    createdAt: number;
    updatedAt: number;
}

const normalizePart = (value: string | undefined): string =>
    (value || '').normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/g, ' ');

/** 只保留安全 URL，并消除不影响商品身份的 hash 与常见追踪参数。 */
export function normalizeFoodUrl(value: string | undefined): string | undefined {
    const input = value?.trim();
    if (!input) return undefined;
    try {
        const url = new URL(input);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
        url.hash = '';
        ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'spm'].forEach(key => {
            url.searchParams.delete(key);
        });
        url.searchParams.sort();
        return url.toString();
    } catch {
        return undefined;
    }
}

/** FNV-1a：轻量、同步且确定，不引入依赖；不是安全哈希。 */
function stableHash(value: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36).padStart(7, '0');
}

export interface FoodFingerprintInput {
    platform: FoodPlatform;
    merchantName?: string;
    name: string;
    originalUrl?: string;
}

/** 同一平台、商家、商品与稳定 URL 得到同一 fingerprint；不依赖时间。 */
export function buildFoodCatalogFingerprint(input: FoodFingerprintInput): string {
    const identity = [
        input.platform,
        normalizePart(input.merchantName),
        normalizePart(input.name),
        normalizeFoodUrl(input.originalUrl) || '',
    ].join('\u001f');
    return `food_v1_${stableHash(identity)}`;
}
