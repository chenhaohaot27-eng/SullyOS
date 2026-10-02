import { describe, it, expect } from 'vitest';
import { buildProactiveActionGuide, isProactiveActionEnabled } from './proactiveAction';

describe('proactiveAction prompt strategy', () => {
    describe('buildProactiveActionGuide', () => {
        const guide = buildProactiveActionGuide();

        it('should emphasize proactive behavior without waiting for explicit requests', () => {
            expect(guide).toContain('无需等待对方明确要求');
            expect(guide).toContain('不需要等待对方说"发照片"');
            expect(guide).toContain('现实中你会顺手拍一张发过去');
        });

        it('should describe characters as living beings not just responders', () => {
            expect(guide).toContain('持续生活中的真实存在');
            expect(guide).toContain('不仅是响应问题的助手');
        });

        it('should list concrete scenarios suitable for PHOTO', () => {
            expect(guide).toContain('对方问"你在干嘛');
            expect(guide).toContain('你正在经历具体的事件');
            expect(guide).toContain('你想表达关心/想念/惊喜');
            expect(guide).toContain('聊天中出现明显可视化的场景');
        });

        it('should list concrete content types for PHOTO', () => {
            expect(guide).toContain('自拍');
            expect(guide).toContain('环境');
            expect(guide).toContain('食物');
            expect(guide).toContain('风景');
        });

        it('should still allow NONE (implicit default)', () => {
            expect(guide).toContain('普通寒暄客套');
            expect(guide).toContain('默认 NONE');
            expect(guide).not.toContain('必须输出');
        });

        it('should warn against mechanical/forced usage', () => {
            expect(guide).toContain('不要为了展示功能而机械发图');
            expect(guide).toContain('只在真正觉得');
            expect(guide).toContain('避免连发');
        });

        it('should distinguish from SEND_PHOTO (player-requested)', () => {
            expect(guide).toContain('与 SEND_PHOTO 的区别');
            expect(guide).toContain('对方**明确要求**');
            expect(guide).toContain('自主判断');
        });

        it('should not contain any specific character names or personalities', () => {
            // Check for common Chinese names that might leak
            expect(guide).not.toMatch(/小[红白黑明美丽华]/);
            expect(guide).not.toMatch(/李[明华伟强]/);
            expect(guide).not.toMatch(/张[伟强明]/);
            // Check for personality traits that are too specific
            expect(guide).not.toMatch(/温柔|高冷|傲娇|腹黑/);
        });

        it('should not introduce fixed probabilities or keyword triggers', () => {
            expect(guide).not.toMatch(/\d+%|百分之/);
            expect(guide).not.toMatch(/概率|随机/);
            expect(guide).not.toMatch(/关键词|触发词/);
        });

        it('should mention cooldown mechanism handles frequency', () => {
            expect(guide).toContain('cooldown');
            expect(guide).toContain('自动限制频率');
        });

        it('should provide complete format instructions', () => {
            expect(guide).toContain('prompt');
            expect(guide).toContain('caption');
            expect(guide).toContain('includeCharacter');
            expect(guide).toContain('style');
        });

        it('should be character-agnostic and context-driven', () => {
            expect(guide).toContain('结合自身设定和当前情境');
            expect(guide).toContain('你的性格');
            expect(guide).not.toContain('你应该');
            expect(guide).not.toContain('你必须');
        });
    });

    describe('isProactiveActionEnabled', () => {
        it('should delegate to image generation config check', () => {
            // isProactiveActionEnabled uses require() internally and checks loadImageGenerationConfig
            // The function returns true only when image generation is actually enabled
            // We just verify it's callable and returns a boolean
            const result = isProactiveActionEnabled();
            expect(typeof result).toBe('boolean');
        });
    });
});
