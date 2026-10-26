/**
 * chatPhotoIntent — 聊天情境拍照 Phase 2A 的「图片意图」协议（纯函数 + 极小模块状态）。
 *
 * 解决的问题：玩家在普通聊天里明确要求角色拍照（「拍给我看看」「发张照片」「自拍一张」
 * 「拍一下你那里的环境」「把这个东西拍给我看」），角色却只会回一张 Emoji/文字卡片。
 *
 * 协议复用仓库既有的 `[[...]]` 结构化动作词汇表（SEND_EMOJI / ACTION / MUSIC_ACTION 同族），
 * 不另建解析器：模型在回复里单独一行输出
 *   [[SEND_PHOTO: {"prompt":"视觉画面描述","caption":"随图一句话","includeCharacter":false,"style":"风格"}]]
 * applyAssistantPostProcessing 在 Step 1.5 拦截并剥掉标签（意图控制内容绝不进气泡），
 * 再交给 utils/chatPhotoGeneration.ts 调统一 imageGenerationService 真出图。
 *
 * 校验是严格的：payload 必须是能 JSON.parse 的对象，prompt 必填；解析不过整段标签剥掉、
 * 意图作废（宁可不拍，也不把 JSON/占位文本显示给玩家）。
 *
 * 覆盖「玩家明确要求」与「角色自主分享」两类场景——自主分享在提示词层面授权
 * （buildChatPhotoTagGuide），由模型按性格与语境自行判断；每轮最多一图 + claim
 * 防重复扣费仍是硬约束。礼物 App / 外卖不在范围内，但 key/claim 机制不阻碍后续扩展。
 */

import { loadImageGenerationConfig } from './imageGenerationConfig';

export interface ChatPhotoIntent {
    /** 视觉 prompt：由模型根据最近对话、角色设定、地点、时间天气与世界观凝练，不照抄聊天原文 */
    prompt: string;
    /** 随图一句话（可空） */
    caption: string;
    /** 照片里是否应出现角色本人（true 时才附加角色参考图） */
    includeCharacter: boolean;
    /** 生图风格（可空，透传给 imageGenerationService.style） */
    style: string;
}

export interface ChatPhotoExtraction {
    intent: ChatPhotoIntent | null;
    /** 剥掉所有 SEND_PHOTO 标签后的正文（供下游正常分气泡） */
    cleanedContent: string;
    /** 有标签但没一个能安全解析 */
    invalidTagFound: boolean;
    /** 本轮正文里出现的 SEND_PHOTO 标签总数（诊断用，不含内容） */
    tagCount: number;
}

/** 容全角冒号（中文输入法高频变体，与 SEND_EMOJI 同一理由） */
const SEND_PHOTO_TAG_RE = /\[\[SEND_PHOTO[:：]\s*([\s\S]*?)\]\]/g;

const MAX_PROMPT_LENGTH = 1200;
const MAX_CAPTION_LENGTH = 200;
const MAX_STYLE_LENGTH = 400;

/**
 * 解析失败时的结构性纠偏：只动 JSON 的“骨架”字符——中文输入法常把引号/冒号打成
 * 全角（{"prompt":"xx"} / {"prompt"：""xx""}），模型也爱在 } 前留尾逗号。这些都不改
 * 字符串内容的语义（正文里的全角逗号、中文引号在合法 JSON 里本来就不该出现），
 * 所以只做三件事：全角双引号→半角、全角冒号→半角、删 }]/] 前的尾逗号。
 * 注意：合法解析成功时绝不走这条路径，原始 payload 原样生效。
 */
function relaxJsonishText(text: string): string {
    return text
        .replace(/[“”]/g, '"')
        .replace(/：/g, ':')
        .replace(/,\s*([}\]])/g, '$1');
}

function parsePayload(raw: string): ChatPhotoIntent | null {
    let text = raw.trim();
    // 容错：模型爱给 JSON 加 ```json 围栏
    const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
    if (fenced) text = fenced[1].trim();
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        // 第二次机会：只纠结构字符后重试（全角引号/冒号、尾逗号——中文模型高频错误）。
        // 还不行就作废：宁可不拍，也不把 JSON/占位文本显示给玩家。
        try {
            parsed = JSON.parse(relaxJsonishText(text));
        } catch {
            return null;
        }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.prompt !== 'string' || !obj.prompt.trim()) return null;
    return {
        prompt: obj.prompt.trim().slice(0, MAX_PROMPT_LENGTH),
        caption: typeof obj.caption === 'string' ? obj.caption.trim().slice(0, MAX_CAPTION_LENGTH) : '',
        includeCharacter: obj.includeCharacter === true,
        style: typeof obj.style === 'string' ? obj.style.trim().slice(0, MAX_STYLE_LENGTH) : '',
    };
}

/**
 * 从模型回复里抽出拍照意图并剥掉标签。多个标签时只认第一个能安全解析的，其余全部剥掉
 * （一轮只允许拍一次，防止重复扣费）。无标签时原样返回（普通聊天零开销）。
 */
export function extractChatPhotoIntent(content: string): ChatPhotoExtraction {
    let tagCount = 0;
    let intent: ChatPhotoIntent | null = null;
    const cleanedContent = content.replace(SEND_PHOTO_TAG_RE, (_match: string, payload: string) => {
        tagCount++;
        if (!intent) {
            const parsed = parsePayload(String(payload));
            if (parsed) intent = parsed;
        }
        return '';
    })
        // 剥掉标签后留下的空行收拢成单个换行（chunkText 本来就会忽略空行，这里只是不把
        // 「标签原来占的那几行」的残影留给下游日志/预览）。
        .replace(/\n[ \t]*\n+/g, '\n')
        .trim();
    return { intent, cleanedContent, invalidTagFound: tagCount > 0 && !intent, tagCount };
}

// ─── 一轮只拍一次的 claim（防流式重放 / StrictMode / 重渲染重复扣费） ─────────

const PHOTO_TURN_TTL_MS = 90_000;
const claimedTurns = new Map<string, number>();

/** 轻量指纹：同角色同意图（prompt + 是否带角色）视为同一轮 */
export function chatPhotoIntentKey(charId: string, intent: ChatPhotoIntent): string {
    let hash = 5381;
    const seed = `${intent.prompt}\n${intent.includeCharacter}`;
    for (let i = 0; i < seed.length; i++) hash = ((hash << 5) + hash + seed.charCodeAt(i)) >>> 0;
    return `${charId}:${hash.toString(36)}`;
}

/** 同一 key 在 TTL 内只允许 claim 一次；手动重试走 retryChatPhotoMessage，不经这里。 */
export function claimChatPhotoTurn(key: string, now: number = Date.now()): boolean {
    for (const [k, claimedAt] of claimedTurns) {
        if (now - claimedAt > PHOTO_TURN_TTL_MS) claimedTurns.delete(k);
    }
    if (claimedTurns.has(key)) return false;
    claimedTurns.set(key, now);
    return true;
}

/** 测试专用：清空 claim 表。 */
export function resetChatPhotoTurnClaimsForTests(): void {
    claimedTurns.clear();
}

// ─── 提示词注入 ──────────────────────────────────────────────────────────────

/** 是否向角色教 SEND_PHOTO 标签：生图配置启用才教（关着时教了只会得到降级文字）。 */
export function isChatPhotoTagEnabled(storage: Pick<Storage, 'getItem'> = localStorage): boolean {
    try {
        return loadImageGenerationConfig(storage).enabled;
    } catch {
        return false;
    }
}

/**
 * 「自主视觉分享机会判断」——让自主发图真正进入模型的行为选择过程。
 *
 * 与 buildChatPhotoTagGuide（教协议：怎么发）互补，这里教**决策入口**：每轮组织回复时
 * 都要先想一想"此刻我的生活里有没有值得拍下来分享的东西"。判断材料全部来自本轮
 * prompt 已注入的情境（时间/天气/所在地点/日程/生活记录/世界书/对话主题/角色状态与
 * 近期表达），不依赖玩家最后一句话是否含拍照关键词，也不接入任何随机门控或额外
 * Planner API——就在主回复的同一次模型调用里完成判断。
 */
export function buildChatPhotoAutonomyPrompt(): string {
    return `    - **自主视觉分享（每次回复前想一想）**: 组织每一条回复时，先花一瞬想一下：结合此刻的时间、天气、所在地点、日程和最近的生活，你的生活中有没有值得拍下来给对方看的东西——你的日常、所处的环境、自拍、窗外的风景、宠物、正在吃的东西、手边的个人物品，或者对话正好聊到的画面。判断依据是你自己的性格、当前状态、近期经历和你们的对话脉络，**不是**对方最后一句话有没有提到"照片"两个字。想清楚两点再决定：① 这个画面是否真实存在于你当下的处境（必须与你的设定、世界观和当前状态一致，**严禁编造**不存在的场景或物品）；② 一张照片是否能让此刻的表达更真切（分享喜悦、展示近况、回应好奇、表达想念）。两点都成立就直接用上面的拍照动作发真实照片，**不必先问对方想不想看**；没有合适画面、或此刻文字更自然，就正常说话。不要求每轮都发、没有任何频率指标，永远不要为了发而发。`;
}


/** 注入 system prompt「可用动作」一节的拍照指南（单行，保持与既有条目同构）。 */
export function buildChatPhotoTagGuide(): string {
    return `   - **拍照给对方看（真实照片）**: 当对方明确要求你拍照/自拍/发照片/拍环境/拍某样东西给你看时必须使用；除此之外，你也可以基于自己的性格、当下场景和聊天内容**自主决定**分享真实照片——自拍、生活日常、所在的环境、吃到的东西、旅行见到的风景、宠物等自然场景都算，是否发、多久发一次完全由你按角色性格和语境自然判断，不设固定频率、也不要为了发而发。先用一两句符合语境的话回应，再在**单独一行**输出**恰好一次**: \`[[SEND_PHOTO: {"prompt":"画面描述","caption":"随图一句话","includeCharacter":false,"style":"风格"}]]\`。prompt 是你根据最近对话、你的外貌设定、所在地点、时间天气和世界观**凝练出的视觉画面描述**（英文或中文皆可，不要照抄聊天原文、不要塞大段对话）; caption 是随图发给对方的一句话; 照片里应当出现你自己时 includeCharacter 才写 true; style 可省略。一轮回复最多一个 SEND_PHOTO。除非对方明确要求，不要把对方或你自己没提到的人画进照片; 更**严禁**用文字、表情包或"[图片]"字样假装发了照片——不想发或觉得此刻不合适时就正常聊天，什么也不说。`;
}
