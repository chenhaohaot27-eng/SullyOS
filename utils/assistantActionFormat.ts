/**
 * 修复模型把「机器指令」写成单层方括号 / 历史展示摘要的常见掉格式。
 *
 * 这里故意只认完整、带方括号的高置信度 token：普通正文里的“我给你转 520”之类
 * 不能变成副作用。输出统一回既有 canonical 语法，后续仍由各业务解析器做开关、
 * 金额、方向、去重等校验。
 */

const cleanArg = (value: string): string => value.trim().replace(/[|｜]/g, '／');

const normalizeExerciseSummary = (raw: string): string => {
    const value = raw.trim();
    // 展示摘要把 activity + duration 拼在一起。只在末尾明显像时长时才拆，
    // 否则宁可把整段当活动名，也不凭空猜一个错误时长。
    const match = value.match(/^(.+?)\s+((?:\d+(?:\.\d+)?|半|一|两|三|四|五|六|七|八|九|十)\s*(?:分钟|小时|时|分))$/);
    if (!match) return `[[LIFE:EXERCISE|${cleanArg(value)}]]`;
    return `[[LIFE:EXERCISE|${cleanArg(match[1])}|${cleanArg(match[2])}]]`;
};

/** 幂等：已经是 [[...]] 的规范标签不会再次包裹。 */
export const normalizeAssistantActionFormatting = (raw: string): string => {
    let content = raw || '';

    // 表情：既修单括号机器语法，也修 UI / 通知里的人类可读摘要。
    content = content.replace(
        /(^|[^\[])\[\s*SEND_EMOJI\s*[:：]\s*([^\]\r\n]+?)\s*\](?!\])/gim,
        (_all, prefix: string, name: string) => `${prefix}[[SEND_EMOJI: ${name.trim()}]]`,
    );
    // 人类可读的单括号摘要只有独立成行时才算表情意图，避免误伤自然语言。
    content = content.replace(
        /^[ \t]*\[\s*(?:发送(?:了)?[ \t]*)?(?:表情包|表情)\s*[:：]\s*([^\]\r\n]+?)\s*\][ \t]*$/gm,
        (_all, name: string) => `[[SEND_EMOJI: ${name.trim()}]]`,
    );

    // 自然语言表情包指令（修复「角色发表情包只有文字不发图」的另一半根因）：
    // 模型常不写 [[SEND_EMOJI]]，而是把发送动作写成一句话。只在**独立成行**（可带
    // 括号动作包裹）且能提取出明确表情名时才转成 canonical 标签；名字交给
    // emojiResolver 做安全匹配（匹配不上会被跳过，不会误发）。三类高频形态：
    //   ① 带冒号：发个表情包：委屈 / 来个表情：猫猫
    //   ② 名字在前：给你丢个猫猫表情 / 发个猫猫表情包 / 甩张委屈表情
    //   ③ 用某表情：用那个委屈的表情
    // 行内叙述（如「这个表情包太好笑了」「我给你发个表情包」——后者没有可提取的名字）
    // 一律不动：宁可不发，也不把普通聊天误判成贴图。
    const stickerNameChar = '[^，。！？!?,.;；\\s（）()\\[\\]【】{}"\'“”「」]';
    content = content.replace(
        new RegExp(`^[ \\t（(]*(?:发送|发个|来个|丢个|甩个|扔个|发张|来张|丢张)[ \\t]?(?:表情包|表情|sticker)[ \\t]*[:：][ \\t]*(${stickerNameChar}{1,20})[）)]?[ \\t。！!]*$`, 'gm'),
        (_all, name: string) => `[[SEND_EMOJI: ${name.trim()}]]`,
    );
    content = content.replace(
        new RegExp(`^[ \\t（(]*(?:给你)?(?:发|丢|甩|扔|来)[ \\t]*一?[个张][ \\t]*(${stickerNameChar}{1,12})[ \\t]*的?[ \\t]*(?:表情包|表情|sticker)[）)]?[ \\t。！!]*$`, 'gm'),
        (_all, name: string) => `[[SEND_EMOJI: ${name.trim()}]]`,
    );
    content = content.replace(
        new RegExp(`^[ \\t（(]*用[ \\t]*(?:那个|这个|那|这)?[ \\t]*[个只张]?[ \\t]*(${stickerNameChar}{1,12})[ \\t]*的[ \\t]*(?:表情包|表情|sticker)[）)]?[ \\t。！!]*$`, 'gm'),
        (_all, name: string) => `[[SEND_EMOJI: ${name.trim()}]]`,
    );

    // 转账：只修明确的 ACTION token；口语版 [转账 520] 仍由 transferFormat 的
    // 容错解析器负责，方向和金额安全校验也仍在那里完成。
    content = content.replace(
        /(^|[^\[])\[\s*ACTION\s*[:：]\s*(TRANSFER_(?:ACCEPT|RETURN))\s*\](?!\])/gim,
        (_all, prefix: string, verb: string) => `${prefix}[[ACTION:${verb.toUpperCase()}]]`,
    );
    content = content.replace(
        /(^|[^\[])\[\s*ACTION\s*[:：]\s*TRANSFER\s*([|｜][^\]\r\n]*)\s*\](?!\])/gim,
        (_all, prefix: string, args: string) => `${prefix}[[ACTION:TRANSFER${args.replace(/｜/g, '|')}]]`,
    );
    content = content.replace(
        /(^|[^\[])\[\s*ACTION\s*[:：]\s*TRANSFER\s*[:：]\s*([^\]\r\n]*?)\s*\](?!\])/gim,
        (_all, prefix: string, amount: string) => `${prefix}[[ACTION:TRANSFER:${amount.trim()}]]`,
    );

    // 单括号 LIFE 机器语法。
    content = content.replace(
        /(^|[^\[])\[\s*LIFE\s*[:：]\s*([A-Z_]+)\s*((?:[|｜][^\]\r\n]*)?)\s*\](?!\])/gim,
        (_all, prefix: string, verb: string, args: string) =>
            `${prefix}[[LIFE:${verb.toUpperCase()}${args.replace(/｜/g, '|')}]]`,
    );

    // LIFE 卡片摘要被模型照抄回来时，恢复成机器指令。带“已有记录/已确认”等
    // 状态尾巴的卡片不会命中，避免把历史裁决当成一笔新动作。
    content = content.replace(
        /(^|[^\[])\[\s*生活记录\s*[:：]\s*生理期开始\s*\](?!\])/gm,
        '$1[[LIFE:PERIOD_START]]',
    );
    content = content.replace(
        /(^|[^\[])\[\s*生活记录\s*[:：]\s*生理期结束\s*\](?!\])/gm,
        '$1[[LIFE:PERIOD_END]]',
    );
    content = content.replace(
        /(^|[^\[])\[\s*生活记录\s*[:：]\s*吃药\s*(?:[·・•]|\s)\s*([^\]\r\n]+?)\s*\](?!\])/gm,
        (_all, prefix: string, name: string) => `${prefix}[[LIFE:MED|${cleanArg(name)}]]`,
    );
    content = content.replace(
        /(^|[^\[])\[\s*生活记录\s*[:：]\s*支出\s+([¥￥]?\s*[0-9０-９][0-9０-９.,，]*\s*(?:元|块钱|块|圆)?)\s*(?:[（(]\s*([^\]）)\r\n]+?)\s*[）)])?\s*\](?!\])/gm,
        (_all, prefix: string, amount: string, note?: string) =>
            `${prefix}[[LIFE:EXPENSE|${amount.trim()}${note ? `|${cleanArg(note)}` : ''}]]`,
    );
    content = content.replace(
        /(^|[^\[])\[\s*生活记录\s*[:：]\s*锻炼\s*(?:[·・•]|\s)\s*([^\]\r\n]+?)\s*\](?!\])/gm,
        (_all, prefix: string, summary: string) => `${prefix}${normalizeExerciseSummary(summary)}`,
    );

    return content;
};
