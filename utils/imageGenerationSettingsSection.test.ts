import { describe, it, expect } from 'vitest';
import {
    imageGenerationSectionStatus,
    IMAGE_GENERATION_SECTION_DEFAULT_OPEN,
    toggleImageGenerationSectionOpen,
} from './imageGenerationSettingsSection';

describe('imageGenerationSettingsSection — 生图 API 设置卡可折叠', () => {
    it('默认收起（与其他 SettingsSection 一致）', () => {
        expect(IMAGE_GENERATION_SECTION_DEFAULT_OPEN).toBe(false);
    });

    it('点击标题行切换开合', () => {
        expect(toggleImageGenerationSectionOpen(false)).toBe(true);
        expect(toggleImageGenerationSectionOpen(true)).toBe(false);
    });

    it('标题行常显已启用 / 未启用状态徽标', () => {
        expect(imageGenerationSectionStatus(true).label).toBe('已启用');
        expect(imageGenerationSectionStatus(false).label).toBe('未启用');
        expect(imageGenerationSectionStatus(true).className).toContain('fuchsia');
        expect(imageGenerationSectionStatus(false).className).toContain('slate');
    });
});
