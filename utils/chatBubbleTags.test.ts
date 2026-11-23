import { describe, expect, it, vi } from 'vitest';
import { ChatParser } from './chatParser';
import { sanitizeForNotification, sanitizeIntoSegments } from './sanitize';
import { applyAssistantPostProcessing, type PostProcessCtx, type XhsCaches } from './applyAssistantPostProcessing';
import { DB } from './db';
import { completeChat } from './chatCompletionClient';

// 气泡拆分 / 标签泄漏回归。样本均为脱敏固定文本。
// 管线口径与 applyAssistantPostProcessing 一致：sanitize(keepCitations) → splitResponse → chunkText。

const bubbles = (raw: string): string[] => {
  const cleaned = ChatParser.sanitize(raw, { keepCitations: true });
  return ChatParser.splitResponse(cleaned).flatMap(p =>
    p.type === 'text' ? ChatParser.chunkText(p.content) : [`<emoji:${p.content}>`]);
};

describe('完整标签整体保护（不被换行撕开）', () => {
  it('[[QUOTE:]] 内部换行：整体留在一个气泡，换行折成空格', () => {
    expect(bubbles('[[QUOTE: 示例\n引用]]\n正文一句话。')).toEqual(['[[QUOTE: 示例 引用]]', '正文一句话。']);
  });

  it('[[QUOTE:\\n内容]] 紧贴正文：标签与正文仍在同一气泡', () => {
    expect(bubbles('[[QUOTE:\n示例引用]]正文一句话。')).toEqual(['[[QUOTE: 示例引用]]正文一句话。']);
  });

  it('标签名与冒号之间折行：规整成下游认得的 [[QUOTE:', () => {
    const out = bubbles('[[QUOTE\n: 示例引用]]\n正文');
    expect(out).toHaveLength(2);
    expect(out[0]).toBe('[[QUOTE: 示例引用]]');
    expect(out[1]).toBe('正文');
  });

  it('[[引用:]] 与全角冒号同样受保护并规整成半角冒号', () => {
    expect(bubbles('[[引用：示例\n引用]]\n正文')).toEqual(['[[引用:示例 引用]]', '正文']);
  });

  it('[[SEND_EMOJI:\\n名称]] 折行：仍解析成一个表情气泡', () => {
    expect(bubbles('你好\n[[SEND_EMOJI:\n抱抱]]\n再见')).toEqual(['你好', '<emoji:抱抱>', '再见']);
  });

  it('未闭合的 [[QUOTE: 不吞正文，按原有换行规则切分', () => {
    expect(bubbles('[[QUOTE: 没闭合\n第一句。\n第二句。')).toEqual(['[[QUOTE: 没闭合', '第一句。', '第二句。']);
  });

  it('原本合法的单行标签字节不变（含无空格写法）', () => {
    expect(bubbles('[[QUOTE:示例引用]]\n正文')).toEqual(['[[QUOTE:示例引用]]', '正文']);
    expect(bubbles('[[QUOTE: 示例引用]]正文')).toEqual(['[[QUOTE: 示例引用]]正文']);
  });

  it('<语音> 原子块仍整体保留', () => {
    const voice = '<语音>こんにちは。\n\nお元気ですか。</语音>';
    expect(bubbles(`${voice}\n后面一句`)).toEqual([voice, '后面一句']);
  });
});

describe('情绪 / 时间标签泄漏', () => {
  it('行首情绪标签被剥掉，且不会多出只有标签的气泡', () => {
    expect(bubbles('[normal]\n今天天气不错。\n[shy]\n其实我有点紧张。')).toEqual(['今天天气不错。', '其实我有点紧张。']);
    expect(bubbles('[normal] 今天天气不错。\n[Shy] 其实我有点紧张。')).toEqual(['今天天气不错。', '其实我有点紧张。']);
  });

  it('不在行首的同形方括号与普通方括号文本不动', () => {
    expect(bubbles('他说 [shy] 是一种表情标签。')).toEqual(['他说 [shy] 是一种表情标签。']);
    expect(bubbles('[笑] 好的。')).toEqual(['[笑] 好的。']);
  });

  it('行首日期时间标签（含跨行）不会变成独立气泡', () => {
    for (const head of ['[2026年11月18日 周三]', '[2026-11-18]', '[2026-11-18 10:00]', '[2026-11-18\n10:00]']) {
      expect(bubbles(`${head}\n正文一句话。`)).toEqual(['正文一句话。']);
    }
  });
});

describe('正常中文 / 繁体文本不被改写', () => {
  it('正常简体多行文本原样分段，词语内部不被切断', () => {
    const raw = '今天天气不错，我们去公园散步吧。\n其实我有点紧张，但还是想去。';
    expect(bubbles(raw)).toEqual(['今天天气不错，我们去公园散步吧。', '其实我有点紧张，但还是想去。']);
  });

  it('繁体字、日文与 emoji 原样透传（不转简体、不删非中文字符）', () => {
    const raw = '這是繁體字：今天天氣不錯。\nありがとう 😊';
    expect(bubbles(raw)).toEqual(['這是繁體字：今天天氣不錯。', 'ありがとう 😊']);
  });
});

describe('worker 端 sanitizeIntoSegments 与客户端口径一致', () => {
  const texts = (raw: string) => sanitizeIntoSegments(raw).map(s => s.raw);

  it('标签内换行不拆成两条 push：没有任何一段只含半截 [[QUOTE', () => {
    const out = texts('[[QUOTE: 示例\n引用]]\n正文一句话。');
    expect(out.length).toBeGreaterThan(0);
    for (const seg of out) {
      if (seg.includes('[[QUOTE')) expect(seg).toContain(']]');
    }
    expect(out.some(seg => seg.includes('正文一句话。'))).toBe(true);
  });

  it('正常中文分段不变', () => {
    expect(texts('第一句。\n第二句。')).toEqual(['第一句。', '第二句。']);
  });

  it('情绪 / 跨行日期标签不单独成推送，也不进 banner', () => {
    expect(texts('[normal]\n第一句。\n[sh\ny] 第二句。\n[2026-11-\n18]\n第三句。')).toEqual(['第一句。', '第二句。', '第三句。']);
    expect(sanitizeIntoSegments('[shy] 你好').map(s => s.sanitized)).toEqual(['你好']);
  });

  it('折行引用标签的名称：banner 不漏裸标签', () => {
    const seg = sanitizeIntoSegments('[[QUO\nTE: 示例引用]]\n正文一句话。');
    expect(seg.map(s => s.sanitized).join('|')).not.toMatch(/QUO|\[\[/);
    expect(sanitizeForNotification('[[QUO\nTE: 示例引用]]\n正文')).toBe('正文');
  });
});

describe('标签内部被换行拆开（名称 / 数字 / 收尾括号）', () => {
  it('情绪标签词被拆开或括号内折行：整体剥掉，不留碎片气泡', () => {
    expect(bubbles('[sh\ny]\n其实我有点紧张。')).toEqual(['其实我有点紧张。']);
    expect(bubbles('[\nnormal\n] 今天天气不错。')).toEqual(['今天天气不错。']);
    expect(bubbles('[ha\nppy]今天天气不错。\n[an gry]\n别这样。')).toEqual(['今天天气不错。', '别这样。']);
  });

  it('日期标签数字之间折行：整体剥掉', () => {
    expect(bubbles('[2026-11-\n18 10:00]\n正文一句话。')).toEqual(['正文一句话。']);
    expect(bubbles('[2026年\n11月18日]\n正文一句话。')).toEqual(['正文一句话。']);
  });

  it('引用标签名被拆开、收尾 ]] 之间折行：修回单行规范形态', () => {
    expect(bubbles('[[QUO\nTE: 示例引用]]\n正文')).toEqual(['[[QUOTE: 示例引用]]', '正文']);
    expect(bubbles('[[QUOTE: 示例引用]\n]\n正文')).toEqual(['[[QUOTE: 示例引用]]', '正文']);
    expect(bubbles('好\n[[SEND_\nEMOJI: 抱抱]]\n再见')).toEqual(['好', '<emoji:抱抱>', '再见']);
  });

  it('同形但不构成标签的文本不动', () => {
    expect(bubbles('他提到 QUOTE 这个词\n[[乱写的标签]]')).toEqual(['他提到 QUOTE 这个词', '[[乱写的标签]]']);
    expect(bubbles('[shyness]\n正文')).toEqual(['[shyness]', '正文']);
  });
});

describe('成对引号 / 括号被换行撕开：只合并可可靠识别的断裂', () => {
  it('开标点悬空 + 下一行出现唯一闭标点：并回一个气泡', () => {
    expect(bubbles('他说“今天天气\n不错”\n后面一句')).toEqual(['他说“今天天气不错”', '后面一句']);
    expect(bubbles('「我有点\n紧张」')).toEqual(['「我有点紧张」']);
    expect(bubbles('（轻轻靠过来\n小声说话）')).toEqual(['（轻轻靠过来小声说话）']);
  });

  it('正常的一行一泡不受影响', () => {
    expect(bubbles('好的\n我知道了\n晚点见')).toEqual(['好的', '我知道了', '晚点见']);
    expect(bubbles('“你好”\n“再见”')).toEqual(['“你好”', '“再见”']);
    expect(bubbles('“第一段\n第二段\n第三段”')).toEqual(['“第一段', '第二段', '第三段”']);
    expect(bubbles('（笑）\n好的')).toEqual(['（笑）', '好的']);
  });

  it('下一行自己又开了新标点、或合并后过长：不合并', () => {
    expect(bubbles('“开头\n又一句“新的”结尾”')).toEqual(['“开头', '又一句“新的”结尾”']);
    const long = '字'.repeat(70);
    expect(bubbles(`“${long}\n${long}”`)).toEqual([`“${long}`, `${long}”`]);
  });

  it('不吞语音原子块 / 引用标签 / 表情包', () => {
    const voice = '<语音>こんにちは。\n\nお元気ですか。</语音>';
    expect(bubbles(`“悬空\n${voice}\n结束”`)).toEqual(['“悬空', voice, '结束”']);
    expect(bubbles('“悬空\n[[SEND_EMOJI: 抱抱]]\n结束”')).toEqual(['“悬空', '<emoji:抱抱>', '结束”']);
  });

  it('worker 端分段口径一致', () => {
    expect(sanitizeIntoSegments('他说“今天天气\n不错”\n后面一句').map(s => s.raw)).toEqual(['他说“今天天气不错”', '后面一句']);
  });
});

// 最终落库内容（真实 DB）。
const makeCtx = (charId: string, contextMsgs: any[] = [], emojis: any[] = []): PostProcessCtx => {
  const xhsCaches: XhsCaches = {
    xsecTokenCache: new Map(),
    noteTitleCache: new Map(),
    commentUserIdCache: new Map(),
    commentAuthorNameCache: new Map(),
    commentParentIdCache: new Map(),
  };
  return {
    char: { id: charId, name: '测试角色' } as any,
    userProfile: { name: '我' } as any,
    emojis,
    contextMsgs,
    fullMessages: [],
    initialData: {},
    historyMsgCount: 0,
    xhsCaches,
    api: {
      baseUrl: 'http://localhost:0',
      headers: {},
      effectiveApi: { baseUrl: 'http://localhost:0', apiKey: '', model: 'test' },
    },
    hooks: { setMessages: vi.fn(), addToast: vi.fn() },
  };
};

describe('最终落库内容', () => {
  const quoted = (charId: string) => ({
    id: 201, charId, role: 'user' as const, type: 'text' as const,
    content: '示例引用，后面还有一长串内容', timestamp: Date.now() - 1000,
  });
  const persistedTexts = async (charId: string) =>
    (await DB.getRecentMessagesByCharId(charId, 50)).filter(m => m.role === 'assistant' && m.type === 'text');

  it('带情绪标签 / 日期标签 / 折行引用：落库正文干净，引用仍挂到正文气泡', async () => {
    const charId = `c-tags-${Date.now()}`;
    const raw = '[[QUOTE: 示例\n引用]]\n[normal] 今天天气不错。\n[shy] 其实我有点紧张。\n[2026-11-18 10:00]';
    await applyAssistantPostProcessing(raw, makeCtx(charId, [quoted(charId)]));
    const texts = await persistedTexts(charId);
    expect(texts.map(m => m.content)).toEqual(['今天天气不错。', '其实我有点紧张。']);
    expect(texts[0].replyTo?.id).toBe(201);
    expect(texts[1].replyTo).toBeFalsy();
  }, 20000);

  it('折行的 [[SEND_EMOJI:]] 落成表情消息而不是裸标签文字', async () => {
    const charId = `c-emoji-${Date.now()}`;
    const raw = '[2026-1\n1-23 13:0\n6] 好呀\n[SEND_EMO\nJI: 求抱抱]\n见面时间 [2026-11-23 13:06]。\n[[SEND_EMOJI: 残缺';
    await applyAssistantPostProcessing(raw, makeCtx(charId, [], [{ name: '求抱抱', url: 'blob:emoji-hug' }]));
    const msgs = await DB.getRecentMessagesByCharId(charId, 50);
    expect(msgs.some(m => m.type === 'emoji')).toBe(true);
    expect(msgs.filter(m => m.type === 'text').map(m => m.content)).toEqual(['好呀', '见面时间 [2026-11-23 13:06]。']);
  }, 20000);

  it('繁体文本原样落库', async () => {
    const charId = `c-trad-${Date.now()}`;
    await applyAssistantPostProcessing('這是繁體字：今天天氣不錯。', makeCtx(charId));
    expect((await persistedTexts(charId)).map(m => m.content)).toEqual(['這是繁體字：今天天氣不錯。']);
  }, 20000);
});

// 逐层对照：上游原文 → SSE 重组 → 清洗 → 分段 → 落库。每一层都不能凭空制造繁体 / 乱码。
describe('逐层对照（繁体 / 乱码来源）', () => {
  const RAW = '[normal] 這是繁體字：今天天氣不錯。\n[shy] 其實我有點緊張。';
  const enc = new TextEncoder();
  const sseOf = (text: string, size: number) => {
    const payload = Array.from(text).map(c => `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: c }] } }] })}\n\n`).join('');
    const raw = enc.encode(payload);
    return new ReadableStream<Uint8Array>({
      start(ctrl) { for (let i = 0; i < raw.length; i += size) ctrl.enqueue(raw.slice(i, i + size)); ctrl.close(); },
    });
  };
  const reassemble = async (text: string, size: number): Promise<string> => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => new Response(sseOf(text, size), { headers: { 'content-type': 'text/event-stream' } }));
    const data = await completeChat(
      { baseUrl: 'https://relay.example/v1beta', apiKey: 'sk-test', model: 'gemini-test', apiFormat: 'gemini-native' },
      { messages: [{ role: 'user', content: 'hi' }] },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    return data.choices[0].message.content;
  };

  it('繁体：重组 → 清洗 → 分段 → 落库逐层保持原字（只剥标签，不转简体）', async () => {
    const reassembled = await reassemble(RAW, 3);
    expect(reassembled).toBe(RAW);
    const cleaned = ChatParser.sanitize(reassembled, { keepCitations: true });
    expect(cleaned).toBe('這是繁體字：今天天氣不錯。\n其實我有點緊張。');
    const charId = `c-layers-${Date.now()}`;
    await applyAssistantPostProcessing(reassembled, makeCtx(charId));
    const rows = (await DB.getRecentMessagesByCharId(charId, 50)).filter(m => m.role === 'assistant' && m.type === 'text');
    expect(rows.map(m => m.content)).toEqual(['這是繁體字：今天天氣不錯。', '其實我有點緊張。']);
  }, 20000);

  it('上游本身带 U+FFFD：原样传到落库，本地不新增也不隐藏', async () => {
    const withBad = '前面\uFFFD后面。';
    expect(await reassemble(withBad, 4)).toBe(withBad);
    const clean = await reassemble('前面后面。', 1);
    expect(clean).not.toContain('\uFFFD');
  });

  it('上游把一个汉字的 UTF-8 字节在事件边界外截断：只会产生 U+FFFD，不会变成别的字', async () => {
    const bytes = enc.encode('好');
    const broken = new ReadableStream<Uint8Array>({
      start(ctrl) {
        const head = enc.encode('data: {"candidates":[{"content":{"role":"model","parts":[{"text":"');
        const tail = enc.encode('"}]}}]}\n\n');
        ctrl.enqueue(new Uint8Array([...head, ...bytes.slice(0, 2)]));
        ctrl.enqueue(new Uint8Array([...tail]));
        ctrl.close();
      },
    });
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => new Response(broken, { headers: { 'content-type': 'text/event-stream' } }));
    const data = await completeChat(
      { baseUrl: 'https://relay.example/v1beta', apiKey: 'sk-test', model: 'gemini-test', apiFormat: 'gemini-native' },
      { messages: [{ role: 'user', content: 'hi' }] },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(data.choices[0].message.content).toMatch(/^\uFFFD+$/);
  });
});
