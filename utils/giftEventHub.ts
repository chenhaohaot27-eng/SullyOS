/**
 * giftEventHub — 统一礼物事件入口（Phase 1）。
 *
 * 职责边界（刻意保持薄）：
 *  - 只做三件事：GiftPartyRef → GiftPartySnapshot 解析、eventKey 集中生成、
 *    组装 CreateGiftRecordInput 调 giftStore.createGiftRecord（完整复用其幂等三件套：
 *    快查 / UNIQUE index / 并发兜底）。
 *  - 可选副作用（聊天投影 / 记忆候选提交）仅在新落库（created=true）时编排，全部
 *    动态 import + 静默降级——副作用失败绝不影响礼物本体（与 giftChatBridge /
 *    giftCharacterSend 的既有失败语义一致）。
 *  - 不掺 UI、不调 LLM、不碰 Blob。现有 sendPlayerGift / executeGiftSend 不经本模块
 *    （Phase 2 再渐进收编）；Phase 1 的新来源（如 phone_order 适配器）从这里进。
 *
 * 错误边界（本模块最重要的契约）：
 *  - 参数校验失败 / IndexedDB 落库失败 → throw（编程错误，上层适配器决定 toast 或静默）；
 *  - eventKey 幂等命中 → 返回 { created:false }，不是错误；
 *  - 投影 / 记忆副作用失败 → console.warn 静默降级，礼物本体不受影响。
 */

import { createGiftRecord } from './giftStore';
import type {
    GiftChatLinks,
    GiftEffectData,
    GiftImageData,
    GiftMemoryData,
    GiftOriginRef,
    GiftPartySnapshot,
    GiftReactionData,
    GiftRecord,
    GiftSource,
    GiftStatus,
} from './giftTypes';

/** 与 giftPlayerSend.GIFT_USER_ID 同值的保留玩家 ID（不 import，避免无谓的模块耦合）。 */
const HUB_USER_ID = 'user';

const KNOWN_SOURCES: ReadonlySet<string> = new Set<GiftSource>([
    'gift_app',
    'chat_action',
    'phone_order',
    'meeting',
    'story',
]);

const KNOWN_ORIGIN_KINDS: ReadonlySet<string> = new Set<GiftOriginRef['kind']>([
    'chat',
    'order-record',
    'story-session',
    'date-session',
]);

// ─── 输入类型 ─────────────────────────────────────────────────────────────────

/** 当事人引用（宽松输入）：hub 内解析成 GiftPartySnapshot（含 nameSnapshot 快照）。 */
export interface GiftPartyRef {
    type: 'user' | 'character';
    /** user 缺省用保留 ID 'user'；character 必须显式给 id。 */
    id?: string;
    /** 当前显示名（写入 nameSnapshot，避免之后改名污染历史）。 */
    name: string;
}

export interface GiftEventInput {
    /** 归属角色（与 GiftRecord.charId 同义）。 */
    charId: string;
    sender: GiftPartyRef;
    recipient: GiftPartyRef;
    gift: {
        name: string;
        description?: string;
        note?: string;
    };
    source: GiftSource;
    /** 显式指定 eventKey（重放 / 测试）；优先生于 eventKeyRef。 */
    eventKey?: string;
    /** 稳定引用 id（如订单 recordId / 会话 id）→ 生成 `gift:{source}:{charId}:{ref}`。 */
    eventKeyRef?: string;
    /** 缺省 'autonomous'。 */
    triggerSource?: 'explicit' | 'autonomous';
    /** 来源反链（可选，仅新数据）。 */
    origin?: GiftOriginRef;
    /** 缺省 'delivered'（hub 路径没有生成流程，事件发生即送达）。 */
    status?: GiftStatus;
    /** 缺省 { origin:'none', status:'none' }。 */
    image?: GiftImageData;
    /** 以下四项原样透传给 createGiftRecord。 */
    reaction?: GiftReactionData;
    effects?: GiftEffectData;
    memory?: GiftMemoryData;
    chat?: GiftChatLinks;
}

export interface RecordGiftEventOptions {
    /** 聊天礼物卡投影（复用 giftChatBridge.projectGiftToChat）。缺省关闭。 */
    chatProjection?: { enabled: boolean };
    /** 长期记忆候选提交（复用 giftMemory.commitGiftMemoryCandidate，自带资格判定）。缺省关闭。 */
    memoryCommit?: { enabled: boolean };
    /** 只门控副作用阶段（礼物本体已落库则不回滚）；Phase 1 预留。 */
    signal?: AbortSignal;
}

export interface RecordGiftEventResult {
    record: GiftRecord;
    /** false = eventKey 幂等命中（重放 / 重跑，非错误）。 */
    created: boolean;
}

// ─── 内部工具 ─────────────────────────────────────────────────────────────────

function requireNonEmptyString(label: string, value: unknown): string {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`GiftEvent ${label} is required`);
    }
    return value.trim();
}

/**
 * 集中管理的 eventKey 生成器（纯函数，同输入必同输出）。
 * 统一格式：`gift:{source}:{charId}:{stableRef}`——与现有两条格式
 * （gift:user:… / gift:char:…:send:…）并存，互不影响，无迁移。
 */
export function buildGiftEventKey(source: GiftSource, charId: string, ref: string): string {
    const src = requireNonEmptyString('source', source);
    const cid = requireNonEmptyString('charId', charId);
    const r = requireNonEmptyString('eventKeyRef', ref);
    return `gift:${src}:${cid}:${r}`;
}

function resolveParty(role: 'sender' | 'recipient', party: GiftPartyRef): GiftPartySnapshot {
    if (!party || typeof party !== 'object') {
        throw new Error(`GiftEvent ${role} is required`);
    }
    const nameSnapshot = requireNonEmptyString(`${role}.name`, party.name);
    if (party.type === 'user') {
        return { type: 'user', id: (party.id || '').trim() || HUB_USER_ID, nameSnapshot };
    }
    if (party.type === 'character') {
        return {
            type: 'character',
            id: requireNonEmptyString(`${role}.id`, party.id),
            nameSnapshot,
        };
    }
    throw new Error(`GiftEvent ${role}.type must be 'user' or 'character'`);
}

function resolveOrigin(origin: GiftOriginRef | undefined): GiftOriginRef | undefined {
    if (origin === undefined) return undefined;
    if (!origin || typeof origin !== 'object') {
        throw new Error('GiftEvent origin must be an object when provided');
    }
    if (!KNOWN_ORIGIN_KINDS.has(origin.kind)) {
        throw new Error(`GiftEvent origin.kind is unknown: ${String(origin.kind)}`);
    }
    return { kind: origin.kind, refId: requireNonEmptyString('origin.refId', origin.refId) };
}

// ─── 公开 API ─────────────────────────────────────────────────────────────────

/**
 * 统一礼物事件入口。幂等语义与 createGiftRecord 完全一致：同一 eventKey 的重复调用
 * （顺序或并发）最终只落一条 GiftRecord，重放返回既有记录 + created:false，
 * 且**不**重复执行投影 / 记忆副作用。
 */
export async function recordGiftEvent(
    input: GiftEventInput,
    opts: RecordGiftEventOptions = {},
): Promise<RecordGiftEventResult> {
    if (!input || typeof input !== 'object') {
        throw new Error('GiftEventInput is required');
    }
    const charId = requireNonEmptyString('charId', input.charId);
    if (!input.gift || typeof input.gift !== 'object') {
        throw new Error('GiftEvent gift is required');
    }
    const giftName = requireNonEmptyString('gift.name', input.gift.name);
    const source = requireNonEmptyString('source', input.source);
    if (!KNOWN_SOURCES.has(source)) {
        throw new Error(`GiftEvent source is unknown: ${source}`);
    }

    // eventKey 优先级：显式 eventKey > eventKeyRef 生成。两者都缺 = 编程错误。
    const explicitKey = (input.eventKey || '').trim();
    const eventKey = explicitKey
        || buildGiftEventKey(source as GiftSource, charId, input.eventKeyRef || '');

    const { record, created } = await createGiftRecord({
        eventKey,
        charId,
        sender: resolveParty('sender', input.sender),
        recipient: resolveParty('recipient', input.recipient),
        source: source as GiftSource,
        triggerSource: input.triggerSource === 'explicit' ? 'explicit' : 'autonomous',
        origin: resolveOrigin(input.origin),
        gift: {
            name: giftName,
            description: (input.gift.description || '').trim() || undefined,
            note: (input.gift.note || '').trim() || undefined,
        },
        image: input.image || { origin: 'none', status: 'none' },
        reaction: input.reaction,
        effects: input.effects,
        memory: input.memory,
        chat: input.chat,
        status: input.status || 'delivered',
    });

    if (created) {
        await runSideEffects(record, opts);
    }
    return { record, created };
}

/** 副作用编排：仅新落库时调用；任何失败静默降级，绝不升级为 recordGiftEvent 的错误。 */
async function runSideEffects(record: GiftRecord, opts: RecordGiftEventOptions): Promise<void> {
    if (opts.signal?.aborted) return;

    if (opts.chatProjection?.enabled) {
        try {
            const { projectGiftToChat } = await import('./giftChatBridge');
            await projectGiftToChat(record);
        } catch (e) {
            console.warn(
                '[GiftEventHub] 聊天投影失败（礼物本体不受影响）:',
                e instanceof Error ? e.message : e,
            );
        }
    }

    if (opts.memoryCommit?.enabled) {
        try {
            const { commitGiftMemoryCandidate } = await import('./giftMemory');
            // charName 供记忆摘要兜底文案使用：收礼方是角色才有意义。
            const charName = record.recipient.type === 'character' ? record.recipient.nameSnapshot : '';
            await commitGiftMemoryCandidate(record.id, charName);
        } catch (e) {
            console.warn(
                '[GiftEventHub] 记忆候选提交失败（礼物本体不受影响）:',
                e instanceof Error ? e.message : e,
            );
        }
    }
}

