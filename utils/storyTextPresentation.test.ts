import { describe, expect, it } from 'vitest';
import { parseImmersiveStoryText } from './storyTextPresentation';

describe('Story Theater 沉浸分层文本解析', () => {
    it('按原顺序拆分旁白、内心、台词和后续动作', () => {
        expect(parseImmersiveStoryText('祁煜挑了下眉。~~差点就笑出来了。~~「你确定？」他慢悠悠地朝你靠近一步。')).toEqual([
            { kind: 'narration', text: '祁煜挑了下眉。' },
            { kind: 'thought', text: '差点就笑出来了。' },
            { kind: 'dialogue', text: '「你确定？」' },
            { kind: 'narration', text: '他慢悠悠地朝你靠近一步。' },
        ]);
    });

    it('优先区分 strong 与 atmosphere，并保留多段和空行', () => {
        const text = '*初夏的夜风。*\n\n他看着你，**心跳**快了几分。';
        expect(parseImmersiveStoryText(text)).toEqual([
            { kind: 'atmosphere', text: '初夏的夜风。' },
            { kind: 'narration', text: '\n\n他看着你，' },
            { kind: 'strong', text: '心跳' },
            { kind: 'narration', text: '快了几分。' },
        ]);
    });

    it('支持同段多个同类标记并合并相邻普通文本', () => {
        expect(parseImmersiveStoryText('「一。」旁白。「二。」~~甲~~与~~乙~~')).toEqual([
            { kind: 'dialogue', text: '「一。」' },
            { kind: 'narration', text: '旁白。' },
            { kind: 'dialogue', text: '「二。」' },
            { kind: 'thought', text: '甲' },
            { kind: 'narration', text: '与' },
            { kind: 'thought', text: '乙' },
        ]);
    });

    it('异常或未闭合标记原样回退，不吞字', () => {
        const text = '旁白 ~~未闭合 **也未闭合 「仍未闭合';
        expect(parseImmersiveStoryText(text)).toEqual([{ kind: 'narration', text }]);
    });
});
