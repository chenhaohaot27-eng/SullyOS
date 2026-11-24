import type { APIConfig, ApiPreset } from '../types';
import type { ApiCallLogEntry } from './apiCallLog';
import {
  buildGeminiNativeEndpoint,
  buildGeminiNativeRequest,
  readGeminiResponse,
} from './geminiNativeChat';
import { matrixRequests } from './protocolMatrixTransport';
import { normalizeOpenAiChatResponse } from './chatCompletionClient';
import { safeResponseJson } from './safeApi';
import { completionOutcome, assertCompletionDelivered } from './completionOutcome';
import { ChatParser } from './chatParser';
import { extractChatPhotoIntent } from './chatPhotoIntent';

const TARGET = 'api.tiantoken.com';
const MODEL = 'gemini-3.6-flash';
export const SHORT =
  'BEGIN 2026-11-24 13:06，你好。\n[[SEND_EMOJI: 招手]]\n[[SEND_PHOTO: {"prompt":"green cup"}]]\nEND';
const LONG = 'BEGIN ' + '2026年11月24日，我们下午三点见。'.repeat(15) + ' END';
type Mode = {
  name: string;
  native?: boolean;
  stream: boolean;
  ui: boolean;
  extra?: Record<string, unknown>;
  completionCap?: boolean;
};
const CHAT: Mode[] = [
  { name: 'chat-json', stream: false, ui: false },
  { name: 'chat-sse', stream: true, ui: true },
  { name: 'chat-upgrade', stream: false, ui: true },
  { name: 'chat-explicit-sse', stream: true, ui: false },
  { name: 'chat-temperature', stream: false, ui: false, extra: { temperature: 0.1 } },
  { name: 'chat-top-p', stream: false, ui: false, extra: { top_p: 1 } },
  { name: 'chat-doc-pair-json', stream: false, ui: false, extra: { temperature: 0.1, top_p: 1 } },
  { name: 'chat-doc-pair-sse', stream: true, ui: true, extra: { temperature: 0.1, top_p: 1 } },
  { name: 'chat-completion-cap', stream: false, ui: false, completionCap: true },
  { name: 'chat-thinking-json', stream: false, ui: false, extra: { reasoning_effort: 'low' } },
  { name: 'chat-thinking-sse', stream: true, ui: true, extra: { reasoning_effort: 'low' } },
];
const NATIVE: Mode[] = [
  { name: 'native-json', native: true, stream: false, ui: false },
  { name: 'native-sse', native: true, stream: true, ui: true },
  {
    name: 'native-thinking-json',
    native: true,
    stream: false,
    ui: false,
    extra: { thinkingConfig: { includeThoughts: true } },
  },
  {
    name: 'native-thinking-sse',
    native: true,
    stream: true,
    ui: true,
    extra: { thinkingConfig: { includeThoughts: true } },
  },
];
function base(config: APIConfig) {
  try {
    const url = new URL(config.baseUrl);
    return url.protocol === 'https:' &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password &&
      /^\/(?:v1(?:beta)?\/?)?$/.test(url.pathname)
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}
const gemini = (m: string) => /^gemini-[\w.-]+$/i.test(m) && !/image|tts|embedding|live|audio/i.test(m);
const cleanId = (s: unknown) =>
  typeof s === 'string' && /^[\w.\-/:]{1,120}$/.test(s) && !/sk-|bearer/i.test(s) ? s : undefined;

export function matrixStations(active: APIConfig, presets: ApiPreset[], log: ApiCallLogEntry[]) {
  const configs = [active, ...presets.map((p) => p.config)];
  const target = configs.find((c) => base(c)?.hostname === TARGET && c.apiKey);
  const controls = configs.filter((c) => {
    const root = base(c);
    return (
      root &&
      root.hostname !== TARGET &&
      c.apiKey &&
      log.some(
        (e) =>
          e.ok &&
          !e.pending &&
          !e.superseded &&
          gemini(e.model) &&
          (!e.purpose || /聊天|对话|chat/i.test(e.purpose)) &&
          base({ baseUrl: e.baseUrl } as APIConfig)?.origin === root.origin,
      )
    );
  });
  return {
    target,
    controls: controls.filter(
      (c, i) =>
        controls.findIndex(
          (other) => base(other)?.origin === base(c)?.origin && other.apiKey === c.apiKey,
        ) === i,
    ),
  };
}
async function trace(response: Response, expected: string) {
  const sizes: number[] = [],
    splitUtf8At: number[] = [];
  const reader = response.body?.getReader(),
    decoder = new TextDecoder();
  let raw = '',
    total = 0,
    previous = 0;
  if (reader)
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > 512 * 1024) {
          void reader.cancel().catch(() => {});
          throw Error('response-size');
        }
        if (value.length && (value[0] & 0xc0) === 0x80) splitUtf8At.push(previous);
        previous = total;
        sizes.push(value.length);
        raw += decoder.decode(value, { stream: true });
      }
      raw += decoder.decode();
    } finally {
      reader.releaseLock();
    }
  const events: any[] = [];
  let done = false,
    rawText = '',
    snapshot = false,
    previousDelta = '',
    cumulative = false,
    malformed = false;
  const visible = (v: any): string =>
    typeof v === 'string'
      ? v
      : Array.isArray(v)
        ? v
            .filter((p) => !p?.thought && (!p?.type || p.type === 'text'))
            .map((p) => (typeof p === 'string' ? p : (p?.text ?? '')))
            .join('')
        : '';
  const safe = (s: string) => (expected.includes(s) ? s : { length: s.length });
  const absorb = (j: any) => {
    if (Array.isArray(j)) {
      j.forEach(absorb);
      return;
    }
    const ev: any = { model: cleanId(j.model ?? j.modelVersion) };
    const c = j.choices?.[0],
      g = j.candidates?.[0];
    if (c) {
      for (const k of ['delta', 'message']) {
        if (!c[k]) continue;
        const t = visible(c[k].content);
        ev[k] = {
          shape: Array.isArray(c[k].content) ? 'array' : typeof c[k].content,
          content: safe(t),
          reasoningLength:
            typeof c[k].reasoning_content === 'string' ? c[k].reasoning_content.length : 0,
        };
        if (k === 'message') {
          snapshot ||= rawText.length > 0;
          rawText = t;
        } else {
          if (t && previousDelta && t.length > previousDelta.length && t.startsWith(previousDelta))
            cumulative = true;
          if (t) previousDelta = t;
          rawText += t;
        }
      }
      ev.finish = cleanId(c.finish_reason);
    }
    if (g) {
      ev.parts = (g.content?.parts ?? []).map((p: any) =>
        p.thought ? { thoughtLength: p.text?.length ?? 0 } : { text: safe(visible(p.text)) },
      );
      rawText += visible(g.content?.parts);
      ev.finish = cleanId(g.finishReason);
    }
    events.push(ev);
  };
  if (response.ok)
    try {
      if (/^(?:data:|event:|:)/m.test(raw)) {
        for (const block of raw.split(/\r?\n\r?\n/)) {
          const data = block
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          if (data === '[DONE]') done = true;
          else if (data) absorb(JSON.parse(data));
        }
      } else absorb(JSON.parse(raw));
    } catch {
      malformed = true;
    }
  const errorHint = response.ok
    ? undefined
    : raw.match(
        /max_completion_tokens|max_tokens|reasoning_effort|thinkingConfig|unsupported|not.found|permission|quota|rate.limit/i,
      )?.[0];
  return {
    http: response.status,
    type: response.headers.get('content-type')?.split(';')[0],
    sizes,
    splitUtf8At,
    events,
    done,
    snapshot,
    cumulative,
    malformed,
    rawText,
    errorHint,
  };
}

async function probe(c: APIConfig, model: string, m: Mode, expected: string, transport: typeof fetch) {
  const root = base(c)!;
  const cap = expected === LONG ? 512 : 128;
  const body: any = {
    model,
    messages: [{ role: 'user', content: '请逐字输出以下内容，不加解释或代码围栏。\n' + expected }],
    [m.completionCap ? 'max_completion_tokens' : 'max_tokens']: cap,
    stream: m.stream,
    ...(!m.native ? m.extra : {}),
  };
  const out = m.native ? buildGeminiNativeRequest(body) : body;
  if (m.native && m.extra) Object.assign((out.generationConfig ??= {}), m.extra);
  const url = m.native
    ? buildGeminiNativeEndpoint(root.origin, model, !m.stream)
    : root.origin + '/v1/chat/completions';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  const init: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.apiKey },
    body: JSON.stringify(out),
    signal: controller.signal,
    redirect: 'error',
  };
  let seen: boolean | undefined, captured: ReturnType<typeof trace> | undefined;
  let sentParameters: Record<string, unknown> | undefined;
  matrixRequests.set(init, {
    uiStream: m.ui,
    wire(stream, res, sampling) {
      seen = stream;
      sentParameters = sampling;
      captured = trace(res, expected);
      void captured.catch(() => {});
    },
  });
  const basic = {
    host: root.host,
    method: 'POST',
    requestContentType: 'application/json',
    model,
    probe: m.name,
    path: new URL(url).pathname,
    uiStream: m.ui,
    requestedStream: m.stream,
    cap,
    parameters: m.extra,
    completionCap: !!m.completionCap,
    long: expected === LONG,
  };
  try {
    const res = await transport(url, init);
    const wire = await (captured ?? trace(res.clone(), expected));
    const { rawText, ...structure } = wire;
    const result = {
      ...basic,
      ...structure,
      wireStream: seen,
      sentParameters,
      rawLength: rawText.length,
    };
    if (!res.ok)
      return {
        ...result,
        status:
          res.status === 401 || res.status === 403
            ? '鉴权受限'
            : res.status === 404 || res.status === 405
              ? '接口不可用'
              : res.status === 400 || res.status === 422
                ? '请求参数被拒'
                : 'HTTP 错误',
      };
    try {
      const normalized = m.native
        ? await readGeminiResponse(res, model)
        : normalizeOpenAiChatResponse(await safeResponseJson(res));
      assertCompletionDelivered(normalized);
      const text = normalized.choices[0].message.content ?? '';
      const photo = extractChatPhotoIntent(text);
      const parts = ChatParser.splitResponse(ChatParser.sanitize(photo.cleanedContent));
      const bubbles = parts.flatMap((p) =>
        p.type === 'emoji' ? ['emoji:' + p.content] : ChatParser.chunkText(p.content),
      );
      const finish = completionOutcome(normalized);
      const correctBubbles =
        expected === LONG
          ? bubbles.length === 1 && bubbles[0] === LONG
          : JSON.stringify(bubbles) === JSON.stringify([expected.split('\n')[0], 'emoji:招手', 'END']) &&
            photo.intent?.prompt === 'green cup' &&
            photo.tagCount === 1;
      const status = wire.malformed
        ? '原始响应格式异常'
        : text !== rawText
          ? '协议适配差异'
          : finish.kind !== 'complete'
            ? '结束状态异常'
            : rawText !== expected
              ? '上游正文与固定样本不同'
              : !correctBubbles
                ? '后处理差异'
                : seen === undefined
                  ? '未观察到实际出站请求'
                  : '通过';
      return {
        ...result,
        status,
        finish,
        adaptedLength: text.length,
        bubbleCount: bubbles.length,
        emojiIntents: parts.filter((p) => p.type === 'emoji').length,
        photoIntents: photo.intent ? 1 : 0,
      };
    } catch {
      return { ...result, status: '适配或结束校验失败' };
    }
  } catch {
    return { ...basic, status: '网络或读取失败' };
  } finally {
    clearTimeout(timer);
    matrixRequests.delete(init);
  }
}

export async function runProtocolMatrix(
  active: APIConfig,
  presets: ApiPreset[],
  log: ApiCallLogEntry[],
  transport: typeof fetch = fetch,
) {
  const { target, controls } = matrixStations(active, presets, log);
  const rows: Awaited<ReturnType<typeof probe>>[] = [];
  const notes: string[] = [];
  if (!target) return { notes: ['当前客户端缺少已保存的词元聊天配置。'], rows };
  if (!controls.length) notes.push('未找到有近期 Gemini 聊天成功记录的正常站预设。');
  const winners: { c: APIConfig; model: string; m: Mode }[] = [];
  const halted = new Set<APIConfig>();
  for (const c of [target, ...controls]) {
    const root = base(c)!;
    if (rows.length >= 32) {
      notes.push(root.host + ' 未验证：本批短探测已达 32 次。');
      continue;
    }
    let model = gemini(c.model) ? c.model : '';
    let ids: string[] | undefined;
    try {
      const r = await transport(root.origin + '/v1/models', {
        headers: { Authorization: 'Bearer ' + c.apiKey },
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      });
      if ([401, 402, 403, 429].includes(r.status)) {
        notes.push(root.host + ' 模型列表 HTTP ' + r.status + '，停止该站。');
        continue;
      }
      if (r.ok)
        ids = ((await r.json()).data ?? [])
          .map((v: any) => v.id)
          .filter((v: any) => typeof v === 'string' && gemini(v));
      notes.push(
        root.host +
          ' 模型列表 HTTP ' +
          r.status +
          '；可见 Gemini 聊天型号 ' +
          (ids?.join(', ') || '无可用列表'),
      );
    } catch {
      notes.push(root.host + ' 模型列表不可读，仅尝试现有配置的型号。');
    }
    if (ids)
      model = ids.includes(MODEL)
        ? MODEL
        : ids.includes(model)
          ? model
          : (ids.find((id) => /flash/i.test(id)) ?? ids[0] ?? '');
    if (!model) {
      notes.push(root.host + ' 缺少可核实的 Gemini 模型。');
      continue;
    }
    // Single-factor variants run only after their protocol's basic probe succeeds.
    for (const family of [CHAT, NATIVE]) {
      let supported = false,
        blocked = false,
        thinkingRejected = false,
        needsCompletionCap = false;
      for (const [i, variant] of family.entries()) {
        if (rows.length >= 32) {
          notes.push(root.host + ' 剩余短探测因本批上限跳过。');
          break;
        }
        if ((i > 1 && !supported) || (thinkingRejected && variant.name.includes('thinking'))) continue;
        if (needsCompletionCap && variant.completionCap) continue;
        const m = needsCompletionCap ? { ...variant, completionCap: true } : variant;
        const r = await probe(c, model, m, SHORT, transport);
        rows.push(r);
        if (!('http' in r) || r.http >= 500 || [401, 403, 429, 402].includes(r.http)) {
          blocked = true;
          break;
        }
        if (
          rows.length < 32 &&
          i === 0 &&
          !m.native &&
          'http' in r &&
          r.http === 400 &&
          /max_(completion_)?tokens/i.test(r.errorHint ?? '')
        ) {
          needsCompletionCap = true;
          const alternate = { ...m, name: 'chat-json-completion-cap', completionCap: true };
          const corrected = await probe(c, model, alternate, SHORT, transport);
          rows.push(corrected);
          if (!('http' in corrected) || corrected.http >= 500 || [401, 402, 403, 429].includes(corrected.http)) {
            blocked = true;
            break;
          }
          supported = corrected.status === '通过';
          if (supported) winners.push({ c, model, m: alternate });
        }
        if (m.name.includes('thinking') && 'http' in r && [400, 422].includes(r.http))
          thinkingRejected = true;
        if ('http' in r && r.http >= 200 && r.http < 300) supported = true;
        if (r.status === '通过' && i < 2) winners.push({ c, model, m });
      }
      if (blocked) {
        halted.add(c);
        notes.push(root.host + ' 本站停止探测，原因见最后一项结果。');
        break;
      }
    }
  }
  const eligible = winners.filter((w) => !halted.has(w.c));
  const candidate =
    eligible.find((w) => w.c === target && !w.m.native && !w.m.stream) ??
    eligible.find((w) => w.c === target) ??
    eligible[0];
  if (candidate) {
    const r = await probe(candidate.c, candidate.model, candidate.m, LONG, transport);
    rows.push(r);
    notes.push(
      r.status === '通过'
        ? '短样本与长样本均通过：' + r.host + ' / ' + r.model + ' / ' + r.probe
        : '短样本候选未通过长回复验证。',
    );
  }
  const overview = [...new Set(rows.map((row) => row.host + ' ' + row.model))].flatMap((station) =>
    ['chat', 'native'].map((protocol) => {
      const get = (kind: string) =>
        rows.find(
          (row) =>
            !row.long && row.host + ' ' + row.model === station && row.probe === protocol + '-' + kind,
        );
      const json = get('json'),
        sse = get('sse');
      const state =
        json?.status === '通过' && sse?.status === '通过'
          ? '两种短样本传输均兼容'
          : json?.status === '通过' && sse
            ? '非流式通过，流式未通过'
            : sse?.status === '通过' && json
              ? '流式通过，非流式未通过'
              : json?.status === sse?.status
                ? json?.status
                : undefined;
      return {
        station,
        protocol,
        state: state ?? '无法验证或需查看逐项结果',
        json: json?.status,
        sse: sse?.status,
      };
    }),
  );
  return { notes, overview, rows };
}
