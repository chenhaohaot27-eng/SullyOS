import type { Message } from '../types';

export const localMessageDateKey = (timestamp: number): string => {
    const date = new Date(timestamp);
    return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
};

export const isSameLocalMessageDay = (left: number, right: number): boolean => localMessageDateKey(left) === localMessageDateKey(right);

export const shouldShowMessageDateSeparator = (messages: Message[], index: number): boolean => {
    if (index <= 0) return index === 0 && messages.length > 0;
    return !isSameLocalMessageDay(messages[index - 1].timestamp, messages[index].timestamp);
};

export const formatMessageDateSeparator = (timestamp: number, now: number = Date.now()): string => {
    const date = new Date(timestamp);
    const today = new Date(now);
    const dateDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    const todayDay = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    const dayDiff = Math.round((todayDay - dateDay) / 86_400_000);
    if (dayDiff === 0) return '今天';
    if (dayDiff === 1) return '昨天';
    const weekday = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][date.getDay()];
    const year = date.getFullYear() === today.getFullYear() ? '' : `${date.getFullYear()}年`;
    return `${year}${date.getMonth() + 1}月${date.getDate()}日 ${weekday}`;
};
