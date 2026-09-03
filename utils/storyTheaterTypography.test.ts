import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
    DEFAULT_STORY_READING_FONT_SIZE,
    normalizeStoryReadingFontSize,
    STORY_READING_FONT_OPTIONS,
} from './storyTheaterTypography';

describe('story theater reading typography', () => {
    it('provides the four requested sizes and Chinese reading line heights', () => {
        expect(STORY_READING_FONT_OPTIONS).toEqual([
            { value: 'small', label: '小', fontSize: 16, lineHeight: 1.65 },
            { value: 'standard', label: '标准', fontSize: 18, lineHeight: 1.7 },
            { value: 'large', label: '大', fontSize: 20, lineHeight: 1.75 },
            { value: 'extra-large', label: '特大', fontSize: 22, lineHeight: 1.8 },
        ]);
    });

    it('uses standard for missing or invalid legacy values', () => {
        expect(DEFAULT_STORY_READING_FONT_SIZE).toBe('standard');
        expect(normalizeStoryReadingFontSize(undefined)).toBe('standard');
        expect(normalizeStoryReadingFontSize('unknown')).toBe('standard');
        expect(normalizeStoryReadingFontSize('large')).toBe('large');
    });

    it('wires typography only to displayed player and main story text', () => {
        const source = readFileSync(fileURLToPath(new URL('../components/date/story/StoryTheaterSession.tsx', import.meta.url)), 'utf8');
        expect(source).toContain('<StoryAppearanceButton readingEntry />');
        expect(source.match(/story-reading-text/g)).toHaveLength(4);
        expect(source).toContain("<ImmersiveStoryText key={index} text={block.text} className='story-reading-text");
        expect(source).not.toContain("textarea value={input} className='story-reading-text");
        expect(source).not.toContain("textarea autoFocus value={editDraft} className='story-reading-text");
    });
});
