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

const ImmersiveStoryText: React.FC<{ text: string }> = memo(({ text }) => {
    const segments = useMemo(() => parseImmersiveStoryText(text), [text]);

    return <p className='font-serif text-[15px] leading-8 text-slate-800 whitespace-pre-wrap break-words'>
        {segments.map((segment, index) => segment.kind === 'narration'
            ? <React.Fragment key={index}>{segment.text}</React.Fragment>
            : <span key={index} className={SEGMENT_CLASS[segment.kind]} style={{ color: SEGMENT_COLOR[segment.kind] }}>{segment.text}</span>)}
    </p>;
});

ImmersiveStoryText.displayName = 'ImmersiveStoryText';

export default ImmersiveStoryText;
