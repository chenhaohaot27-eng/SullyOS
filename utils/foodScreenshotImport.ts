import type { VisionApiConfig } from '../types';
import { blobToDataUrl } from './blobRef';
import { processImageToBlob } from './file';
import { extractContent, extractJson, safeFetchJson } from './safeApi';
import { isVisionApiReady } from './visionApi';

export interface FoodScreenshotExtraction {
    merchantName?: string;
    itemName?: string;
    price?: number;
    description?: string;
    visualSummary?: string;
}

export interface FoodScreenshotImportResult {
    imageBlob: Blob;
    visionAttempted: boolean;
    extraction: FoodScreenshotExtraction;
    error?: string;
}

const FOOD_VISION_PROMPT = `识别这张外卖商品截图中实际可见的信息。只输出一个 JSON 对象：
{"merchantName":"商家名或空字符串","itemName":"商品名或空字符串","price":数字或null,"description":"简短商品描述或空字符串","visualSummary":"不超过200字的客观画面摘要"}
不要猜测截图外的信息，不要输出 JSON 之外的文字。`;

const cleanText = (value: unknown, maxLength: number): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const cleaned = value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
    return cleaned || undefined;
};

/** Food 专用的严格白名单解析；失败时保留模型原文作为 visualSummary。 */
export function parseFoodVisionResponse(raw: string): FoodScreenshotExtraction {
    const fallback = cleanText(raw, 2000);
    const parsed = extractJson(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return fallback ? { visualSummary: fallback } : {};
    }
    const value = parsed as Record<string, unknown>;
    const numericPrice = typeof value.price === 'number'
        ? value.price
        : (typeof value.price === 'string' && value.price.trim() ? Number(value.price) : undefined);
    const price = typeof numericPrice === 'number' && Number.isFinite(numericPrice) && numericPrice >= 0
        ? numericPrice
        : undefined;
    return {
        ...(cleanText(value.merchantName, 120) ? { merchantName: cleanText(value.merchantName, 120) } : {}),
        ...(cleanText(value.itemName, 120) ? { itemName: cleanText(value.itemName, 120) } : {}),
        ...(price !== undefined ? { price } : {}),
        ...(cleanText(value.description, 500) ? { description: cleanText(value.description, 500) } : {}),
        ...(cleanText(value.visualSummary, 2000) ? { visualSummary: cleanText(value.visualSummary, 2000) } : {}),
    };
}

/**
 * 截图只在这里调用一次独立 visionApi。Blob 仅驻留内存，确认保存前不写 IndexedDB。
 * 识别关闭、配置不完整或请求失败都返回可手工继续的结果，不把导入判为 fatal。
 */
export async function prepareFoodScreenshotImport(
    file: File,
    visionConfig?: VisionApiConfig | null,
): Promise<FoodScreenshotImportResult> {
    const imageBlob = await processImageToBlob(file, { maxWidth: 1600, quality: 0.9 });
    if (visionConfig?.enabled !== true) {
        return { imageBlob, visionAttempted: false, extraction: {} };
    }
    if (!isVisionApiReady(visionConfig)) {
        return {
            imageBlob,
            visionAttempted: false,
            extraction: {},
            error: '识图已开启，但配置尚未填写完整；可以继续手动填写',
        };
    }

    try {
        const imageUrl = await blobToDataUrl(imageBlob);
        const baseUrl = visionConfig.baseUrl.trim().replace(/\/+$/, '');
        const data = await safeFetchJson(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${visionConfig.apiKey.trim()}`,
            },
            body: JSON.stringify({
                model: visionConfig.model.trim(),
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'text', text: FOOD_VISION_PROMPT },
                        { type: 'image_url', image_url: { url: imageUrl } },
                    ],
                }],
                temperature: 0,
                max_tokens: 900,
                stream: false,
            }),
        }, 0, 60_000, { appId: 'food_delivery', appName: '外卖', purpose: '外卖截图识别' });
        const raw = extractContent(data);
        return {
            imageBlob,
            visionAttempted: true,
            extraction: parseFoodVisionResponse(raw),
        };
    } catch (error) {
        return {
            imageBlob,
            visionAttempted: true,
            extraction: {},
            error: `截图识别失败，可以继续手动填写：${error instanceof Error ? error.message : '未知错误'}`,
        };
    }
}
