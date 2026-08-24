import { describe, expect, it } from 'vitest';
import { resolveEmojiByModelReference } from './emojiResolver';

const emojis = [
    { name: '求抱抱', url: 'blob:hug' },
    { name: '小狗求抱抱', url: 'blob:dog-hug' },
    { name: '小猫开心', url: 'blob:cat-happy' },
];

describe('resolveEmojiByModelReference', () => {
    it('优先精确匹配库内名称', () => {
        expect(resolveEmojiByModelReference('求抱抱', emojis).emoji?.url).toBe('blob:hug');
    });

    it('清理空格、引号和无意义前缀后精确匹配', () => {
        expect(resolveEmojiByModelReference(' " 求抱抱 " ', emojis).emoji?.url).toBe('blob:hug');
        expect(resolveEmojiByModelReference('表情包：「求抱抱」', emojis).emoji?.url).toBe('blob:hug');
    });

    it('模型描述包含库内名称时选最长的唯一安全候选', () => {
        expect(resolveEmojiByModelReference('白嘟熊张开双臂做出求抱抱动作', emojis).emoji?.url).toBe('blob:hug');
        expect(resolveEmojiByModelReference('图里是小狗求抱抱的动作', emojis).emoji?.url).toBe('blob:dog-hug');
    });

    it('等长多候选或不存在的名称不强行匹配', () => {
        const ambiguous = [
            { name: '猫猫开心', url: 'blob:cat' },
            { name: '狗狗开心', url: 'blob:dog' },
        ];
        expect(resolveEmojiByModelReference('猫猫开心和狗狗开心', ambiguous)).toMatchObject({
            emoji: null,
            reason: 'ambiguous-substring',
        });
        expect(resolveEmojiByModelReference('查无此表情', emojis)).toMatchObject({ emoji: null });
    });

    it('过短泛词不参与子串模糊匹配', () => {
        expect(resolveEmojiByModelReference('这张图在笑', [{ name: '笑', url: 'blob:generic' }])).toMatchObject({ emoji: null });
    });
});
