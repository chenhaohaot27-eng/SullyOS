import { describe, expect, it } from 'vitest';
import { parseFoodImportText, sanitizeFoodExternalUrl } from './foodImportParser';

describe('foodImportParser — 纯本地候选解析', () => {
    it('识别美团域名', () => expect(parseFoodImportText('https://i.meituan.com/deal/123').platform).toBe('meituan'));
    it('识别饿了么域名', () => expect(parseFoodImportText('https://h5.ele.me/shop/123').platform).toBe('eleme'));
    it('未知 http URL 标记为 other', () => expect(parseFoodImportText('https://example.com/food').platform).toBe('other'));
    it.each([
        ['招牌饭 ¥28.9', 28.9],
        ['招牌饭 ￥28.9', 28.9],
        ['招牌饭 28.9元', 28.9],
    ])('解析价格 %s', (text, expected) => expect(parseFoodImportText(text).priceCandidate).toBe(expected));

    it('URL + 多行文字给出商家与商品候选', () => {
        const result = parseFoodImportText('星河食堂\n番茄牛腩饭\n¥28.9\nhttps://i.meituan.com/deal/123');
        expect(result).toMatchObject({
            platform: 'meituan',
            merchantNameCandidate: '星河食堂',
            itemNameCandidate: '番茄牛腩饭',
            priceCandidate: 28.9,
            confidence: 'medium',
        });
        expect(result.originalUrl).toContain('https://i.meituan.com/deal/123');
    });

    it('无 URL 仍解析明确标签', () => {
        expect(parseFoodImportText('店名：小月食堂\n商品：咖喱鸡饭')).toMatchObject({
            platform: 'unknown', merchantNameCandidate: '小月食堂', itemNameCandidate: '咖喱鸡饭', confidence: 'high',
        });
    });

    it('空输入返回低置信度空候选', () => {
        expect(parseFoodImportText('   ')).toEqual({ platform: 'unknown', confidence: 'low', rawShareText: '' });
    });

    it('拒绝可疑与非网页 scheme', () => {
        expect(sanitizeFoodExternalUrl('javascript:alert(1)')).toBeUndefined();
        expect(sanitizeFoodExternalUrl('data:text/html,hello')).toBeUndefined();
        expect(sanitizeFoodExternalUrl('file:///etc/passwd')).toBeUndefined();
        expect(parseFoodImportText('javascript:alert(1)').originalUrl).toBeUndefined();
    });

    it('单行歧义文字只给候选，不伪造高置信度', () => {
        const result = parseFoodImportText('也许是店名也许是菜名');
        expect(result.itemNameCandidate).toBe('也许是店名也许是菜名');
        expect(result.merchantNameCandidate).toBeUndefined();
        expect(result.confidence).toBe('low');
    });

    it('追踪参数不进入安全规范 URL', () => {
        expect(sanitizeFoodExternalUrl('https://example.com/item?id=2&utm_source=share#top'))
            .toBe('https://example.com/item?id=2');
    });
});
