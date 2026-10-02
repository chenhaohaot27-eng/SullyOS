import { describe, expect, it } from 'vitest';
import type { Message, StoryTheaterEntry } from '../types';
import { buildContinuitySnapshot, formatContinuityContext } from './continuityContext';

const DAY = 86_400_000;
const NOW = new Date(2026, 7, 18, 12, 0).getTime();

const message = (id: number, timestamp: number, role: Message['role'], content: string, charId = 'char-1'): Message => ({
    id, charId, role, type: 'text', content, timestamp,
});

const theater = (createdAt: number): StoryTheaterEntry => ({
    id: 'story-1', title: '西北行前夜', premise: '', characterIds: ['char-1'], writesToCharacterMemory: false,
    characterMemoryDates: {}, carryCharacterMemory: true, characterContextLimits: {}, archiveAfter: 40,
    archiveStrategy: 'summary', archives: [], selectedWorldbookIds: [], createdAt, updatedAt: createdAt,
});

const build = (privateMessages: Message[], storyMessages: Message[] = [], enabled = true) => buildContinuitySnapshot({
    character: { id: 'char-1', timeAwarenessEnabled: enabled },
    privateMessages,
    storyTheaters: storyMessages.length > 0 ? [theater(NOW - 2 * DAY)] : [],
    storyMessagesByEntryId: { 'story-1': storyMessages },
    now: NOW,
});

describe('Message 跨 App 时间连续性', () => {
    it('明确上次私聊已经过去约三天', () => {
        const snapshot = build([
            message(1, NOW - 3 * DAY, 'assistant', '三天前的回复'),
            { ...message(10, NOW - DAY, 'assistant', '更晚的见面镜像'), metadata: { source: 'date' } },
            message(11, NOW - DAY, 'assistant', '另一个角色', 'char-2'),
            message(2, NOW, 'user', '今天刚发出的新消息'),
        ]);
        expect(snapshot.lastChatAt).toBe(NOW - 3 * DAY);
        expect(formatContinuityContext(snapshot, true)).toContain('距今约 3 天');
    });

    it('只纳入上次私聊之后更晚的 Story Theater 事件', () => {
        const snapshot = build(
            [message(1, NOW - 3 * DAY, 'assistant', '旧聊天')],
            [message(10, NOW - 2 * DAY, 'assistant', '<story_text>两人在机场附近确认了明早的安排。</story_text>', 'story-theater:story-1')],
        );
        expect(snapshot.recentCanonicalEvents).toHaveLength(1);
        expect(snapshot.recentCanonicalEvents[0].summary).toContain('确认了明早的安排');
    });

    it('保留计划语义，不擅自转换为已经抵达', () => {
        const snapshot = build(
            [message(1, NOW - 3 * DAY, 'assistant', '旧聊天')],
            [message(10, NOW - 2 * DAY, 'assistant', '<story_text>她说明早计划从上海飞往兰州。</story_text>', 'story-theater:story-1')],
        );
        const context = formatContinuityContext(snapshot, true);
        expect(context).toContain('计划从上海飞往兰州');
        expect(context).not.toContain('已经抵达兰州');
        expect(context).toContain('计划与完成必须严格区分');
    });

    it('忽略早于上次私聊的 Story Theater', () => {
        const snapshot = build(
            [message(2, NOW - 2 * DAY, 'assistant', '较新的聊天')],
            [message(10, NOW - 3 * DAY, 'assistant', '更早的剧情', 'story-theater:story-1')],
        );
        expect(snapshot.recentCanonicalEvents).toEqual([]);
    });

    it('关闭时间强化时仍保留正确事件顺序，但不注入间隔措辞', () => {
        const snapshot = build(
            [message(1, NOW - 3 * DAY, 'assistant', '旧聊天')],
            [
                message(10, NOW - 2 * DAY, 'assistant', '先发生', 'story-theater:story-1'),
                message(11, NOW - DAY, 'assistant', '后发生', 'story-theater:story-1'),
            ],
            false,
        );
        const context = formatContinuityContext(snapshot, false);
        expect(context).not.toContain('距今约 3 天');
        expect(context).toContain('先发生');
        expect(context.indexOf('先发生')).toBeLessThan(context.indexOf('后发生'));
    });
});
