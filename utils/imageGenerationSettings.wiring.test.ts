import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'components/settings/ImageGenerationSettings.tsx'), 'utf8');
const osContextSource = readFileSync(resolve(process.cwd(), 'context/OSContext.tsx'), 'utf8');
const statusBarSource = readFileSync(resolve(process.cwd(), 'components/os/StatusBar.tsx'), 'utf8');

describe('image generation settings model refresh wiring', () => {
    it('uses the shared service and keeps a searchable manual-input fallback', () => {
        expect(source).toContain('listAvailableModels(config)');
        expect(source).not.toMatch(/\bfetch\s*\(/);
        expect(source).toContain('刷新模型');
        expect(source).toContain('搜索已刷新的模型');
        expect(source).toContain('仅显示可能支持生图的模型');
        expect(source).toContain('显示全部模型');
        expect(source).toContain('保留手动输入');
        expect(source).toContain('最近刷新：');
    });

    it('routes image failures through structured redacted logs and labels 429 as busy', () => {
        expect(osContextSource).toContain('getImageGenerationLogMeta');
        expect(osContextSource).toContain('sanitizeImageGenerationLogText');
        expect(osContextSource).toContain("source: imageLogMeta ? 'Image API' : 'API Request'");
        expect(osContextSource).toContain("response.status === 429 ? '当前模型线路繁忙'");
        expect(statusBarSource).toContain("onlyImageApiBusy ? '生图线路繁忙' : 'SYSTEM ERROR'");
    });
});
