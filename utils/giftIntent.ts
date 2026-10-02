/**
 * giftIntent — GIFT_REACT 结构化动作的「意图」协议（Phase 3，纯函数）。
 *
 * 只实现 GIFT_REACT（角色对玩家已送出礼物的结构化评价）；GIFT_SEND（角色主动送礼）
 * 属于后续阶段，本文件刻意不提供。
 *
 * 协议完全复用仓库既有 `[[...]]` 结构化动作词汇表（SEND_PHOTO / ACTION / SEND_EMOJI 同族），
 * 不另建解析器：模型在回复里单独一行输出
 *   [[GIFT_REACT: {"giftId":"gift_xxx","review":"…","disposition":"…","acceptance":"accepted",
 *                   "affinityImpact":"positive","moodImpact":["开心"],"memoryImportance":"meaningful",
 *                   "memorySummary":"…"}]]
 * applyAssistantPostProcessing 在 Step 1.5 附近拦截并剥掉标签（意图控制内容绝不进气泡、
 * 不进历史 prompt），正文渲染后由 utils/giftActions.ts 的 applyGiftReaction 落库。
 *
 * 校验严格（与 chatPhotoIntent 同一风格）：payload 必须是能 JSON.parse 的对象，giftId 必填、
 * acceptance 必须是合法枚举；解析不过整段标签剥掉、意图作废（宁可不评价，也不把 JSON 显示给玩家）。
 * 多个标签只认第一个能安全解析的（一轮只评价一次，防重复）。
 */

import type {
    GiftAcceptance,
    GiftAffinityImpact,
    GiftMemoryImportance,
    GiftRecord,
} from './giftTypes';
import { loadImageGenerationConfig } from './imageGenerationConfig';

export interface GiftReactIntent {
    giftId: string;
    /** 角色对礼物的内部简洁评价（≤500 chars） */
    review: string;
    /** 处理方式自由文本，如「戴上 / 收进抽屉 / 退还」（≤300 chars） */
    disposition: string;
    acceptance: GiftAcceptance;
    /** 语义好感影响（仅记录，绝不数值化） */
    affinityImpact?: GiftAffinityImpact;
    /** 情绪标签（≤4 项，每项短文本） */
    moodImpact?: string[];
    memoryImportance?: GiftMemoryImportance;
    /** 仅 meaningful / highly_meaningful 有实际意义 */
    memorySummary?: string;
}

export interface GiftReactExtraction {
    intent: GiftReactIntent | null;
    /** 剥掉所有 GIFT_REACT 标签后的正文（供下游正常分气泡） */
    cleanedContent: string;
    /** 有标签但没一个能安全解析 */
    invalidTagFound: boolean;
}

/** 容全角冒号（中文输入法高频变体，与 SEND_PHOTO / SEND_EMOJI 同一理由）。 */
const GIFT_REACT_TAG_RE = /\[\[GIFT_REACT[:：]\s*([\s\S]*?)\]\]/g;

const ACCEPTANCE_VALUES: readonly GiftAcceptance[] = ['accepted', 'returned', 'rejected'];
const AFFINITY_VALUES: readonly GiftAffinityImpact[] = ['strong_positive', 'positive', 'neutral', 'negative', 'strong_negative'];
const IMPORTANCE_VALUES: readonly GiftMemoryImportance[] = ['trivial', 'normal', 'meaningful', 'highly_meaningful'];

const MAX_REVIEW = 500;
const MAX_DISPOSITION = 300;
const MAX_MEMORY_SUMMARY = 500;
const MAX_MOOD_ITEMS = 4;
const MAX_MOOD_ITEM = 20;

const oneOf = <T extends string>(list: readonly T[], value: unknown): T | undefined =>
    typeof value === 'string' && (list as readonly string[]).includes(value) ? value as T : undefined;

function parsePayload(raw: string): GiftReactIntent | null {
    let text = raw.trim();
    // 容错：模型爱给 JSON 加 ```json 围栏
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
    if (typeof obj.giftId !== 'string' || !obj.giftId.trim()) return null;
    const acceptance = oneOf(ACCEPTANCE_VALUES, obj.acceptance);
    if (!acceptance) return null; // acceptance 非法 → 整个意图作废
    const mood = Array.isArray(obj.moodImpact)
        ? obj.moodImpact
            .filter((x): x is string => typeof x === 'string' && !!x.trim())
            .map(x => x.trim().slice(0, MAX_MOOD_ITEM))
            .slice(0, MAX_MOOD_ITEMS)
        : undefined;
    return {
        giftId: obj.giftId.trim(),
        review: typeof obj.review === 'string' ? obj.review.trim().slice(0, MAX_REVIEW) : '',
        disposition: typeof obj.disposition === 'string' ? obj.disposition.trim().slice(0, MAX_DISPOSITION) : '',
        acceptance,
        // 非法枚举一律丢弃字段（保留意图），多余字段（如 affinityDelta）整体忽略
        affinityImpact: oneOf(AFFINITY_VALUES, obj.affinityImpact),
        moodImpact: mood && mood.length > 0 ? mood : undefined,
        memoryImportance: oneOf(IMPORTANCE_VALUES, obj.memoryImportance),
        memorySummary: typeof obj.memorySummary === 'string' && obj.memorySummary.trim()
            ? obj.memorySummary.trim().slice(0, MAX_MEMORY_SUMMARY)
            : undefined,
    };
}

/**
 * 从模型回复里抽出 GIFT_REACT 意图并剥掉标签。多个标签时只认第一个能安全解析的，
 * 其余全部剥掉（一轮只评价一次）。无标签时原样返回（普通聊天零开销）。
 */
export function extractGiftReactIntent(content: string): GiftReactExtraction {
    let tagCount = 0;
    let intent: GiftReactIntent | null = null;
    const cleanedContent = content.replace(GIFT_REACT_TAG_RE, (_match: string, payload: string) => {
        tagCount++;
        if (!intent) {
            const parsed = parsePayload(String(payload));
            if (parsed) intent = parsed;
        }
        return '';
    })
        .replace(/\n[ \t]*\n+/g, '\n')
        .trim();
    return { intent, cleanedContent, invalidTagFound: tagCount > 0 && !intent };
}

/** 仅剥标签（不解析）——给只想清理文本的调用方备用。 */
export function stripGiftReactIntent(content: string): string {
    return extractGiftReactIntent(content).cleanedContent;
}

// ─── GIFT_SEND：角色 → 玩家送礼（Phase 4） ────────────────────────────────────

/** 模型在 GIFT_SEND 里唯一被允许决定的字段集合。 */
export interface GiftSendIntent {
    /** 礼物名（必填，≤100 chars） */
    name: string;
    description?: string;
    /** 角色给玩家的留言（≤500 chars） */
    note?: string;
    /** 给独立生图 API 的视觉提示（必填） */
    imagePrompt: string;
    /** 礼物图片中是否允许出现送礼角色本人（true 时生图附带角色参考图） */
    includeCharacter: boolean;
    /** 透传给 generateImage 的 style 提示（≤400 chars） */
    style: string;
}

export interface GiftSendExtraction {
    intent: GiftSendIntent | null;
    cleanedContent: string;
    invalidTagFound: boolean;
}

const GIFT_SEND_TAG_RE = /\[\[GIFT_SEND[:：]\s*([\s\S]*?)\]\]/g;

const MAX_SEND_NAME = 100;
const MAX_SEND_DESC = 500;
const MAX_SEND_NOTE = 500;
// 与 chatPhotoGeneration 的 MAX_PROMPT_LENGTH(1200) 对齐：同一个生图服务的安全上限。
const MAX_SEND_IMAGE_PROMPT = 1200;
const MAX_SEND_STYLE = 400;

function parseGiftSendPayload(raw: string): GiftSendIntent | null {
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
    if (typeof obj.name !== 'string' || !obj.name.trim()) return null;
    if (typeof obj.imagePrompt !== 'string' || !obj.imagePrompt.trim()) return null;
    // includeCharacter 必须是明确布尔（"yes"/1 等不算），防模型含糊导致误附参考图。
    if (obj.includeCharacter !== undefined && typeof obj.includeCharacter !== 'boolean') return null;
    return {
        // 只取白名单字段；id/giftId/eventKey/sender/status/provider/apiKey 等一律忽略。
        name: obj.name.trim().slice(0, MAX_SEND_NAME),
        description: typeof obj.description === 'string' && obj.description.trim()
            ? obj.description.trim().slice(0, MAX_SEND_DESC) : undefined,
        note: typeof obj.note === 'string' && obj.note.trim()
            ? obj.note.trim().slice(0, MAX_SEND_NOTE) : undefined,
        imagePrompt: obj.imagePrompt.trim().slice(0, MAX_SEND_IMAGE_PROMPT),
        includeCharacter: obj.includeCharacter === true,
        style: typeof obj.style === 'string' ? obj.style.trim().slice(0, MAX_SEND_STYLE) : '',
    };
}

/**
 * 从模型回复里抽出 GIFT_SEND 意图并剥掉标签。一条回复只认第一个合法意图
 * （一条回复最多送一份礼物，防重复扣费）；解析失败的标签同样剥掉。
 */
export function extractGiftSendIntent(content: string): GiftSendExtraction {
    let tagCount = 0;
    let intent: GiftSendIntent | null = null;
    const cleanedContent = content.replace(GIFT_SEND_TAG_RE, (_match: string, payload: string) => {
        tagCount++;
        if (!intent) {
            const parsed = parseGiftSendPayload(String(payload));
            if (parsed) intent = parsed;
        }
        return '';
    })
        .replace(/\n[ \t]*\n+/g, '\n')
        .trim();
    return { intent, cleanedContent, invalidTagFound: tagCount > 0 && !intent };
}

/** 稳定指纹：同一逻辑送礼动作（同角色 + 同载荷）→ 同一 eventKey，重放天然去重。 */
export function giftSendIntentKey(charId: string, intent: GiftSendIntent): string {
    let hash = 5381;
    const seed = `${intent.name}\n${intent.imagePrompt}\n${intent.includeCharacter}`;
    for (let i = 0; i < seed.length; i++) hash = ((hash << 5) + hash + seed.charCodeAt(i)) >>> 0;
    return `gift:char:${charId}:send:${hash.toString(36)}`;
}

/** 是否向角色教 GIFT_SEND：独立生图配置启用才教（关着时教了只会得到失败礼物）。 */
export function isGiftSendTagEnabled(storage: Pick<Storage, 'getItem'> = localStorage): boolean {
    try {
        return loadImageGenerationConfig(storage).enabled;
    } catch {
        return false;
    }
}

/** 注入 system prompt「可用动作」一节的 GIFT_SEND 指南（与 SEND_PHOTO 指南同构）。 */
export function buildGiftSendTagGuide(): string {
    return `   - **送给对方一份真实礼物**: 只有当你此刻**真的决定送给对方一份具体的礼物**（实物、纪念物等有明确礼物语义的物件），并希望它成为系统里真实存在的礼物记录时才使用。先用符合语境的话自然表达（比如"给你买了条围巾"），再在**单独一行**输出**恰好一次**: \`[[GIFT_SEND: {"name":"礼物名","description":"一句话描述","note":"随礼附言","imagePrompt":"英文或中文的画面描述，用于生成礼物图片","includeCharacter":false,"style":"风格"}]]\`。imagePrompt 是礼物本身的画面描述（物件特写、摆放、包装等）；只有画面里应当出现你自己（手持礼物递过去、自拍式送礼）时 includeCharacter 才写 true; style 可省略。**区分**：随手自拍/拍环境给对方看用 SEND_PHOTO；只有真正的"送礼"才用 GIFT_SEND。开玩笑、假设、讨论想送什么、"以后送你"、回忆过去送过的东西，都**不要**使用 GIFT_SEND，也不要用文字"[图片]"、假链接或 Markdown 假装送了礼物。送礼应是偶发且符合情境的行为，不要频繁使用。`;
}

// ─── 回应生成用的指令文本 ─────────────────────────────────────────────────────

/**
 * 触发角色回应礼物时，追加在 payload 末尾的 system 指令。
 * 明确「这是已发生事件」、给出礼物紧凑表示（含 visualSummary 或「不可用」规则）、
 * GIFT_REACT 协议、防讨好要求、禁止数值好感。
 */
export function buildGiftReactionInstruction(gift: GiftRecord, opts: { userName: string }): string {
    const name = opts.userName || '用户';
    const lines: string[] = [
        `[系统提示（非${name}发言）: ${name}刚刚真实地送给你一份礼物，事件已存入系统，不是假设。礼物详情：`,
        `礼物名称：${gift.gift.name}`,
    ];
    if (gift.gift.description) lines.push(`描述：${gift.gift.description}`);
    if (gift.gift.note) lines.push(`留言：${gift.gift.note}`);
    if (gift.image.origin !== 'none') {
        const summary = gift.image.visualSummary?.trim();
        lines.push(summary
            ? `图片识别：${summary}`
            : `图片识别：不可用（当前没有可靠的视觉识别结果。只能依据${name}的文字描述判断这份礼物，不要自行编造图片的颜色、品牌、包装文字、材质等视觉细节）`);
    }
    lines.push(`礼物ID：${gift.id}`, ']');
    lines.push(
        '',
        `请根据你的角色设定、个人偏好、你和${name}当前的关系、近期情绪与聊天内容，对这份礼物做出真实自然的回应。不要默认所有礼物都喜欢——你可以喜欢、觉得一般、困惑、不喜欢、拒收或退回，反应要符合你的性格。`,
        `回应分两部分：`,
        `1. 先正常说话（像平时聊天一样，一两句到几句即可，不要提"系统"或"礼物ID"）。`,
        `2. 然后在**单独一行**输出**恰好一次**结构化标签（放在回复最末尾）：`,
        '`[[GIFT_REACT: {"giftId":"<上面的礼物ID>","review":"你对礼物的内部简洁评价","disposition":"你打算怎么处理它，如：戴上/收进抽屉/放在床头/退还/暂时收下","acceptance":"accepted|returned|rejected","affinityImpact":"strong_positive|positive|neutral|negative|strong_negative","moodImpact":["情绪词","最多4个"],"memoryImportance":"trivial|normal|meaningful|highly_meaningful","memorySummary":"若值得长期记住，一句话总结，否则留空"}]]`',
        `注意：`,
        `- 这个标签是给系统记录用的，${name}看不到，不要在正常说话部分复述它；`,
        `- 严禁输出任何数值好感（如 affinityDelta、+3、好感度+5、relationshipScore）——只用 affinityImpact 的枚举；`,
        `- 不要对每份礼物都说"太感动了""我会永远珍藏"，reaction 要真实、有差异；`,
        `- 禁止在此回应用 [[GIFT_SEND]] 之类的"回赠礼物"动作——本轮只回应收到。`,
    );
    return lines.join('\n');
}
