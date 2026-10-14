/**
 * dateLineText — 见面台词行判定的唯一实现（GAL/阅读/历史三处共用，
 * 保证「行号 + 台词文字」的片段标识在不同视图里一致）。
 * 逻辑与 DateSession 原实现逐字一致（cleanTextForDisplay + 引号判定 + 台词抽取）。
 */

/** 剥掉 [] 内文字并 trim（与 DateSession.cleanTextForDisplay 一致）。 */
export const cleanDateLineForDisplay = (text?: string | null): string => {
    // Remove content inside brackets [] and trim extra spaces
    // Also remove typical system prompts if any leak through
    return (text || '').replace(/\[.*?\]/g, '').trim();
};

/** 台词行 = 清理后以引号开头（顺带含引号的行是旁白，不算）。 */
export const isDialogueLine = (text: string) => {
    const clean = cleanDateLineForDisplay(text);
    return /^[""\u201C\u300C]/.test(clean);
};

/** 抽台词文字（剥引号，多段引号拼接）；非台词行返回清理后的整行。 */
export const extractDialogueText = (text: string): string => {
    const clean = cleanDateLineForDisplay(text);
    const matches = clean.match(/["\u201C]([^"\u201D]*)["\u201D]/g)
        || clean.match(/[\u300C]([^\u300D]*)[\u300D]/g);
    if (matches) {
        return matches.map(m => m.replace(/["\u201C\u201D\u300C\u300D]/g, '')).join(' ');
    }
    return clean;
};

