export const STORY_TEXT_PRESENTATION_STORAGE_KEY = 'lemuria_story_text_presentation_v1';

/** 见面（Date）阅读模式的文字呈现开关；与 Story Theater 的 key 各自独立、互不覆盖。 */
export const DATE_TEXT_PRESENTATION_STORAGE_KEY = 'lemuria_date_text_presentation_v1';

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

            // 中文弯引号 “……”：识别为人物台词，引号保留在显示文本里
            if (text[index] === '“') {
                const closeAt = text.indexOf('”', index + 1);
                if (closeAt > index + 1) {
                    consume('dialogue', 1, closeAt, true);
                    continue;
                }
            }

            // 英文直引号 "……"：识别为人物台词，引号保留在显示文本里
            if (text[index] === '"') {
                const closeAt = text.indexOf('"', index + 1);
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

/**
 * 见面（Date）阅读模式专用：只剥离「能确认属于当前角色情绪集合」的行首标签
 * （[normal]/[happy]/[shy]/[angry]/[sad] 及角色自定义情绪），可连续剥多个。
 * 普通方括号文本（如 [提示]、[unknown]）不属于情绪集合，原样保留，避免宽泛正则误删。
 * 不匹配任何已知情绪标签时返回原字符串；剥离时连标签后的空白一并去掉。
 */
export function stripLeadingEmotionTags(line: string, emotionKeys: Iterable<string>): string {
    if (!line) return line;
    const set = emotionKeys instanceof Set ? emotionKeys : new Set(emotionKeys);
    let rest = line;
    for (;;) {
        const match = rest.match(/^\[([a-zA-Z0-9_\-]+)\]\s*/);
        if (!match || !set.has(match[1].toLowerCase())) break;
        rest = rest.slice(match[0].length);
    }
    return rest;
}

/**
 * 见面（Date）阅读模式：读取文字呈现偏好（原文 / 沉浸分层）。
 * 缺失、非法值或 localStorage 不可用时一律回退 'immersive'（新用户默认沉浸分层）。
 */
export function readDateTextPresentation(): StoryTextPresentation {
    try {
        return localStorage.getItem(DATE_TEXT_PRESENTATION_STORAGE_KEY) === 'original' ? 'original' : 'immersive';
    } catch {
        return 'immersive';
    }
}

/** 见面（Date）阅读模式：保存文字呈现偏好；非法值一律规范成 'immersive'。仅写自己的 key，不碰 Story Theater 的设置。 */
export function writeDateTextPresentation(value: StoryTextPresentation): void {
    try {
        localStorage.setItem(DATE_TEXT_PRESENTATION_STORAGE_KEY, value === 'original' ? 'original' : 'immersive');
    } catch { /* 隐私模式等 localStorage 不可用场景：静默忽略，内存态仍生效 */ }
}
