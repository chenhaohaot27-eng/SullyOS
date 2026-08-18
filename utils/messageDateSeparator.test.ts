import { describe, expect, it } from 'vitest';
import type { Message } from '../types';
import { formatMessageDateSeparator, shouldShowMessageDateSeparator } from './messageDateSeparator';

const row = (id: number, timestamp: number): Message => ({ id, charId: 'c', role: 'user', type: 'text', content: '', timestamp });

describe('Message 日期分隔', () => {
    it('同一自然日只显示一次，跨日时再次显示', () => {
        const messages = [
            row(1, new Date(2026, 7, 17, 23, 58).getTime()),
            row(2, new Date(2026, 7, 17, 23, 59).getTime()),
            row(3, new Date(2026, 7, 18, 0, 1).getTime()),
        ];
        expect(messages.map((_, index) => shouldShowMessageDateSeparator(messages, index))).toEqual([true, false, true]);
    });

    it('按本地自然日显示今天、昨天和跨年日期', () => {
        const now = new Date(2026, 7, 18, 12).getTime();
        expect(formatMessageDateSeparator(new Date(2026, 7, 18, 1).getTime(), now)).toBe('今天');
        expect(formatMessageDateSeparator(new Date(2026, 7, 17, 23).getTime(), now)).toBe('昨天');
        expect(formatMessageDateSeparator(new Date(2025, 11, 31, 12).getTime(), now)).toMatch(/^2025年12月31日 星期/);
    });
});
