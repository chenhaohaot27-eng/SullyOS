import type { CharacterProfile, Message, StoryTheaterEntry } from '../types';
import { DB } from './db';

export type ContinuityEventSource = 'story_theater' | 'call' | 'world' | 'schedule' | 'location';

export interface ContinuityCanonicalEvent {
    source: ContinuityEventSource;
    startedAt: number;
    endedAt?: number;
    title?: string;
    summary: string;
}

export interface ContinuitySnapshot {
    now: number;
    lastChatAt?: number;
    elapsedSinceChatMs?: number;
    recentCanonicalEvents: ContinuityCanonicalEvent[];
}

export interface ContinuityBuildInput {
    character: Pick<CharacterProfile, 'id' | 'timeAwarenessEnabled'>;
    privateMessages: Message[];
    storyTheaters: StoryTheaterEntry[];
    storyMessagesByEntryId: Record<string, Message[]>;
    now: number;
    maxEvents?: number;
}

const NON_CHAT_SOURCES = new Set(['date', 'call', 'call-end-popup', 'story_theater', 'story_theater_memory', 'system']);
const HIDDEN_STORY_BLOCKS = ['backstage', 'mind_weather', 'shot_debts', 'affinity_panel', 'reply_choices', 'mini_theater', 'worldline', 'world_line'];

export const isNormalPrivateChatMessage = (message: Message, charId: string): boolean => {
    if (message.charId !== charId || message.groupId || message.role === 'system') return false;
    if (message.charId.startsWith('story-theater:')) return false;
    return !NON_CHAT_SOURCES.has(String(message.metadata?.source || '').toLowerCase());
};

const sortedMessages = (messages: Message[]): Message[] => [...messages].sort((a, b) => a.timestamp - b.timestamp || a.id - b.id);

const lastChatBeforeCurrentTurn = (messages: Message[], charId: string): number | undefined => {
    const direct = sortedMessages(messages.filter(message => isNormalPrivateChatMessage(message, charId)));
    let index = direct.length - 1;
    while (index >= 0 && direct[index].role === 'user') index -= 1;
    return direct[index]?.timestamp;
};

const decodeEntities = (text: string): string => text
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");

export const extractCanonicalStoryText = (content: string): string => {
    let text = decodeEntities(String(content || '')).replace(/\r\n?/g, '\n');
    const taggedStory = [...text.matchAll(/<story_text\b[^>]*>([\s\S]*?)<\/story_text\s*>/gi)]
        .map(match => match[1]);
    if (taggedStory.length > 0) {
        text = taggedStory.join('\n');
    } else {
        for (const tag of HIDDEN_STORY_BLOCKS) {
            const closed = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi');
            const unclosed = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*$`, 'gi');
            text = text.replace(closed, ' ').replace(unclosed, ' ');
        }
    }
    return text
        .replace(/~~[\s\S]*?~~/g, ' ')
        .replace(/<\/?[a-z][^>]*>/gi, ' ')
        .replace(/\*\*|\*/g, '')
        .replace(/\s+/g, ' ')
        .trim();
};

const truncate = (text: string, limit: number): string => text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;

const storySummary = (entry: StoryTheaterEntry, relevantMessages: Message[], boundary: number): string => {
    const archiveSummary = [...(entry.archives || [])]
        .filter(archive => archive.summary?.trim() && archive.createdAt > boundary)
        .sort((a, b) => b.createdAt - a.createdAt)[0]?.summary;
    if (archiveSummary) return truncate(extractCanonicalStoryText(archiveSummary), 700);

    const excerpts = relevantMessages
        .filter(message => message.role === 'user' || message.role === 'assistant')
        .slice(-4)
        .map(message => {
            const text = extractCanonicalStoryText(message.content);
            if (!text) return '';
            return `${message.role === 'user' ? '用户推进' : '剧情正文'}：${truncate(text, 260)}`;
        })
        .filter(Boolean);
    return truncate(excerpts.join('；'), 700);
};

export const buildContinuitySnapshot = (input: ContinuityBuildInput): ContinuitySnapshot => {
    const { character, now } = input;
    const lastChatAt = lastChatBeforeCurrentTurn(input.privateMessages, character.id);
    const boundary = lastChatAt ?? Number.NEGATIVE_INFINITY;
    const events = input.storyTheaters
        .filter(entry => entry.characterIds.includes(character.id))
        .map(entry => {
            const relevantMessages = sortedMessages(input.storyMessagesByEntryId[entry.id] || [])
                .filter(message => Number.isFinite(message.timestamp) && message.timestamp > boundary && message.timestamp <= now);
            if (relevantMessages.length === 0) return null;
            const summary = storySummary(entry, relevantMessages, boundary);
            if (!summary) return null;
            return {
                source: 'story_theater' as const,
                startedAt: relevantMessages[0].timestamp,
                endedAt: relevantMessages[relevantMessages.length - 1].timestamp,
                title: entry.title || undefined,
                summary,
            };
        })
        .filter((event): event is NonNullable<typeof event> => event !== null)
        .sort((a, b) => a.startedAt - b.startedAt)
        .slice(-Math.max(1, Math.min(3, input.maxEvents ?? 3)));

    return {
        now,
        ...(lastChatAt !== undefined ? { lastChatAt, elapsedSinceChatMs: Math.max(0, now - lastChatAt) } : {}),
        recentCanonicalEvents: events,
    };
};

export const formatElapsedContinuity = (elapsedMs: number): string => {
    const minutes = Math.floor(elapsedMs / 60_000);
    const hours = Math.floor(elapsedMs / 3_600_000);
    const days = Math.floor(elapsedMs / 86_400_000);
    if (minutes < 10) return '几分钟前';
    if (minutes < 60) return '不到一小时';
    if (hours < 24) return `约 ${Math.max(1, hours)} 小时`;
    if (days < 2) return '昨天';
    if (days < 14) return `约 ${days} 天`;
    if (days < 56) return '数周';
    return `约 ${Math.max(2, Math.round(days / 30))} 个月`;
};

const formatLocalDateTime = (timestamp: number): string => {
    const date = new Date(timestamp);
    const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${weekdays[date.getDay()]} ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
};

export const formatContinuityContext = (
    snapshot: ContinuitySnapshot,
    timeAwarenessEnabled: boolean,
): string => {
    if (snapshot.lastChatAt === undefined && snapshot.recentCanonicalEvents.length === 0) return '';
    const lines = ['### 跨 App 时间连续性 (Continuity Context)'];
    if (timeAwarenessEnabled) {
        lines.push(`- 当前真实时间：${formatLocalDateTime(snapshot.now)}。`);
        if (snapshot.lastChatAt !== undefined && snapshot.elapsedSinceChatMs !== undefined) {
            lines.push(`- 上次普通私聊停在：${formatLocalDateTime(snapshot.lastChatAt)}；距今${formatElapsedContinuity(snapshot.elapsedSinceChatMs)}。`);
        }
    } else {
        lines.push('- 该角色关闭了时间流逝强化：不要机械陈述间隔，但仍须遵守以下事件先后。');
    }
    if (snapshot.recentCanonicalEvents.length > 0) {
        lines.push(snapshot.lastChatAt !== undefined
            ? '- 上次普通私聊之后已确认的线下/主时间线事件（由早到晚）：'
            : '- 最近已确认的线下/主时间线事件（由早到晚）：');
        snapshot.recentCanonicalEvents.forEach(event => {
            lines.push(`  - [${formatLocalDateTime(event.startedAt)}]${event.title ? `《${event.title}》` : ''} ${event.summary}`);
        });
    } else {
        lines.push('- 上次普通私聊之后没有可确认的跨 App 事件记录。');
    }
    lines.push(
        '- 连续性规则：时间更晚的已确认事件优先于更早 Message 里的即时状态；不得把旧场景中的动作当作此刻仍在持续。',
        '- 没有记录的时间空档不要自行补写大量事实。计划与完成必须严格区分：只有“计划前往”时，只能当作最后已知计划，不能擅自改写成“已经抵达”。',
        '- 这些信息用于内部判断；除非自然相关，不要每次回复都机械报出过去了多久。',
    );
    return `\n${lines.join('\n')}\n`;
};

export const loadContinuitySnapshot = async (
    character: CharacterProfile,
    now: number = Date.now(),
): Promise<ContinuitySnapshot> => {
    const [privateMessages, storyTheaters] = await Promise.all([
        DB.getRecentMessagesByCharIdMatching(character.id, 20, message => isNormalPrivateChatMessage(message, character.id)),
        DB.getStoryTheaters(),
    ]);
    const relevantEntries = storyTheaters.filter(entry => entry.characterIds.includes(character.id));
    const storyRows = await Promise.all(relevantEntries.map(async entry => [
        entry.id,
        await DB.getRecentMessagesByCharId(`story-theater:${entry.id}`, 12, true),
    ] as const));
    return buildContinuitySnapshot({
        character,
        privateMessages,
        storyTheaters: relevantEntries,
        storyMessagesByEntryId: Object.fromEntries(storyRows),
        now,
    });
};
