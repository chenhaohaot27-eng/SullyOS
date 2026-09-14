import { normalizeFoodUrl, type FoodPlatform } from './foodTypes';

export type FoodImportConfidence = 'low' | 'medium' | 'high';

export interface FoodImportParseResult {
    platform: FoodPlatform;
    originalUrl?: string;
    merchantNameCandidate?: string;
    itemNameCandidate?: string;
    priceCandidate?: number;
    confidence: FoodImportConfidence;
    rawShareText: string;
}

const HTTP_URL_RE = /https?:\/\/[^\s<>"']+/i;
const TRAILING_URL_PUNCTUATION = /[)\]}>，。！？、；;：:,.!?]+$/;
const LABEL_RE = /^(店名|商家|店铺|商品名|商品|菜品名|菜品)\s*[：:]\s*(.+)$/i;
const BOILERPLATE_RE = /^(复制|打开|点击|长按|分享|来自|口令|链接|去看看|立即查看|饿了么|美团)(\s|$)/i;

export function sanitizeFoodExternalUrl(value: string | undefined): string | undefined {
    return normalizeFoodUrl(value);
}

function findFirstSafeUrl(text: string): string | undefined {
    const match = text.match(HTTP_URL_RE)?.[0]?.replace(TRAILING_URL_PUNCTUATION, '');
    return sanitizeFoodExternalUrl(match);
}

function detectPlatform(url: string | undefined): FoodPlatform {
    if (!url) return 'unknown';
    try {
        const host = new URL(url).hostname.toLowerCase();
        if (host === 'meituan.com' || host.endsWith('.meituan.com')
            || host === 'meituan.net' || host.endsWith('.meituan.net')
            || host === 'dianping.com' || host.endsWith('.dianping.com')) return 'meituan';
        if (host === 'ele.me' || host.endsWith('.ele.me')) return 'eleme';
        return 'other';
    } catch {
        return 'unknown';
    }
}

function extractPrice(text: string): number | undefined {
    const match = text.match(/(?:[¥￥]\s*(\d+(?:\.\d{1,2})?)|(\d+(?:\.\d{1,2})?)\s*元)(?!\d)/);
    if (!match) return undefined;
    const value = Number(match[1] ?? match[2]);
    return Number.isFinite(value) && value >= 0 ? value : undefined;
}

const cleanCandidate = (value: string): string => value
    .replace(HTTP_URL_RE, '')
    .replace(/(?:[¥￥]\s*\d+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?\s*元)/g, '')
    .replace(/^[\s\-—|·•【】\[\]]+|[\s\-—|·•【】\[\]]+$/g, '')
    .trim()
    .slice(0, 120);

/** 纯本地启发式解析。候选字段始终要经过用户确认，不做网络请求。 */
export function parseFoodImportText(input: string): FoodImportParseResult {
    const rawShareText = typeof input === 'string' ? input.trim() : '';
    const originalUrl = findFirstSafeUrl(rawShareText);
    const platform = detectPlatform(originalUrl);
    const priceCandidate = extractPrice(rawShareText);
    let merchantNameCandidate: string | undefined;
    let itemNameCandidate: string | undefined;
    let explicitMerchant = false;
    let explicitItem = false;

    const candidates: string[] = [];
    for (const rawLine of rawShareText.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line === originalUrl || /^https?:\/\//i.test(line)) continue;
        const labelled = line.match(LABEL_RE);
        if (labelled) {
            const value = cleanCandidate(labelled[2]);
            if (!value) continue;
            if (/^(店名|商家|店铺)$/i.test(labelled[1])) {
                merchantNameCandidate = value;
                explicitMerchant = true;
            } else {
                itemNameCandidate = value;
                explicitItem = true;
            }
            continue;
        }
        const cleaned = cleanCandidate(line);
        if (cleaned && !BOILERPLATE_RE.test(cleaned)) candidates.push(cleaned);
    }

    if (!merchantNameCandidate && !itemNameCandidate) {
        if (candidates.length >= 2) {
            [merchantNameCandidate, itemNameCandidate] = candidates;
        } else if (candidates.length === 1) {
            itemNameCandidate = candidates[0];
        }
    } else {
        if (!merchantNameCandidate && candidates.length > 0) merchantNameCandidate = candidates[0];
        if (!itemNameCandidate && candidates.length > 0) itemNameCandidate = candidates[candidates.length - 1];
    }

    let confidence: FoodImportConfidence = 'low';
    if (explicitMerchant && explicitItem) confidence = 'high';
    else if (itemNameCandidate && (merchantNameCandidate || originalUrl || priceCandidate !== undefined)) confidence = 'medium';

    return {
        platform,
        ...(originalUrl ? { originalUrl } : {}),
        ...(merchantNameCandidate ? { merchantNameCandidate } : {}),
        ...(itemNameCandidate ? { itemNameCandidate } : {}),
        ...(priceCandidate !== undefined ? { priceCandidate } : {}),
        confidence,
        rawShareText,
    };
}
