import { describe, expect, it } from 'vitest';
import { normalizeAssistantActionFormatting as normalize } from './assistantActionFormat';

describe('normalizeAssistantActionFormatting', () => {
    it('修复单括号与展示态表情，并保持规范标签幂等', () => {
        expect(normalize('[SEND_EMOJI: 开心]')).toBe('[[SEND_EMOJI: 开心]]');
        expect(normalize('[表情：小狗泪丧]')).toBe('[[SEND_EMOJI: 小狗泪丧]]');
        expect(normalize('[表情: 小狗泪丧]')).toBe('[[SEND_EMOJI: 小狗泪丧]]');
        expect(normalize('[表情包：小狗泪丧]')).toBe('[[SEND_EMOJI: 小狗泪丧]]');
        expect(normalize('[表情包: 小狗泪丧]')).toBe('[[SEND_EMOJI: 小狗泪丧]]');
        expect(normalize('[[SEND_EMOJI: 开心]]')).toBe('[[SEND_EMOJI: 开心]]');
    });

    it('不把自然语言里的括号片段当成表情意图', () => {
        expect(normalize('他只是引用了[表情：求抱抱]这几个字'))
            .toBe('他只是引用了[表情：求抱抱]这几个字');
    });

    it('修复转账 ACTION 的单括号，不碰普通转账叙述', () => {
        expect(normalize('[ACTION:TRANSFER|to=user|amount=520]'))
            .toBe('[[ACTION:TRANSFER|to=user|amount=520]]');
        expect(normalize('[ACTION:TRANSFER: 13]')).toBe('[[ACTION:TRANSFER:13]]');
        expect(normalize('[ACTION:TRANSFER_ACCEPT]')).toBe('[[ACTION:TRANSFER_ACCEPT]]');
        expect(normalize('我刚给你转了 520，记得收')).toBe('我刚给你转了 520，记得收');
    });

    it('修复 LIFE 单括号和生活记录展示摘要', () => {
        expect(normalize('[LIFE:MED|布洛芬]')).toBe('[[LIFE:MED|布洛芬]]');
        expect(normalize('[生活记录：支出 13（西瓜汁）]'))
            .toBe('[[LIFE:EXPENSE|13|西瓜汁]]');
        expect(normalize('[生活记录：吃药 · 布洛芬]')).toBe('[[LIFE:MED|布洛芬]]');
        expect(normalize('[生活记录：锻炼 · 跑步 30分钟]'))
            .toBe('[[LIFE:EXERCISE|跑步|30分钟]]');
        expect(normalize('[生活记录：生理期开始]')).toBe('[[LIFE:PERIOD_START]]');
    });

    it('不把带历史状态的卡片或普通方括号文字变成副作用', () => {
        expect(normalize('[生活记录：支出 13（西瓜汁）（已有记录，未重复添加）]'))
            .toBe('[生活记录：支出 13（西瓜汁）（已有记录，未重复添加）]');
        expect(normalize('她发了一个开心表情')).toBe('她发了一个开心表情');
        expect(normalize('我看了[那本书]')).toBe('我看了[那本书]');
    });

    it('独立成行的自然语言表情指令转成 canonical 标签（修复只发文字不发图）', () => {
        // ① 带冒号
        expect(normalize('发个表情包：委屈')).toBe('[[SEND_EMOJI: 委屈]]');
        expect(normalize('来个表情：猫猫')).toBe('[[SEND_EMOJI: 猫猫]]');
        expect(normalize('（发个表情包：委屈）')).toBe('[[SEND_EMOJI: 委屈]]');
        // ② 名字在前
        expect(normalize('给你丢个猫猫表情')).toBe('[[SEND_EMOJI: 猫猫]]');
        expect(normalize('发个猫猫表情包')).toBe('[[SEND_EMOJI: 猫猫]]');
        expect(normalize('甩张委屈表情')).toBe('[[SEND_EMOJI: 委屈]]');
        // ③ 用某表情
        expect(normalize('用那个委屈的表情')).toBe('[[SEND_EMOJI: 委屈]]');
        expect(normalize('（用这个狗狗的表情）')).toBe('[[SEND_EMOJI: 狗狗]]');
        // 前后正文行不受影响，只转命中的那一行
        expect(normalize('哼，不理你了\n发个表情包：委屈\n睡觉去了'))
            .toBe('哼，不理你了\n[[SEND_EMOJI: 委屈]]\n睡觉去了');
    });

    it('行内叙述与含"表情"字样的普通文本不误判（宁可不发也不误发）', () => {
        expect(normalize('这个表情包太好笑了')).toBe('这个表情包太好笑了');
        expect(normalize('我给你发个表情包')).toBe('我给你发个表情包'); // 无可提取名字，保持文本
        expect(normalize('我觉得你刚才那个表情很可爱')).toBe('我觉得你刚才那个表情很可爱');
        expect(normalize('我今天买了个新表情包周边')).toBe('我今天买了个新表情包周边');
    });
});
