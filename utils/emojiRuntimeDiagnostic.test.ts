import { describe, expect, it, vi } from 'vitest';
import { buildEmojiRuntimeDiagnostic } from './emojiRuntimeDiagnostic';

describe('emoji runtime diagnostic', () => {
    it('tests every URL and aggregates category and host results without image data', async () => {
        const loadImage = vi.fn(async (url: string) => url.includes('ok.') ? 'success' as const : 'fail' as const);
        const report = await buildEmojiRuntimeDiagnostic([
            { name: 'ok remote', url: 'https://ok.example/a.png', categoryId: 'cat-a' },
            { name: 'bad http', url: 'http://bad.example/b c.png', categoryId: 'cat-a' },
            { name: 'inline', url: 'data:image/png;base64,AA==', categoryId: 'cat-b' },
            { name: 'missing', url: '', categoryId: 'unknown' },
        ], [
            { id: 'cat-a', name: 'A 分类' },
            { id: 'cat-b', name: 'B 分类' },
        ], { loadImage, concurrency: 2 });

        expect(loadImage).toHaveBeenCalledTimes(4);
        expect(report.emojis).toEqual([
            { category: 'A 分类', name: 'ok remote', url: 'https://ok.example/a.png', host: 'ok.example', scheme: 'https', load: 'success' },
            { category: 'A 分类', name: 'bad http', url: 'http://bad.example/b c.png', host: 'bad.example', scheme: 'http', load: 'fail' },
            { category: 'B 分类', name: 'inline', url: 'data:image/png;base64,AA==', host: '(inline-data)', scheme: 'data', load: 'fail' },
            { category: 'unknown', name: 'missing', url: '', host: '(empty)', scheme: 'empty', load: 'fail' },
        ]);
        expect(report.summary.categories).toEqual([
            { category: 'A 分类', success: 1, fail: 1 },
            { category: 'B 分类', success: 0, fail: 1 },
            { category: 'unknown', success: 0, fail: 1 },
        ]);
        expect(report.summary.hosts).toContainEqual({ host: 'ok.example', success: 1, fail: 0 });
        expect(JSON.stringify(report)).not.toContain('imageContent');
    });
});
