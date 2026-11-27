import type { Message } from '../types';
import type { PeekTrace } from './peekDiagnostics';

interface HistoryPart { text: string; prefix?: string; raw?: string; id?: number | string }

export class PeekHistoryDiagnostics {
    private originals: Map<number, Message>;
    private watermark: number | undefined;
    private pieces = new Map<number, { prefix: string; items: HistoryPart[]; forwarded: boolean }>();

    constructor(private trace: PeekTrace, messages: Message[], charId: string) {
        this.originals = new Map(messages.map(m => [m.id, m]));
        try {
            const value = Number(localStorage.getItem('mp_lastMsgId_' + charId) || 0);
            if (Number.isSafeInteger(value)) this.watermark = value;
        } catch { /* storage unavailable; report unknown */ }
    }

    onParts = (id: number, prefix: string, items: HistoryPart[], forwarded: boolean) => {
        this.pieces.set(id, { prefix, items, forwarded });
    };

    message(selected: Message, text: string, rolePrefix: string, index: number) {
        const raw = this.originals.get(selected.id);
        const m = raw ?? selected;
        const parts = this.pieces.get(m.id);
        const source = m.metadata?.source;
        const fields = { messageId: m.id, role: m.role, type: m.type, timestamp: m.timestamp,
            source: typeof source === 'string' && /^[a-z_]{1,40}$/.test(source) ? source : source == null ? 'chat' : '未归因',
            processedByWatermark: this.watermark == null ? '未知' : m.id <= this.watermark,
            formattedChars: rolePrefix.length + text.length,
            formattedMinusRaw: raw ? rolePrefix.length + text.length - raw.content.length : '未归因',
            forwardCount: parts?.forwarded ? parts.items.length : 0 };
        if (index) this.trace.add('user', '历史消息间换行', '\n');
        this.trace.add('user', '历史角色前缀', rolePrefix);
        if (!parts) {
            this.trace.add('user', '历史消息（类型格式化后，内部开销未归因）', text, fields, raw?.content);
            return;
        }
        if (!parts.forwarded) {
            this.trace.add('user', '历史时间与来源格式', parts.prefix);
            const formatted = parts.items[0].text;
            const kind = raw?.content === formatted ? '历史原文' : '历史消息转换结果（内部开销未归因）';
            this.trace.add('user', kind, formatted, fields, raw?.content);
            return;
        }
        this.trace.add('user', '转发卡头', parts.prefix, fields, raw?.content);
        parts.items.forEach((item, i) => {
            if (i) this.trace.add('user', '转发条目间换行', '\n');
            const id = typeof item.id === 'number' || (typeof item.id === 'string' && /^[\w-]{1,80}$/.test(item.id)) ? item.id : '未归因';
            const prefix = item.prefix ?? '';
            this.trace.add('user', '转发说话人格式', prefix);
            this.trace.add('user', '转发子条目', item.text, { cardId: m.id, childId: id, index: i + 1,
                formattedChars: prefix.length + item.text.length }, item.raw);
        });
    }
}
