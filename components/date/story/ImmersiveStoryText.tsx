import React, { memo, useMemo } from 'react';
import { parseImmersiveStoryText, type StoryTextSegmentKind } from '../../../utils/storyTextPresentation';

const SEGMENT_CLASS: Record<StoryTextSegmentKind, string> = {
    narration: '',
    thought: 'italic line-through opacity-80',
    strong: 'font-semibold',
    atmosphere: 'italic',
    dialogue: 'font-semibold',
};

const SEGMENT_COLOR: Partial<Record<StoryTextSegmentKind, string>> = {
    thought: 'var(--story-muted)',
    atmosphere: 'var(--story-muted)',
    dialogue: 'var(--story-accent-ink)',
};

/** 调用方直接给定颜色（适配自身背景）；缺省字段回落 Story Theater CSS 变量。 */
export interface ImmersiveStoryTextTheme {
    /** 正文颜色；不传则沿用 <p> 继承色 */
    base?: string;
    /** 台词颜色 */
    accent?: string;
    /** 内心活动 / 气氛描写颜色 */
    muted?: string;
}

/** Story Theater 默认排版，不传 className 时保持原效果完全不变。 */
const DEFAULT_CLASS = 'font-serif text-[15px] leading-8 text-slate-800 whitespace-pre-wrap break-words';

interface ImmersiveStoryTextProps {
    text: string;
    /** 覆盖默认 <p> 样式（如见面阅读模式）；不传保持 Story Theater 现有效果 */
    className?: string;
    /** 直接给定语义颜色以适配调用方背景；不传沿用 Story Theater CSS 变量 */
    theme?: ImmersiveStoryTextTheme;
}

const ImmersiveStoryText: React.FC<ImmersiveStoryTextProps> = memo(({ text, className, theme }) => {
    const segments = useMemo(() => parseImmersiveStoryText(text), [text]);

    const colorOf = (kind: StoryTextSegmentKind): string | undefined => {
        if (kind === 'dialogue') return theme?.accent ?? SEGMENT_COLOR.dialogue;
        if (kind === 'thought' || kind === 'atmosphere') return theme?.muted ?? SEGMENT_COLOR[kind];
        return undefined;
    };

    return <p className={className || DEFAULT_CLASS} style={theme?.base ? { color: theme.base } : undefined}>
        {segments.map((segment, index) => segment.kind === 'narration'
            ? <React.Fragment key={index}>{segment.text}</React.Fragment>
            : <span key={index} className={SEGMENT_CLASS[segment.kind]} style={{ color: colorOf(segment.kind) }}>{segment.text}</span>)}
    </p>;
});

ImmersiveStoryText.displayName = 'ImmersiveStoryText';

export default ImmersiveStoryText;
