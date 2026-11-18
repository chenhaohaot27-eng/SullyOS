// 自主活跃轮提示词红线测试（E4：群成员身份匹配——严禁代替玩家发言；允许沉默）。
import { describe, expect, it } from 'vitest';
import { buildAutonomyInstruction } from './prompts';

describe('buildAutonomyInstruction', () => {
    it('photoAllowed=false 时明确禁止 SEND_PHOTO 与占位文本', () => {
        const text = buildAutonomyInstruction({ userName: '小明', photoAllowed: false, maxMessages: 4 });
        expect(text).toContain('不支持发照片');
        expect(text).toContain('SEND_PHOTO');
    });

    it('photoAllowed=true 时给单轮一张的规则与真实性约束', () => {
        const text = buildAutonomyInstruction({ userName: '小明', photoAllowed: true, maxMessages: 4 });
        expect(text).toContain('最多 1 张');
        expect(text).toContain('严禁编造');
        expect(text).toContain('性格');
    });

    it('两条路径都写明：允许沉默 + 严禁代替玩家发言 + 单轮上限 + 玩家未发言事实', () => {
        for (const photoAllowed of [true, false]) {
            const text = buildAutonomyInstruction({ userName: '小明', photoAllowed, maxMessages: 4 });
            expect(text).toContain('允许沉默');
            expect(text).toContain('严禁代替小明');
            expect(text).toContain('charId 为 "user"');
            expect(text).toContain('最多 4 条');
            expect(text).toContain('本轮什么都没说');
        }
    });
});
