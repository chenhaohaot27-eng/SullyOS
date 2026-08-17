export const STORY_TEXT_PRESENTATION_STORAGE_KEY = 'lemuria_story_text_presentation_v1';

export type StoryTextPresentation = 'original' | 'immersive';
export type StoryTextSegmentKind = 'narration' | 'thought' | 'strong' | 'atmosphere' | 'dialogue';

export interface StoryTextSegment {
    kind: StoryTextSegmentKind;
    text: string;
}

const appendSegment = (segments: StoryTextSegment[], kind: StoryTextSegmentKind, text: string): void => {
    if (!text) return;
    const previous = segments[segments.length - 1];
    if (previous?.kind === kind) previous.text += text;
    else segments.push({ kind, text });
};

const findSingleAsteriskClose = (text: string, from: number): number => {
    for (let index = from; index < text.length; index += 1) {
        if (text[index] !== '*') continue;
        if (text[index - 1] === '*' || text[index + 1] === '*') continue;
        return index;
    }
    return -1;
};

export function parseImmersiveStoryText(text: string): StoryTextSegment[] {
    try {
        const segments: StoryTextSegment[] = [];
        let plainStart = 0;
        let index = 0;

        const consume = (kind: StoryTextSegmentKind, markerLength: number, closeAt: number, keepMarkers = false) => {
            appendSegment(segments, 'narration', text.slice(plainStart, index));
            const end = closeAt + markerLength;
            appendSegment(segments, kind, keepMarkers ? text.slice(index, end) : text.slice(index + markerLength, closeAt));
            index = end;
            plainStart = end;
        };

        while (index < text.length) {
            if (text.startsWith('~~', index)) {
                const closeAt = text.indexOf('~~', index + 2);
                if (closeAt > index + 2) {
                    consume('thought', 2, closeAt);
                    continue;
                }
                index += 2;
                continue;
            }

            if (text.startsWith('**', index)) {
                const closeAt = text.indexOf('**', index + 2);
                if (closeAt > index + 2) {
                    consume('strong', 2, closeAt);
                    continue;
                }
                index += 2;
                continue;
            }

            if (text[index] === '*') {
                const closeAt = findSingleAsteriskClose(text, index + 1);
                if (closeAt > index + 1) {
                    consume('atmosphere', 1, closeAt);
                    continue;
                }
            }

            if (text[index] === '「') {
                const closeAt = text.indexOf('」', index + 1);
                if (closeAt > index + 1) {
                    consume('dialogue', 1, closeAt, true);
                    continue;
                }
            }

            index += 1;
        }

        appendSegment(segments, 'narration', text.slice(plainStart));
        return segments.length > 0 ? segments : [{ kind: 'narration', text }];
    } catch {
        return [{ kind: 'narration', text }];
    }
}
