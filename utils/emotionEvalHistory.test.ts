import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EMOTION_EVAL_HISTORY_LIMIT, takeEmotionEvalHistory } from '../hooks/useChatAI';

const useChatAISource = readFileSync(
    fileURLToPath(new URL('../hooks/useChatAI.ts', import.meta.url)),
    'utf-8',
);
const payloadSource = readFileSync(
    fileURLToPath(new URL('./chatRequestPayload.ts', import.meta.url)),
    'utf-8',
);

const msg = (role: string, content: any) => ({ role, content });

describe('takeEmotionEvalHistory — 情绪评估独立窗口（Phase 2A）', () => {
    it('最多保留最近 20 条有效文字消息', () => {
        const messages = Array.from({ length: 60 }, (_, i) =>
            msg(i % 2 === 0 ? 'user' : 'assistant', `消息${i}`));
        const lines = takeEmotionEvalHistory(messages, '小星');
        expect(lines).toHaveLength(EMOTION_EVAL_HISTORY_LIMIT);
        expect(lines).toHaveLength(20);
        // 保留的是最后 20 条：消息40..59
        expect(lines[0]).toBe('[用户]: 消息40');
        expect(lines[19]).toBe('[小星]: 消息59');
    });

    it('图片只留 [图片] 占位，不带 data URL；空白消息不占窗口名额', () => {
        const messages = [
            msg('user', [{ type: 'text', text: '看这个' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }]),
            msg('assistant', [{ type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }]), // 纯图片 → 文本化占位
            msg('user', '   '), // 空白 → 无效行
            msg('assistant', '收到，画得真好。'),
        ];
        const lines = takeEmotionEvalHistory(messages, '小星');
        expect(lines).toHaveLength(3);
        expect(lines[0]).toBe('[用户]: 看这个 [图片]');
        expect(lines[1]).toBe('[小星]: [图片]');
        expect(lines[2]).toBe('[小星]: 收到，画得真好。');
        expect(lines.join('\n')).not.toContain('base64');
        expect(lines.join('\n')).not.toContain('data:');
    });

    it('角色名用于 assistant 行、user 显示为 用户、其余为 系统', () => {
        const lines = takeEmotionEvalHistory([
            msg('user', '嗯'),
            msg('assistant', '好'),
            msg('system', '提醒'),
            msg('tool', '{"ok":1}'),
        ], '阿月');
        expect(lines).toEqual(['[用户]: 嗯', '[阿月]: 好', '[系统]: 提醒', '[系统]: {"ok":1}']);
    });
});

describe('主聊天不受影响 — 接线断言', () => {
    it('useChatAI 情绪评估走 takeEmotionEvalHistory；主聊天 payload 无情绪窗口逻辑', () => {
        expect(useChatAISource).toContain('const recentLines = takeEmotionEvalHistory(apiMessages, char.name)');
        expect(useChatAISource).toContain('EMOTION_EVAL_HISTORY_LIMIT = 20');
        // 主聊天载荷组装不含该窗口（contextLimit 逻辑仍在 chatRequestPayload/ChatPrompts 既有路径）
        expect(payloadSource).not.toContain('takeEmotionEvalHistory');
        expect(payloadSource).not.toContain('EMOTION_EVAL_HISTORY_LIMIT');
    });
});
