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
 * 本阶段只覆盖「玩家明确要求」；角色随机主动发图 / 礼物 App / 外卖不在范围内，
 * 但 key/claim 机制不阻碍后续扩展。
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
}

/** 容全角冒号（中文输入法高频变体，与 SEND_EMOJI 同一理由） */
const SEND_PHOTO_TAG_RE = /\[\[SEND_PHOTO[:：]\s*([\s\S]*?)\]\]/g;

const MAX_PROMPT_LENGTH = 1200;
const MAX_CAPTION_LENGTH = 200;
const MAX_STYLE_LENGTH = 400;

function parsePayload(raw: string): ChatPhotoIntent | null {
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
    return { intent, cleanedContent, invalidTagFound: tagCount > 0 && !intent };
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

/** 注入 system prompt「可用动作」一节的拍照指南（单行，保持与既有条目同构）。 */
export function buildChatPhotoTagGuide(): string {
    return `   - **拍照给对方看（真实照片）**: 只有当对方**明确要求**你拍照/自拍/发照片/拍环境/拍某样东西给你看时才使用。先用一两句符合语境的话回应，再在**单独一行**输出**恰好一次**: \`[[SEND_PHOTO: {"prompt":"画面描述","caption":"随图一句话","includeCharacter":false,"style":"风格"}]]\`。prompt 是你根据最近对话、你的外貌设定、所在地点、时间天气和世界观**凝练出的视觉画面描述**（英文或中文皆可，不要照抄聊天原文、不要塞大段对话）; caption 是随图发给对方的一句话; 照片里应当出现你自己时 includeCharacter 才写 true; style 可省略。一轮回复最多一个 SEND_PHOTO。除非对方明确要求，不要把对方或你自己没提到的人画进照片; 更**严禁**用文字、表情包或"[图片]"字样假装发了照片——没被要求或没有这个能力时就正常聊天。`;
}
