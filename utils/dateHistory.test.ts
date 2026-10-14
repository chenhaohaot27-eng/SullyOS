import { describe, expect, it } from 'vitest';
import type { Message } from '../types';
import {
    buildDateHistoryGroups,
    defaultEncounterTitle,
    formatDateHistoryExport,
    groupDateMessagesByDate,
    makeDateHistoryFileName,
    splitDateEncounters,
} from './dateHistory';

const at = (day: number, hour: number, minute = 0) => new Date(2026, 7, day, hour, minute).getTime();

const message = (
    id: number,
    timestamp: number,
    options: { opening?: boolean; role?: Message['role']; content?: string; type?: Message['type']; title?: string } = {},
): Message => ({
    id,
    charId: 'char-1',
    role: options.role || 'assistant',
    type: options.type || 'text',
    content: options.content || `消息${id}`,
    timestamp,
    metadata: {
        source: 'date',
        ...(options.opening ? { isOpening: true } : {}),
        ...(options.title !== undefined ? { encounterTitle: options.title } : {}),
    },
});

describe('splitDateEncounters', () => {
    it('有开场锚点时不会再因长时间间隔或跨日误拆同一次见面', () => {
        const groups = splitDateEncounters([
            message(1, at(9, 22), { opening: true }),
            message(2, at(9, 23)),
            message(3, at(10, 8)),
        ]);

        expect(groups).toHaveLength(1);
        expect(groups[0].messages.map(item => item.id)).toEqual([1, 2, 3]);
        expect(groups[0].hasOpeningAnchor).toBe(true);
    });

    it('只在下一条开场记录出现时开启新的一次见面', () => {
        const groups = splitDateEncounters([
            message(1, at(9, 10), { opening: true }),
            message(2, at(9, 12)),
            message(3, at(9, 18), { opening: true }),
            message(4, at(9, 19)),
        ]);

        expect(groups.map(group => group.messages.map(item => item.id))).toEqual([[1, 2], [3, 4]]);
    });

    it('没有开场标记的旧记录按自然日期兼容分组', () => {
        const groups = splitDateEncounters([
            message(1, at(9, 9)),
            message(2, at(9, 20)),
            message(3, at(10, 8)),
        ]);

        expect(groups.map(group => group.messages.map(item => item.id))).toEqual([[1, 2], [3]]);
        expect(groups.every(group => !group.hasOpeningAnchor)).toBe(true);
    });

    it('自定义标题：开场消息 metadata.encounterTitle 被读进组 title', () => {
        const groups = splitDateEncounters([
            message(1, at(9, 20), { opening: true, title: '和小鱼第一次夜晚散步' }),
            message(2, at(9, 21)),
        ]);
        expect(groups[0].title).toBe('和小鱼第一次夜晚散步');
    });

    it('老历史兼容：无标题的锚点组 title 为 undefined（UI 走默认命名），旧记录组同样 undefined', () => {
        const groups = splitDateEncounters([
            message(1, at(9, 9)),                                    // legacy 组（无锚点）
            message(2, at(9, 20), { opening: true }),                // 锚点组但未命名
            message(3, at(9, 21)),
        ]);
        expect(groups[0].title).toBeUndefined();
        expect(groups[1].title).toBeUndefined();
    });

    it('空串 / 超长标题归一：空串视为未命名，超长截断到 60 字', () => {
        const long = '长'.repeat(80);
        const groups = splitDateEncounters([
            message(1, at(9, 20), { opening: true, title: '   ' }),
            message(2, at(10, 20), { opening: true, title: long }),
        ]);
        expect(groups[0].title).toBeUndefined();
        expect(groups[1].title).toHaveLength(60);
    });

    it('按日期分组保持既有行为，不携带自定义标题（避免一天多次见面误标）', () => {
        const groups = groupDateMessagesByDate([
            message(1, at(9, 20), { opening: true, title: '夜晚散步' }),
            message(2, at(9, 21)),
        ]);
        expect(groups[0].title).toBeUndefined();
        expect(groups[0].encounterCount).toBe(1);
    });
});

describe('defaultEncounterTitle — 默认目录命名', () => {
    it('按开场时间给时段前缀，格式「2026年8月9日 · 晚间陪伴」', () => {
        expect(defaultEncounterTitle(at(9, 21))).toBe('2026年8月9日 · 晚间陪伴');
        expect(defaultEncounterTitle(at(9, 9))).toBe('2026年8月9日 · 上午陪伴');
        expect(defaultEncounterTitle(at(9, 2))).toBe('2026年8月9日 · 深夜陪伴');
    });
});

describe('date history views', () => {
    it('按日期会合并同一天的多次见面并统计开场数', () => {
        const groups = groupDateMessagesByDate([
            message(1, at(9, 9), { opening: true }),
            message(2, at(9, 10)),
            message(3, at(9, 18), { opening: true }),
            message(4, at(10, 8), { opening: true }),
        ]);

        expect(groups).toHaveLength(2);
        expect(groups[0].encounterCount).toBe(2);
        expect(groups[0].messages.map(item => item.id)).toEqual([1, 2, 3]);
    });

    it('组间支持由新到旧和由旧到新排序，组内始终按时间正序', () => {
        const messages = [
            message(3, at(10, 8), { opening: true }),
            message(1, at(9, 9), { opening: true }),
            message(2, at(9, 10)),
        ];

        expect(buildDateHistoryGroups(messages, 'encounter', 'newest').map(group => group.messages[0].id)).toEqual([3, 1]);
        expect(buildDateHistoryGroups(messages, 'encounter', 'oldest').map(group => group.messages[0].id)).toEqual([1, 3]);
        expect(buildDateHistoryGroups(messages, 'encounter', 'newest')[1].messages.map(item => item.id)).toEqual([1, 2]);
    });
});

describe('date history export', () => {
    it('导出文本保留原始舞台动作和说话人', () => {
        const groups = buildDateHistoryGroups([
            message(1, at(9, 9), { opening: true, content: '[走近你]早上好' }),
            message(2, at(9, 9, 5), { role: 'user', content: '早呀' }),
        ], 'encounter', 'oldest');
        const output = formatDateHistoryExport('Sully', groups, 'encounter');

        expect(output).toContain('Sully：[走近你]早上好');
        expect(output).toContain('我：早呀');
        expect(output).toContain('整理方式：按次');
    });

    it('文件名会替换系统不允许的字符', () => {
        expect(makeDateHistoryFileName('A/B:角色', '全部')).toMatch(/^A_B_角色_见面记录_全部_/);
    });
});
