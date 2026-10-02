export type StoryReadingFontSize = 'small' | 'standard' | 'large' | 'extra-large';

export interface StoryReadingFontOption {
    value: StoryReadingFontSize;
    label: string;
    fontSize: number;
    lineHeight: number;
}

export const DEFAULT_STORY_READING_FONT_SIZE: StoryReadingFontSize = 'standard';

export const STORY_READING_FONT_OPTIONS: readonly StoryReadingFontOption[] = [
    { value: 'small', label: '小', fontSize: 16, lineHeight: 1.65 },
    { value: 'standard', label: '标准', fontSize: 18, lineHeight: 1.7 },
    { value: 'large', label: '大', fontSize: 20, lineHeight: 1.75 },
    { value: 'extra-large', label: '特大', fontSize: 22, lineHeight: 1.8 },
];

export function normalizeStoryReadingFontSize(value: unknown): StoryReadingFontSize {
    return STORY_READING_FONT_OPTIONS.some(option => option.value === value)
        ? value as StoryReadingFontSize
        : DEFAULT_STORY_READING_FONT_SIZE;
}
