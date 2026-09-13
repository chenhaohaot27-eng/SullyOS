import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { STORY_HISTORY_CHAR_BUDGET, limitStoryHistoryByCharBudget } from './storyTheater';

const sessionSource = readFileSync(
    fileURLToPath(new URL('../components/date/story/StoryTheaterSession.tsx', import.meta.url)),
    'utf-8',
);
const storyTheaterSource = readFileSync(
    fileURLToPath(new URL('./storyTheater.ts', import.meta.url)),
    'utf-8',
);

const msg = (role: 'user' | 'assistant', content: string) => ({ role, content });

describe('limitStoryHistoryByCharBudget — 见面-剧情原始历史预算（Phase 2B1）', () => {
    it('预算内全部保留，顺序不变', () => {
        const messages = [msg('user', '甲'.repeat(100)), msg('assistant', '乙'.repeat(100)), msg('user', '丙'.repeat(100))];
        const limited = limitStoryHistoryByCharBudget(messages, 1000);
        expect(limited).toHaveLength(3);
        expect(limited.map(m => m.content[0])).toEqual(['甲', '乙', '丙']);
    });

    it('超预算时从最旧开始整条丢弃（倒序保留），时间顺序恢复正确', () => {
        const messages = [
            msg('user', '旧1'.repeat(50)),      // 100 chars
            msg('assistant', '旧2'.repeat(50)), // 100
            msg('user', '新1'.repeat(120)),     // 240
            msg('assistant', '新2'.repeat(60)), // 120
        ];
        const limited = limitStoryHistoryByCharBudget(messages, 400);
        // 倒序累计：120 + 240 = 360 ≤ 400；再加 100 会超 → 丢最旧两条
        expect(limited).toHaveLength(2);
        expect(limited[0].content[0]).toBe('新');
        expect(limited[1].content.startsWith('新2')).toBe(true);
        // 顺序仍是时间正序
        expect(limited.map(m => m.role)).toEqual(['user', 'assistant']);
    });

    it('不切断单条消息：边界处宁可少带一条完整消息，也不腰斩正文', () => {
        const messages = [msg('user', 'A'.repeat(200)), msg('assistant', 'B'.repeat(150)), msg('user', 'C'.repeat(100))];
        const limited = limitStoryHistoryByCharBudget(messages, 300);
        // 100 + 150 = 250 ≤ 300；再加 200 超 → 停
        expect(limited).toHaveLength(2);
        expect(limited[0].content).toBe('B'.repeat(150));
        expect(limited[1].content).toBe('C'.repeat(100));
    });

    it('单条超预算消息完整保留（至少保留最新一条，不产生空历史）', () => {
        const messages = [msg('user', '小'), msg('assistant', '巨'.repeat(5000))];
        const limited = limitStoryHistoryByCharBudget(messages, 1000);
        expect(limited).toHaveLength(1);
        expect(limited[0].content).toBe('巨'.repeat(5000));
    });

    it('user/assistant 共用同一总预算（不按角色分别限额），时间顺序恢复正确', () => {
        const messages = [
            msg('user', 'u1'.repeat(50)), msg('assistant', 'a1'.repeat(50)),
            msg('user', 'u2'.repeat(50)), msg('assistant', 'a2'.repeat(50)),
            msg('user', 'u3'.repeat(50)), msg('assistant', 'a3'.repeat(50)),
        ];
        const limited = limitStoryHistoryByCharBudget(messages, 500);
        // 倒序累计 100/条：a3+u3+a2+u2+a1 = 500 ≤ 500，u1 被丢 → 5 条，顺序仍为时间正序
        expect(limited.map(m => m.content.slice(0, 2))).toEqual(['a1', 'u2', 'a2', 'u3', 'a3']);
        expect(limited.map(m => m.role)).toEqual(['assistant', 'user', 'assistant', 'user', 'assistant']);
    });

    it('默认预算 = 40000', () => {
        expect(STORY_HISTORY_CHAR_BUDGET).toBe(40000);
        const huge = Array.from({ length: 500 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', '字'.repeat(200)));
        const limited = limitStoryHistoryByCharBudget(huge);
        const total = limited.reduce((sum, m) => sum + m.content.length, 0);
        expect(total).toBeLessThanOrEqual(STORY_HISTORY_CHAR_BUDGET + 200); // 允许最后一条单条超预算的完整保留
        expect(limited.length).toBeGreaterThan(0);
    });
});

describe('接线与共享内容保护', () => {
    it('textFromHistory 使用预算限制（历史槽位）', () => {
        expect(sessionSource).toContain('limitStoryHistoryByCharBudget(buildStoryHistory(messages))');
    });

    it('continuity / 事件盒 / 向量召回 / persona / worldbook 等共享内容不经过预算', () => {
        // 预算只包住 textFromHistory 这一处；session 源中 scenario/persona/worldbook/actorContext 不引用该 limiter
        const budgetCallCount = (sessionSource.match(/limitStoryHistoryByCharBudget/g) || []).length;
        expect(budgetCallCount).toBe(2); // import + textFromHistory 一处调用
        for (const shared of ['scenario', 'actorContext', 'maskMemoryContext', 'vectorRecall', 'summaries']) {
            expect(sessionSource).toContain(shared);
        }
    });

    it('不生成独立剧情 memory store（无新增 DB 方法 / 第二时间线）', () => {
        const addedBlock = storyTheaterSource.slice(storyTheaterSource.indexOf('STORY_HISTORY_CHAR_BUDGET'));
        for (const banned of ['DB.save', 'new Store', 'storyMemory', 'timeline']) {
            expect(addedBlock).not.toContain(banned);
        }
    });
});
