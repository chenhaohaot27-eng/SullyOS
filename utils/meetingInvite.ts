/**
 * meetingInvite — 角色主动发起「见面邀请」（Meeting Invitation）。
 *
 * 架构（复用既有体系，零新 DB 结构）：
 *  - 触发：复用 `[[...]]` 结构化动作词汇表 —— 模型输出 `[[MEET_INVITE: {...}]]`
 *    （applyAssistantPostProcessing Step 1.x 剥离 / Step 7.x 执行，与 GIFT_SEND 同款编排）。
 *  - 持久化：邀请 = 一条 `type:'meet_card'` 聊天消息，全部数据在 `metadata.meet`；
 *    状态更新走 `DB.updateMessageMetadata` → 刷新/重开不丢，旧消息无该字段完全不受影响。
 *  - 跳转：接受后经本模块的 launch store（镜像 utils/dateLaunch 模式）把上下文带进
 *    DateApp，由玩家在见面页选择「陪伴 / 剧情」。
 *
 * 身份解析：1v1 聊天里 NPC / 其他角色没有全局 ID 注册表，模型只可靠输出**名字**。
 * 因此模型给 initiatorName / participantNames，程序负责解析成 id：
 *   - 名字命中 characters 注册表 → 真实 CharacterProfile.id；
 *   - 未命中（NPC / 已删角色）→ `npc:<slug>` 稳定 id + name/avatar 快照兜底，
 *     卡片渲染永远优先快照，角色删除不会崩。
 *
 * 玩家自主权：模型只输出邀请意图；prompt 指南明确禁止代玩家答应/下楼/见面。
 */

import type { CharacterProfile, Message } from '../types';
import { DB } from './db';
import { findCharacterByIdentityName } from './formalNpcRegistry';

// ─── 类型 ─────────────────────────────────────────────────────────────────────

export type MeetingInviteStatus = 'pending' | 'accepted' | 'deferred' | 'declined' | 'expired' | 'cancelled';

/** 模型输出的意图（白名单字段；模型不得决定 messageId / status / 时间戳）。 */
export interface MeetInviteIntent {
    /** 发起者名字（"自己"可写 self / 我 / 角色名）。 */
    initiatorName: string;
    /** 真正参与见面的角色名列表（可多个；玩家本人不需要写进去）。 */
    participantNames: string[];
    /** 邀请正文 —— 必须是角色自己的语气，前端绝不拼接。 */
    invitationText: string;
    locationText?: string;
    timeText?: string;
    /**
     * immediate = 双方已在可短时间见面的范围内（同城/同楼/已在附近/已抵达）；
     * scheduled = 真心想见但当下无法立刻见（跨城/在途/太晚/要等未来行程），
     * 此时必须给 scheduledAt（可实现的时间）。缺省按「是否带合法 scheduledAt」推断。
     */
    meetingMode?: 'immediate' | 'scheduled';
    /** scheduled 时的预计见面时间（ISO 8601 或 YYYY-MM-DD HH:mm）。 */
    scheduledAt?: string;
    /** 最早现实可到达时间（可选；scheduledAt 不得早于它）。 */
    earliestFeasibleAt?: string;
    /** 见面当下的情境种子（进入见面后的场景起点）。 */
    sceneSeed: string;
    /** 邀请前与见面直接相关的聊天背景摘要。 */
    contextSummary?: string;
}

/** 聊天卡上持久化的完整邀请（metadata.meet）。 */
export interface MeetingInvitation {
    id: string;
    status: MeetingInviteStatus;
    /** 邀请方向：角色→玩家（旧数据缺省，兼容为 character_to_user）或 玩家→角色。 */
    direction?: 'character_to_user' | 'user_to_character';
    initiatorId: string;
    initiatorName: string;
    initiatorAvatar?: string;
    participantIds: string[];
    participantNames: string[];
    invitationText: string;
    locationText?: string;
    timeText?: string;
    meetingMode?: 'immediate' | 'scheduled';
    scheduledAt?: string;
    earliestFeasibleAt?: string;
    sceneSeed: string;
    contextSummary?: string;
    /** 来源聊天角色（恢复 / 回跳用）。 */
    sourceCharId: string;
    createdAt: number;
    resolvedAt?: number;
}

/** 旧邀请无 direction 字段 → 按既有行为解释为角色→玩家。 */
export const meetInviteDirection = (invitation: MeetingInvitation | null | undefined): 'character_to_user' | 'user_to_character' =>
    invitation?.direction === 'user_to_character' ? 'user_to_character' : 'character_to_user';

// ─── 标签解析（严格 JSON，与 giftIntent 同风格） ───────────────────────────────

const MEET_INVITE_TAG_RE = /\[\[MEET_INVITE[:：]\s*([\s\S]*?)\]\]/g;

const MAX_TEXT = 300;
const MAX_LOCATION = 80;
const MAX_TIME = 60;
const MAX_SEED = 600;
const MAX_SUMMARY = 600;
const MAX_PARTICIPANTS = 4;

export interface MeetInviteExtraction {
    intent: MeetInviteIntent | null;
    cleanedContent: string;
    invalidTagFound: boolean;
}

export function extractMeetInviteIntent(content: string): MeetInviteExtraction {
    let tagCount = 0;
    let intent: MeetInviteIntent | null = null;
    const cleanedContent = content.replace(MEET_INVITE_TAG_RE, (_m: string, payload: string) => {
        tagCount++;
        if (!intent) {
            const parsed = parseMeetInvitePayload(String(payload));
            if (parsed) intent = parsed;
        }
        return '';
    })
        .replace(/\n[ \t]*\n+/g, '\n')
        .trim();
    return { intent, cleanedContent, invalidTagFound: tagCount > 0 && !intent };
}

function parseMeetInvitePayload(raw: string): MeetInviteIntent | null {
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
    const o = parsed as Record<string, unknown>;
    const invitationText = typeof o.invitationText === 'string' ? o.invitationText.trim() : '';
    const sceneSeed = typeof o.sceneSeed === 'string' ? o.sceneSeed.trim() : '';
    const initiatorName = typeof o.initiatorName === 'string' ? o.initiatorName.trim() : '';
    if (!invitationText || !sceneSeed || !initiatorName) return null;
    const participants = Array.isArray(o.participantNames)
        ? o.participantNames.filter((n): n is string => typeof n === 'string' && !!n.trim())
            .map(n => n.trim()).slice(0, MAX_PARTICIPANTS)
        : [];
    const seed = sceneSeed.slice(0, MAX_SEED);
    const summary = typeof o.contextSummary === 'string' && o.contextSummary.trim()
        ? o.contextSummary.trim().slice(0, MAX_SUMMARY)
        : undefined;
    // 时间字段：只接受可解析的时间串（ISO 8601 / YYYY-MM-DD HH:mm），坏值直接丢弃不落卡。
    const scheduledAt = parseMeetTimestamp(o.scheduledAt);
    const earliestFeasibleAt = parseMeetTimestamp(o.earliestFeasibleAt);
    const explicitMode = o.meetingMode === 'scheduled' ? 'scheduled' : o.meetingMode === 'immediate' ? 'immediate' : undefined;
    const meetingMode = explicitMode ?? (scheduledAt ? 'scheduled' : 'immediate');
    return {
        initiatorName: initiatorName.slice(0, 60),
        participantNames: participants.length > 0 ? participants : [initiatorName.slice(0, 60)],
        invitationText: invitationText.slice(0, MAX_TEXT),
        locationText: typeof o.locationText === 'string' && o.locationText.trim() ? o.locationText.trim().slice(0, MAX_LOCATION) : undefined,
        timeText: typeof o.timeText === 'string' && o.timeText.trim() ? o.timeText.trim().slice(0, MAX_TIME) : undefined,
        meetingMode,
        ...(meetingMode === 'scheduled' && scheduledAt ? { scheduledAt } : {}),
        ...(earliestFeasibleAt ? { earliestFeasibleAt } : {}),
        sceneSeed: seed,
        contextSummary: summary,
    };
}

// ─── 前端轻量 feasibility：只拦明显错误，不做地理推理 ──────────────────────────

/** 解析模型输出的时间串（ISO 8601 或 YYYY-MM-DD HH:mm[:ss]）；不可解析 → null。 */
export function parseMeetTimestamp(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const text = value.trim();
    if (!text || text.length > 40) return null;
    const normalized = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/.test(text)
        ? text.replace(' ', 'T')
        : text;
    const ms = Date.parse(normalized);
    return Number.isFinite(ms) ? normalized : null;
}

export type MeetTimingCheck =
    | { ok: true }
    | { ok: false; reason: 'scheduled_at_missing' | 'scheduled_at_unparseable' | 'scheduled_at_in_past' | 'scheduled_before_earliest_feasible' };

/**
 * invitation 落卡前的轻量时间校验（spec Phase 1 feasibility guard）：
 *  - scheduled：scheduledAt 必须存在、可解析、晚于当前时间，且不早于 earliestFeasibleAt；
 *  - immediate：通过（跨城等空间拦截依赖 prompt 物理连续性规则与结构化地点状态，
 *    本项目当前没有结构化 city state，前端不做城市距离表）。
 * 校验失败只忽略邀请卡，正文照常显示。
 */
export function validateMeetInviteTiming(intent: MeetInviteIntent, nowMs: number = Date.now()): MeetTimingCheck {
    if (intent.meetingMode !== 'scheduled') return { ok: true };
    if (!intent.scheduledAt) return { ok: false, reason: 'scheduled_at_missing' };
    const at = parseMeetTimestamp(intent.scheduledAt);
    if (!at) return { ok: false, reason: 'scheduled_at_unparseable' };
    const atMs = Date.parse(at);
    if (atMs <= nowMs) return { ok: false, reason: 'scheduled_at_in_past' };
    if (intent.earliestFeasibleAt) {
        const earliest = parseMeetTimestamp(intent.earliestFeasibleAt);
        if (earliest && atMs < Date.parse(earliest)) return { ok: false, reason: 'scheduled_before_earliest_feasible' };
    }
    return { ok: true };
}

/**
 * pending 去重（spec #34）：同一角色会话内已有未回应的见面邀请时，不再落第二张 pending 卡。
 * 返回那条 pending 的 meet_card 消息（没有则 null）。旧消息无 meet 字段自然跳过。
 */
export function findPendingMeetInvitation(messages: Message[]): Message | null {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if ((m.type as string) !== 'meet_card') continue;
        const meet = (m.metadata as any)?.meet;
        if (meet && typeof meet === 'object' && meet.status === 'pending') return m;
    }
    return null;
}

// ─── 身份解析：名字 → id（注册表优先，NPC/已删角色用稳定 slug + 快照） ─────────

const npcSlug = (name: string) => `npc:${name.trim().slice(0, 40)}`;

export interface ResolvedMeetIdentity {
    id: string;
    name: string;
    avatar?: string;
    /** true = 命中 characters 注册表。 */
    registered: boolean;
}

export function resolveMeetIdentity(
    name: string,
    characters: CharacterProfile[],
    selfChar?: CharacterProfile,
): ResolvedMeetIdentity {
    const trimmed = (name || '').trim();
    const isSelfToken = !trimmed || trimmed === 'self' || trimmed === '我' || trimmed === '自己';
    if (isSelfToken && selfChar) {
        return { id: selfChar.id, name: selfChar.name, avatar: selfChar.avatar, registered: true };
    }
    if (selfChar && findCharacterByIdentityName([selfChar], trimmed)) {
        return { id: selfChar.id, name: selfChar.name, avatar: selfChar.avatar, registered: true };
    }
    const hit = findCharacterByIdentityName(characters, trimmed);
    if (hit) return { id: hit.id, name: hit.name, avatar: hit.avatar, registered: true };
    const fallbackName = isSelfToken && selfChar ? selfChar.name : (trimmed || '未知角色');
    return { id: selfChar && isSelfToken ? selfChar.id : npcSlug(fallbackName), name: fallbackName, registered: false };
}

// ─── 执行：意图 → meet_card 消息（一条回复最多一张邀请卡） ─────────────────────

export interface ExecuteMeetInviteArgs {
    intent: MeetInviteIntent;
    char: CharacterProfile;
    /** 可选：外部已持有的角色注册表；缺省时从 DB 读取（不要求调用方传）。 */
    characters?: CharacterProfile[];
    persistMessage: (msg: Parameters<typeof DB.saveMessage>[0]) => Promise<number>;
    inheritMeta?: Record<string, any>;
}

export interface ExecuteMeetInviteResult {
    messageId: number;
    invitation: MeetingInvitation;
}

export async function executeMeetInvite(args: ExecuteMeetInviteArgs): Promise<ExecuteMeetInviteResult> {
    const { intent, char, persistMessage, inheritMeta } = args;
    // 身份注册表：优先调用方传入（未来群聊等场景），否则读 DB 全量角色（数量级小）。
    const characters = args.characters ?? await DB.getAllCharacters();
    const initiator = resolveMeetIdentity(intent.initiatorName, characters, char);
    const participants = intent.participantNames.map(n => resolveMeetIdentity(n, characters, char));

    const invitation: MeetingInvitation = {
        id: `mi_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        status: 'pending',
        initiatorId: initiator.id,
        initiatorName: initiator.name,
        initiatorAvatar: initiator.avatar,
        participantIds: participants.map(p => p.id),
        participantNames: participants.map(p => p.name),
        invitationText: intent.invitationText,
        locationText: intent.locationText,
        timeText: intent.timeText,
        meetingMode: intent.meetingMode,
        ...(intent.meetingMode === 'scheduled' && intent.scheduledAt ? { scheduledAt: intent.scheduledAt } : {}),
        ...(intent.earliestFeasibleAt ? { earliestFeasibleAt: intent.earliestFeasibleAt } : {}),
        sceneSeed: intent.sceneSeed,
        contextSummary: intent.contextSummary,
        sourceCharId: char.id,
        createdAt: Date.now(),
    };

    const messageId = await persistMessage({
        charId: char.id,
        role: 'assistant',
        type: 'meet_card',
        content: '',
        metadata: { ...(inheritMeta || {}), meet: invitation },
    } as Parameters<typeof DB.saveMessage>[0]);
    return { messageId, invitation };
}

/** 卡片按钮 → 状态回写（只改 metadata.meet.status / resolvedAt，不动消息本体）。 */
export async function updateMeetInviteStatus(messageId: number, status: MeetingInviteStatus): Promise<void> {
    await DB.updateMessageMetadata(messageId, prev => ({
        ...(prev || {}),
        meet: { ...(prev?.meet || {}), status, resolvedAt: Date.now() },
    }));
}

// ─── 玩家 → 角色 邀请（双向协议）：不调 API，直接落一条 meet_card ───────────────

export const PLAYER_MEET_INVITE_NOTE_MAX = 200;

/**
 * 玩家在聊天里主动发起见面邀请：复用同一 MeetingInvitation schema（direction =
 * 'user_to_character'），落一条 user 角色的 meet_card 消息，不额外调用模型；
 * 下一轮主聊天由 chatPrompts 把「用户向你发出了见面邀请」注入上下文，由角色自行回应。
 */
export async function createUserMeetInvite(args: {
    char: CharacterProfile;
    userName: string;
    /** 可选附言，≤200 字，原样保存。 */
    note?: string;
    persistMessage: (msg: Parameters<typeof DB.saveMessage>[0]) => Promise<number>;
}): Promise<ExecuteMeetInviteResult> {
    const { char, userName, note, persistMessage } = args;
    const invitation: MeetingInvitation = {
        id: `mi_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        status: 'pending',
        direction: 'user_to_character',
        initiatorId: 'user',
        initiatorName: userName || '你',
        participantIds: [char.id],
        participantNames: [char.name],
        invitationText: (note || '').trim().slice(0, PLAYER_MEET_INVITE_NOTE_MAX),
        sceneSeed: '（玩家主动发起的见面邀请；接受后由见面模式开场自行衔接当前情境。）',
        sourceCharId: char.id,
        createdAt: Date.now(),
    };
    const messageId = await persistMessage({
        charId: char.id,
        role: 'user',
        type: 'meet_card',
        content: '',
        metadata: { meet: invitation },
    } as Parameters<typeof DB.saveMessage>[0]);
    return { messageId, invitation };
}

// ─── 角色回应玩家邀请：[[MEET_REPLY: accepted|declined|deferred]] ───────────────

export type MeetReplyKind = 'accepted' | 'declined' | 'deferred';

const MEET_REPLY_TAG_RE = /\[\[MEET_REPLY[:：]\s*(accepted|declined|deferred)\s*\]\]/gi;

export interface MeetReplyExtraction {
    reply: MeetReplyKind | null;
    cleanedContent: string;
}

export function extractMeetReplyIntent(content: string): MeetReplyExtraction {
    let reply: MeetReplyKind | null = null;
    const cleanedContent = content.replace(MEET_REPLY_TAG_RE, (_m: string, kind: string) => {
        if (!reply) reply = kind as MeetReplyKind;
        return '';
    })
        .replace(/\n[ \t]*\n+/g, '\n')
        .trim();
    return { reply, cleanedContent };
}

/** 最近一条待回应的「玩家→角色」邀请卡（旧数据无 direction → 视为角色邀请，不匹配）。 */
export function findPendingUserMeetInvite(messages: Message[]): Message | null {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if ((m.type as string) !== 'meet_card') continue;
        const meet = (m.metadata as any)?.meet;
        if (meet && typeof meet === 'object' && meet.status === 'pending' && meet.direction === 'user_to_character') return m;
    }
    return null;
}

/**
 * 应用角色对玩家邀请的回应：accepted / declined / deferred 写回原玩家邀请卡，
 * 正文（角色自己的话）不受影响；找不到待回应的玩家邀请时静默忽略（正文照常）。
 */
export async function applyMeetReply(args: {
    reply: MeetReplyKind;
    messages: Message[];
}): Promise<{ messageId: number; invitation: MeetingInvitation } | null> {
    const target = findPendingUserMeetInvite(args.messages);
    if (!target) return null;
    const invitation = readMeetInvitation(target);
    if (!invitation) return null;
    const nextStatus: MeetingInviteStatus = args.reply === 'deferred' ? 'deferred' : args.reply;
    await updateMeetInviteStatus(target.id, nextStatus);
    return { messageId: target.id, invitation: { ...invitation, status: nextStatus } };
}

/** 从消息恢复邀请（旧消息无字段 → null，卡片分支不渲染，天然兼容）。 */
export function readMeetInvitation(m: Message): MeetingInvitation | null {
    const meet = (m.metadata as any)?.meet;
    return meet && typeof meet === 'object' && typeof meet.id === 'string' ? meet as MeetingInvitation : null;
}

// ─── 接受邀请 → 跳转见面：携带上下文的 launch store（镜像 dateLaunch） ─────────

export interface MeetingLaunchIntent {
    invitation: MeetingInvitation;
    /** 见面主角色（participants 中第一个命中注册表的角色；兜底来源聊天角色）。 */
    primaryCharId: string;
    /** 展示用：参与者名字列表。 */
    participantsText: string;
    /**
     * 直接指定赴约方式（双向协议）：带值时 DateApp 不再弹「陪伴/剧情」选择层，
     * 直接走对应链路；角色→玩家的旧流程不带值，仍弹选择层。
     */
    surface?: 'companion' | 'story';
}

const MEETING_LAUNCH_EVENT = 'sullyos:meeting-launch';
let pendingLaunch: MeetingLaunchIntent | null = null;

// ─── Prompt 指南（注入 chatPrompts「可用动作」一节） ───────────────────────────

/**
 * 教模型何时 / 如何发起见面邀请。要点：
 *  - 邀请正文必须是角色自己的语气（invitationText），不要套模板；
 *  - 支持"自己约" / "替别人传话" / "多人场合"（participantNames）；
 *  - 玩家自主权：发出邀请后**不得**叙述玩家已答应/已动身/已见面，
 *    等玩家在邀请卡上点「去见TA」才真正进入见面；
 *  - 一条回复最多一个邀请；纯聊天不硬凑；
 *  - 物理连续性：邀请必须符合双方当前的时间线与所在地——角色不能瞬移，
 *    "想见"不等于"现在能见"；跨城/在途/太晚只能约未来时间（scheduled + scheduledAt），
 *    时间要保守可实现（把路程、班次、准备时间算进去）；地点或时间信息不足时
 *    不要发邀请，先自然聊天问清；不编造对方的精确位置；邀请应是低频、真实有行动
 *    意图的主动行为——只是想念、开玩笑、回忆过去或假设性讨论都不发邀请；
 *    玩家刚婉拒过、或上一张邀请还没有回应时，不要再发新邀请。
 */
export function buildMeetInviteGuide(): string {
    return `   - **发起见面邀请**: 当你根据当前情境**真心想和对方见面**（约会、陪伴、办事、剧情事件、传话转达他人的邀约、多人聚会等任何"见面"语义，不限于恋爱约会），可以在正常说话之外，**单独一行**输出**恰好一次**: \`[[MEET_INVITE: {"initiatorName":"发起者名字(自己就写你的名字)","participantNames":["真正到场见面的角色名","可以多个"],"invitationText":"一句你自己的邀请原话，用你的语气","locationText":"地点(可省)","timeText":"时间(可省)","meetingMode":"immediate或scheduled","scheduledAt":"scheduled时的预计见面时间,格式YYYY-MM-DD HH:mm","earliestFeasibleAt":"最早现实能到的时间,同格式(可省)","sceneSeed":"如果你见到对方，此刻的场景起点(你在哪/在做什么/周围环境)","contextSummary":"这次见面直接相关的最近聊天背景(可省)"}]]\`。要点：invitationText 必须是你本人的口吻（例如简短的"下来，我在楼下。"或郑重的邀请都行），不要写"XX邀请你见面"这类系统腔；替别人传话时 initiatorName 写传话人、participantNames 写真正会到场的人；多人见面 participantNames 写多个名字。**meetingMode 判断**：只有当你与对方已经同城、就在附近、已在楼下或在来对方这里的路上等**短时间真能见到**的情况才用 immediate；跨城市、你还在出差/在途/上班、时间太晚、要等飞机高铁、要等到明天或以后，就用 scheduled 并给出**保守、可实现**的 scheduledAt（把赶车、路途、准备时间都算进去，宁可约晚一点），必要时给 earliestFeasibleAt；已知自己未来某天会到对方城市时，可以提前约那天的 scheduled 邀请。**物理连续性**：你无法瞬移——发邀请前先从对话、记忆与当前情境确认双方各自在哪、现在几点；只是想念、开玩笑说"过来啊"、回忆过去见面或假设性聊天**不要**发邀请，可以先自然表达"想见你"，等时间地点聊清楚了再发；不确定对方在哪、或你们明显短时间到不了彼此身边时，不要发 immediate 邀请，先问清楚（例如"你今晚还在上海？"是普通聊天）；绝不编造对方的精确位置；玩家刚婉拒过你的见面邀请、或你发出的邀请还没得到回应时，**不要**再发新邀请。**线上→线下的硬协议**：当你准备把线上聊天真正切换为现实见面——尤其是要表达"等我，我过去""我已经出门了""我到你楼下了""我上电梯了""开门""我进来了"这类**已经动身/已经抵达/即将与对方处于同一物理空间**的内容时，**必须**先输出上面的 MEET_INVITE 邀请，再在正文里说想说的话；只有对方在邀请卡上接受后，实际见面叙事才由见面模式承接。普通地表达"我想见你""今晚有空吗""要不要出来走走"**不需要**也**不应该**调用邀请——只有真正准备发生物理见面时才用它。输出邀请后**只把它当作"你提出了请求"**：不要接着描写对方已经答应、已经动身、已经到你面前——是否赴约完全由对方决定，你可以在后续回复里等待或自然催促，但绝不代替对方行动。没有真实见面动机时不要使用。`;
}

/**
 * 给模型的「玩家邀请回应协议」：注入在历史渲染层（chatPrompts buildMessageHistory 的
 * meet_card 分支），只在存在待回应的玩家→角色邀请时随该条历史出现，短且低 token。
 */
export function buildPlayerInviteReplyGuide(): string {
    return `用户刚刚向你发送了一份真实的见面邀请。你可以根据当前关系、时间安排、双方所在地和你的性格自行决定：接受就单独一行输出 \`[[MEET_REPLY: accepted]]\`；婉拒就输出 \`[[MEET_REPLY: declined]]\`；暂时定不下来想改时间就输出 \`[[MEET_REPLY: deferred]]\` 并在正文里说明。无论哪种都可以正常说话表达你的想法。接受后不要在聊天正文里描写已经见面——实际见面要等用户从邀请卡进入见面模式。`;
}

export const meetingInviteLaunch = {
    request(intent: MeetingLaunchIntent): void {
        pendingLaunch = intent;
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent<MeetingLaunchIntent>(MEETING_LAUNCH_EVENT, { detail: intent }));
        }
    },
    peek(): MeetingLaunchIntent | null {
        return pendingLaunch;
    },
    consume(): MeetingLaunchIntent | null {
        const value = pendingLaunch;
        pendingLaunch = null;
        return value;
    },
    subscribe(listener: (intent: MeetingLaunchIntent) => void): () => void {
        if (typeof window === 'undefined') return () => {};
        const handler = (e: Event) => listener((e as CustomEvent<MeetingLaunchIntent>).detail);
        window.addEventListener(MEETING_LAUNCH_EVENT, handler);
        return () => window.removeEventListener(MEETING_LAUNCH_EVENT, handler);
    },
};
