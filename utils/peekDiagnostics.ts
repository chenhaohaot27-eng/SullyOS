/** One-shot, device-local provenance. Only the report type is persisted. */
type Side = 'system' | 'user';
type Fields = Record<string, string | number | boolean>;
interface Leaf { side: Side; kind: string; chars: number; fields?: Fields; sha256?: string; rawSha256?: string; rawChars?: number }
export interface PeekReport {
    leaves: Leaf[];
    totals: Record<Side, number>;
    matched: Record<Side, boolean>;
    escapeChars: number;
    quoteChars: number;
    structureChars: number;
    hashUnavailable: boolean;
}

const byMessages = new WeakMap<object, PeekTrace>();
const inFlight = new Map<string, { trace: PeekTrace; system: string; user: unknown; credential: string }>();

export function trackPeek(messages: object, trace: PeekTrace) { byMessages.set(messages, trace); }

export function bindPeek(messages: {content?: unknown}[], nonce: string, framed: {content?: unknown}[], credential: string) {
    const trace = byMessages.get(messages);
    if (!trace) return;
    if (typeof framed[0]?.content !== 'string' || typeof messages[0]?.content !== 'string') return;
    trace.add('system', '回复边界', framed[0].content.slice(messages[0].content.length));
    byMessages.delete(messages);
    inFlight.set(nonce, { trace, system: framed[0].content, user: framed[1]?.content, credential });
    return () => { inFlight.delete(nonce); };
}

export function capturePeek(messages: { role: string; content: string }[], totalChars: number) {
    const system = messages?.[0]?.content;
    if (!inFlight.size || typeof system !== 'string' || messages.length !== 2 || typeof messages[1]?.content !== 'string') return;
    const nonce = /<\/reply-([\da-f-]{36})>[^<>]*$/i.exec(system)?.[1];
    const bound = nonce && inFlight.get(nonce);
    if (bound) return bound.trace.report(system, messages[1].content, totalChars,
        { system: bound.system === system, user: bound.user === messages[1].content }, bound.credential);
}

// Hash exact JS code units (UTF-16LE, no BOM), including unpaired surrogates.
async function digest(value: string): Promise<string> {
    const bytes = new Uint8Array(value.length * 2);
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        bytes[i * 2] = code & 255;
        bytes[i * 2 + 1] = code >>> 8;
    }
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}

export class PeekTrace {

    private parts: { leaf: Leaf; text?: string; raw?: string }[] = [];
    private lengths = { user: 0, system: 0 };

    add(side: Side, kind: string, value: string, fields?: Fields, raw?: string) {
        if (!value.length && !fields) return;
        this.parts.push({ leaf: { side, kind, chars: value.length, fields, rawChars: raw?.length }, text: value, raw });
        this.lengths[side] += value.length;
    }

    // Called immediately after a section is appended to the canonical system string.
    mark(kind: string, system: string) { this.add('system', kind, system.slice(this.lengths.system)); }

    async report(system: string, user: string, totalChars: number, unchanged = { user: true, system: true }, credential = ''): Promise<PeekReport> {
        const totals = { system: system.length, user: user.length };
        const quoteChars = 4;
        const serialized = JSON.stringify(system).length + JSON.stringify(user).length;
        const matched = { user: unchanged.user && this.lengths.user === totals.user, system: unchanged.system && this.lengths.system === totals.system };
        // Start hashing after fetch has been dispatched. Source values are only temporary references.
        await new Promise(resolve => setTimeout(resolve, 0));
        const hashes = new Map<string, string>();
        let hashUnavailable = false;
        const sha = async (value: string) => {
            if (hashUnavailable) return undefined;
            try {
                if (!hashes.has(value)) hashes.set(value, await digest(value));
                return hashes.get(value)!;
            } catch {
                hashUnavailable = true;
                return undefined;
            }
        };
        const leaves: Leaf[] = [];
        for (const { leaf, text, raw } of this.parts) {
            const fields = leaf.fields && Object.fromEntries(Object.entries(leaf.fields).map(([k, v]) => {
                if (typeof v === 'number' || typeof v === 'boolean') return [k, v];
                if (typeof v !== 'string') return [k, '未归因'];
                const sensitive = (credential && v.includes(credential)) || (k === 'title' && !!raw?.trim() && v.includes(raw.trim()))
                    || /bearer|authorization|api[_ -]?key|sk-[\w-]+|AIza[\w-]+|https?:\/\/|[\r\n]/i.test(v);
                return [k, sensitive ? '已脱敏' : v.slice(0, 96)];
            }));
            leaves.push({ ...leaf, fields, sha256: text ? await sha(text) : undefined,
                rawSha256: raw ? await sha(raw) : undefined });
        }
        for (const side of ['system', 'user'] as const) {
            if (matched[side]) continue;
            // Never invent attribution, even if a future transport rewrites a whole turn.
            for (let i = leaves.length - 1; i >= 0; i--) if (leaves[i].side === side) leaves.splice(i, 1);
            leaves.push({ side, kind: '未归因（最终消息与组装计数不符）', chars: totals[side] });
        }
        return { leaves, totals, matched, quoteChars, escapeChars: serialized - totals.user - totals.system - quoteChars,
            structureChars: totalChars - serialized, hashUnavailable };
    }
}

/** Observe the cooked literal fragments and substitutions at the interpolation site.
 * A null label means the substitution already emitted its own leaves. */
export function peekTemplate(trace: PeekTrace | undefined, literals: string, slots: (string | null)[]) {
    return (strings: TemplateStringsArray, ...values: string[]) => {
        let result = strings[0];
        trace?.add('user', literals, result);
        values.forEach((value, i) => {
            const v = String(value);
            if (slots[i]) trace?.add('user', slots[i]!, v);
            trace?.add('user', literals, strings[i + 1]);
            result += v + strings[i + 1];
        });
        return result;
    };
}

export function formatPeekReport(report: PeekReport): string {
    const rows = report.leaves.map((leaf, i) => {
        const percent = (leaf.chars * 100 / (report.totals[leaf.side] || 1)).toFixed(2);
        return `#${i + 1} ${leaf.side} ${leaf.kind} · ${leaf.chars} (${percent}%) ${JSON.stringify(leaf.fields || {})}`
            + (leaf.rawChars != null ? ` 原始=${leaf.rawChars} 原文SHA256=${leaf.rawSha256 || '—'}` : '')
            + ` 注入SHA256=${leaf.sha256 || '—'}`;
    });
    const top = report.leaves.map((l, i) => ({ n: i + 1, chars: l.chars })).sort((a, b) => b.chars - a.chars).slice(0, 5);
    const duplicates = new Map<string, Set<number>>();
    report.leaves.forEach((l, i) => {
        for (const hash of [l.rawSha256, l.sha256]) {
            if (!hash || (l.rawChars ?? l.chars) < 1) continue;
            const ids = duplicates.get(hash) ?? new Set<number>();
            ids.add(i + 1);
            duplicates.set(hash, ids);
        }
    });
    const repeats = [...duplicates].filter(([, ids]) => ids.size > 1 && [...ids].some(n => report.leaves[n-1].rawChars != null || report.leaves[n-1].chars >= 80));
    return ['===== 陪伴开场组件明细 v1（本次捕获） =====',
        '仅叶项计入占比；rawChars（原始）与 formattedChars（格式化后，含本条前缀）为参考。长度 UTF-16；SHA-256 输入 UTF-16LE。',
        'processedByWatermark 为捕获时处理水位；转发子项缺失 ID 时只记录序号。bookId 为本地挂载记录 ID，entryId 优先使用导入 UID。原导入文件的父书 ID 未留存。',
        ...(['system', 'user'] as const).map(s => `${s} 正文=${report.totals[s]} 叶项合计=${report.leaves.filter(l=>l.side===s).reduce((n,l)=>n+l.chars,0)} ${report.matched[s]?'对账一致':'未归因'}`),
        `JSON 转义=${report.escapeChars} 字符串引号=${report.quoteChars} 其余请求体结构和参数=${report.structureChars}`,
        '前五大叶项 ' + top.map(t => `#${t.n} (${t.chars})`).join('、'),
        '重复提示（完全相同的正文或长片段） ' + (repeats.map(([hash, ids]) => `${hash}: #${[...ids].join(', #')}`).join('\n') || '无'),
        ...(report.hashUnavailable ? ['本机 SHA-256 不可用，重复检查不完整。'] : []),
        ...rows].join('\n');
}
