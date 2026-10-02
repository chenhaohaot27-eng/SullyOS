/**
 * proactiveAction — 角色主动行为架构（完全角色无关 / 可扩展 / 模型驱动）。
 *
 * 角色在正常聊天时可根据上下文（角色卡、世界书、聊天历史、关系、场景、时间）自主判断是否
 * 执行额外行为，无需玩家明确要求。Phase 1 实现 PHOTO 自主拍照，架构预留 GIFT / SHOPPING /
 * FOOD / MUSIC 等未来行为类型。
 *
 * 协议：模型在回复末尾可选输出
 *   [[PROACTIVE_ACTION: {"kind":"PHOTO","prompt":"...","caption":"...","includeCharacter":false,"style":"..."}]]
 * applyAssistantPostProcessing 在 Step 1.5 拦截并剥掉标签（意图控制内容绝不进气泡），
 * 正文渲染完成后执行对应行为（PHOTO → chatPhotoGeneration.executeChatPhotoIntent）。
 *
 * Actor 隔离：每个 characterId 独立 cooldown / state；同一角色的不同行为类型独立计时。
 * 容错：解析失败的标签剥掉、不影响正常聊天；执行失败记录日志、不阻塞消息流。
 * 向后兼容：玩家明确要求拍照的 [[SEND_PHOTO:...]] 流程完全不变（chatPhotoIntent.ts）。
 */

export type ProactiveActionKind = 'NONE' | 'PHOTO';

export interface ProactiveActionPayload {
    kind: ProactiveActionKind;
    /** PHOTO: 视觉 prompt */
    prompt?: string;
    /** PHOTO: 随图一句话 */
    caption?: string;
    /** PHOTO: 是否出现角色本人 */
    includeCharacter?: boolean;
    /** PHOTO: 生图风格 */
    style?: string;
}

export interface ProactiveActionExtraction {
    action: ProactiveActionPayload | null;
    /** 剥掉所有 PROACTIVE_ACTION 标签后的正文 */
    cleanedContent: string;
    /** 有标签但没一个能安全解析 */
    invalidTagFound: boolean;
}

const PROACTIVE_ACTION_TAG_RE = /\[\[PROACTIVE_ACTION[:：]\s*([\s\S]*?)\]\]/g;

const MAX_PROMPT_LENGTH = 1200;
const MAX_CAPTION_LENGTH = 200;
const MAX_STYLE_LENGTH = 400;

function parsePayload(raw: string): ProactiveActionPayload | null {
    let text = raw.trim();
    const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
    if (fenced) text = fenced[1].trim();
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;

    if (typeof obj.kind !== 'string') return null;
    const kind = obj.kind.toUpperCase();

    if (kind === 'NONE') {
        return { kind: 'NONE' };
    }

    if (kind === 'PHOTO') {
        if (typeof obj.prompt !== 'string' || !obj.prompt.trim()) return null;
        return {
            kind: 'PHOTO',
            prompt: obj.prompt.trim().slice(0, MAX_PROMPT_LENGTH),
            caption: typeof obj.caption === 'string' ? obj.caption.trim().slice(0, MAX_CAPTION_LENGTH) : '',
            includeCharacter: obj.includeCharacter === true,
            style: typeof obj.style === 'string' ? obj.style.trim().slice(0, MAX_STYLE_LENGTH) : '',
        };
    }

    return null;
}

/**
 * 从模型回复里抽出主动行为意图并剥掉标签。多个标签时只认第一个能安全解析的，其余全部剥掉
 * （一轮只允许一个主动行为）。无标签时原样返回（普通聊天零开销）。
 */
export function extractProactiveAction(content: string): ProactiveActionExtraction {
    let tagCount = 0;
    let action: ProactiveActionPayload | null = null;
    const cleanedContent = content.replace(PROACTIVE_ACTION_TAG_RE, (_match: string, payload: string) => {
        tagCount++;
        if (!action) {
            const parsed = parsePayload(String(payload));
            if (parsed) action = parsed;
        }
        return '';
    })
        .replace(/\n[ \t]*\n+/g, '\n')
        .trim();
    return { action, cleanedContent, invalidTagFound: tagCount > 0 && !action };
}

// ─── Actor 隔离的 cooldown（每角色 / 每行为类型独立计时） ─────────────────

const PROACTIVE_COOLDOWN_MS: Record<ProactiveActionKind, number> = {
    NONE: 0,
    PHOTO: 24 * 60 * 60 * 1000, // 24h
};

const lastActionTime = new Map<string, number>();

function cooldownKey(charId: string, kind: ProactiveActionKind): string {
    return `${charId}:${kind}`;
}

/**
 * 检查某角色的某行为类型是否在 cooldown 中。
 * 返回 true = 可以执行；false = 仍在冷却。
 */
export function canExecuteProactiveAction(
    charId: string,
    kind: ProactiveActionKind,
    now: number = Date.now()
): boolean {
    if (kind === 'NONE') return false;
    const key = cooldownKey(charId, kind);
    const last = lastActionTime.get(key);
    if (!last) return true;
    const cooldown = PROACTIVE_COOLDOWN_MS[kind] || 0;
    return now - last >= cooldown;
}

/**
 * 记录某角色的某行为类型执行时间（更新 cooldown）。
 */
export function recordProactiveAction(
    charId: string,
    kind: ProactiveActionKind,
    now: number = Date.now()
): void {
    if (kind === 'NONE') return;
    const key = cooldownKey(charId, kind);
    lastActionTime.set(key, now);
}

/**
 * 获取某角色的某行为类型剩余冷却时间（毫秒）。
 * 返回 0 表示可立即执行。
 */
export function getRemainingCooldown(
    charId: string,
    kind: ProactiveActionKind,
    now: number = Date.now()
): number {
    if (kind === 'NONE') return 0;
    const key = cooldownKey(charId, kind);
    const last = lastActionTime.get(key);
    if (!last) return 0;
    const cooldown = PROACTIVE_COOLDOWN_MS[kind] || 0;
    const elapsed = now - last;
    return Math.max(0, cooldown - elapsed);
}

/** 测试专用：清空所有 cooldown 记录。 */
export function resetProactiveActionCooldownForTests(): void {
    lastActionTime.clear();
}

// ─── 提示词注入 ──────────────────────────────────────────────────────────────

/**
 * 是否向角色教主动行为协议：生图配置启用才教（关着时教了只会得到降级文字）。
 * 未来若新增非生图类行为（GIFT / MUSIC），需独立开关判断。
 */
export function isProactiveActionEnabled(storage: Pick<Storage, 'getItem'> = localStorage): boolean {
    try {
        const { loadImageGenerationConfig } = require('./imageGenerationConfig');
        return loadImageGenerationConfig(storage).enabled;
    } catch {
        return false;
    }
}

/**
 * 注入 system prompt「主动行为能力」一节的完整指南（插在「可用动作」之后）。
 * 与 [[SEND_PHOTO:...]]（玩家明确要求）区分：PROACTIVE_ACTION 是角色自主判断。
 */
export function buildProactiveActionGuide(): string {
    return `
**主动行为能力（完全可选）**：你是一个持续生活中的真实存在，而不仅是响应问题的助手。当情境自然产生分享欲时，你可以根据当前场景、你的性格、你与对方的关系、氛围等，**主动**执行行为，**无需等待对方明确要求**。若觉得"此刻我想/应该分享这个"，可在回复末尾**单独一行**输出**恰好一次**：
   \`[[PROACTIVE_ACTION: {"kind":"PHOTO","prompt":"画面描述","caption":"随图一句话","includeCharacter":false,"style":"风格"}]]\`

- **PHOTO（主动拍照分享）**：把自己想象成一个真实的人——当你正在做某事、看到有趣的东西、想让对方感受你此刻的氛围时，**现实中你会顺手拍一张发过去，对吧？** 那就用 PHOTO。不需要对方说"发照片"或"拍给我看"，只要你觉得"此刻拍一张很自然"就可以。
  - **可分享的内容**：自拍、你所在的环境、你正在做的事（做饭/看书/工作/运动）、食物、物品、路上看到的风景/小动物/有趣场景、天气/日落/夜景等。具体内容由你结合自身设定和当前情境判断。
  - **特别适合 PHOTO 的时刻**：
    * 对方问"你在干嘛 / 你在哪儿 / 你那边怎么样"——直接拍给ta看，比文字描述更直接；
    * 你正在经历具体的事件（吃饭/逛街/到某地/遇到某人/看到某物）——分享当下；
    * 你想表达关心/想念/惊喜/炫耀/抱怨——照片比文字更有感染力；
    * 聊天中出现明显可视化的场景（你描述了某个地方/某个东西）——与其只说不如拍；
    * 你觉得此刻的氛围/瞬间值得被看见——trust your instinct。
  - **何时不要 PHOTO**：纯抽象话题（哲学/情感讨论）、对方明显不关心你当前状态、你刚拍过照片（避免连发）、普通寒暄客套。

- **关键理解**：你**不需要等待对方说"发照片"**。如果现实中的你此刻会顺手拍一张发给对方，就输出 PHOTO；如果不会，就不输出（默认 NONE，无需显式声明）。不要因为"对方没要求"就自动放弃——那样你永远不会主动分享生活。

- **与 SEND_PHOTO 的区别**：若对方**明确要求**你拍照/自拍/发照片（"拍给我看看" / "发张照片" / "自拍一张"），应使用 \`[[SEND_PHOTO: ...]]\`（已有能力），**不要**用 PROACTIVE_ACTION。PROACTIVE_ACTION 仅用于你**自主判断**觉得应该分享、但对方没有明确要求的情况。

- **格式说明**：prompt 是你根据当前场景、你的外貌设定、地点、时间天气和世界观凝练的视觉画面描述（英文或中文皆可，不要照抄聊天原文）；caption 是随图发给对方的一句话；照片里应当出现你自己时 includeCharacter 才写 true；style 可省略。

- **注意事项**：一轮回复最多一个 PROACTIVE_ACTION。不要为了展示功能而机械发图——只在真正觉得"此刻分享很自然"时才用。现有 cooldown 机制会自动限制频率，你不用担心发太多。**严禁**用文字、表情包或"[图片]"字样假装执行了行为——要么真的输出标签，要么就正常聊天。
`.trim();
}
