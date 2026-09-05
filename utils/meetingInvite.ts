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
    /** 见面当下的情境种子（进入见面后的场景起点）。 */
    sceneSeed: string;
    /** 邀请前与见面直接相关的聊天背景摘要。 */
    contextSummary?: string;
}

/** 聊天卡上持久化的完整邀请（metadata.meet）。 */
export interface MeetingInvitation {
    id: string;
    status: MeetingInviteStatus;
    initiatorId: string;
    initiatorName: string;
    initiatorAvatar?: string;
    participantIds: string[];
    participantNames: string[];
    invitationText: string;
    locationText?: string;
    timeText?: string;
    sceneSeed: string;
    contextSummary?: string;
    /** 来源聊天角色（恢复 / 回跳用）。 */
    sourceCharId: string;
    createdAt: number;
}

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
    return {
        initiatorName: initiatorName.slice(0, 60),
        participantNames: participants.length > 0 ? participants : [initiatorName.slice(0, 60)],
        invitationText: invitationText.slice(0, MAX_TEXT),
        locationText: typeof o.locationText === 'string' && o.locationText.trim() ? o.locationText.trim().slice(0, MAX_LOCATION) : undefined,
        timeText: typeof o.timeText === 'string' && o.timeText.trim() ? o.timeText.trim().slice(0, MAX_TIME) : undefined,
        sceneSeed: seed,
        contextSummary: summary,
    };
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

/** 卡片按钮 → 状态回写（只改 metadata.meet.status，不动消息本体）。 */
export async function updateMeetInviteStatus(messageId: number, status: MeetingInviteStatus): Promise<void> {
    await DB.updateMessageMetadata(messageId, prev => ({
        ...(prev || {}),
        meet: { ...(prev?.meet || {}), status },
    }));
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
 *  - 一条回复最多一个邀请；纯聊天不硬凑。
 */
export function buildMeetInviteGuide(): string {
    return `   - **发起见面邀请**: 当你根据当前情境**真心想和对方见面**（约会、陪伴、办事、剧情事件、传话转达他人的邀约、多人聚会等任何"见面"语义，不限于恋爱约会），可以在正常说话之外，**单独一行**输出**恰好一次**: \`[[MEET_INVITE: {"initiatorName":"发起者名字(自己就写你的名字)","participantNames":["真正到场见面的角色名","可以多个"],"invitationText":"一句你自己的邀请原话，用你的语气","locationText":"地点(可省)","timeText":"时间(可省)","sceneSeed":"如果你见到对方，此刻的场景起点(你在哪/在做什么/周围环境)","contextSummary":"这次见面直接相关的最近聊天背景(可省)"}]]\`。要点：invitationText 必须是你本人的口吻（例如简短的"下来，我在楼下。"或郑重的邀请都行），不要写"XX邀请你见面"这类系统腔；替别人传话时 initiatorName 写传话人、participantNames 写真正会到场的人；多人见面 participantNames 写多个名字。输出邀请后**只把它当作"你提出了请求"**：不要接着描写对方已经答应、已经动身、已经到你面前——是否赴约完全由对方决定，你可以在后续回复里等待或自然催促，但绝不代替对方行动。没有真实见面动机时不要使用。`;
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
