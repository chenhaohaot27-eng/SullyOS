/**
 * phoneOrderGiftAdapter — 淘宝订单 → Gift Event 桥接（Phase 2A，最小接入）。
 *
 * 业务规则（本阶段刻意保守）：
 *  - 角色自购（画材/工具/日用品等）→ 只保留淘宝订单，**不**创建 GiftRecord；
 *  - 订单 title/detail/value 中**明确**表达「买给玩家 / 送玩家」→ 经 giftEventHub
 *    落一条 source:'phone_order' 的 GiftRecord（triggerSource:'autonomous'，
 *    origin 反链到订单记录 id，eventKey = gift:phone_order:{charId}:{orderId}）；
 *  - 不确定 → 一律**不**生成礼物（不猜、不做复杂推断）。
 *
 * 失败语义：本模块**永不 throw**——任何内部异常（含 recordGiftEvent 落库失败）都
 * 归一成 { bridged:false, reason:'error' } 静默返回，保证淘宝刷新主流程绝不被
 * 礼物桥接拖挂（调用方 CheckPhone 仍另包一层 try/catch，双保险）。
 *
 * Phase 2A 边界：不投影聊天卡、不提交记忆、不改 Gift App UI、不接剧情/见面。
 */

import type { PhoneEvidence } from '../types';
import { recordGiftEvent } from './giftEventHub';
import type { GiftRecord } from './giftTypes';

/**
 * 「明确送玩家」判定词表（保守白名单，只认显式表达）。
 * 命中任一即视为 gift intent；匹配文本 = title + detail + value 拼接。
 */
const PHONE_ORDER_GIFT_INTENT_PATTERNS: readonly RegExp[] = [
    /买给[你妳]/,                      // 买给你的…
    /送[给]?[你妳]/,                   // 送你 / 送给你
    /给[你妳]的.*礼物/,                // 给你的礼物 / 给你的生日礼物
    /给[你妳]的生日/,                   // 给你的生日…
    /看到.{0,12}想[到起][你妳]/,        // 看到这个想到你
    /为[你妳](挑|选|买|订)/,            // 为你挑的…
    /专门给[你妳]/,                     // 专门给你买的
];

export interface PhoneOrderGiftIntentCheck {
    /** true = 订单明确表达送给玩家，可桥接成礼物。 */
    intent: boolean;
    /** 命中的第一条规则（调试/日志用；未命中为 undefined）。 */
    matchedPattern?: string;
}

/** 纯函数：判断一条订单是否「明确送玩家」。导出供单测钉住词表行为。 */
export function detectPhoneOrderGiftIntent(record: Pick<PhoneEvidence, 'title' | 'detail' | 'value'>): PhoneOrderGiftIntentCheck {
    const text = [record?.title, record?.detail, record?.value]
        .filter((part): part is string => typeof part === 'string')
        .join(' ');
    for (const pattern of PHONE_ORDER_GIFT_INTENT_PATTERNS) {
        if (pattern.test(text)) {
            return { intent: true, matchedPattern: String(pattern) };
        }
    }
    return { intent: false };
}

// ─── 输入 / 输出 ──────────────────────────────────────────────────────────────

export interface PhoneOrderGiftBridgeInput {
    /** 已成功保存的淘宝订单记录（type 应为 'order'）。 */
    record: PhoneEvidence;
    /** 订单归属角色。 */
    charId: string;
    /** 角色当前显示名（写入 sender.nameSnapshot）。 */
    charName: string;
    /** 玩家昵称（写入 recipient.nameSnapshot）。 */
    userName?: string;
}

export type PhoneOrderGiftBridgeReason =
    | 'not_order'        // 记录不是淘宝订单
    | 'no_gift_intent'   // 角色自购 / 无法明确判定 → 不生成礼物（正常路径，非错误）
    | 'invalid_input'    // 参数缺失
    | 'error';           // 内部异常（含落库失败），已静默

export interface PhoneOrderGiftBridgeResult {
    /** 是否真的创建了/命中了 GiftRecord。 */
    bridged: boolean;
    reason?: PhoneOrderGiftBridgeReason;
    /** 幂等重放时 created=false 但 bridged=true（返回的是既有礼物）。 */
    created?: boolean;
    record?: GiftRecord;
}

// ─── 公开 API ─────────────────────────────────────────────────────────────────

/**
 * 桥接一条淘宝订单到 Gift Event（幂等：同一订单 id 重放只落一份礼物）。
 * 永不 throw；调用方无需 try/catch 也能安全使用（CheckPhone 仍包了一层，双保险）。
 */
export async function bridgePhoneOrderGift(input: PhoneOrderGiftBridgeInput): Promise<PhoneOrderGiftBridgeResult> {
    try {
        if (!input || typeof input !== 'object') {
            return { bridged: false, reason: 'invalid_input' };
        }
        const { record } = input;
        if (!record || typeof record !== 'object' || !record.id) {
            return { bridged: false, reason: 'invalid_input' };
        }
        if (record.type !== 'order') {
            return { bridged: false, reason: 'not_order' };
        }
        if (!input.charId?.trim() || !input.charName?.trim()) {
            return { bridged: false, reason: 'invalid_input' };
        }

        const check = detectPhoneOrderGiftIntent(record);
        if (!check.intent) {
            // 角色自购或语义不明确：保留订单、不建礼物（Phase 2A 刻意保守）
            return { bridged: false, reason: 'no_gift_intent' };
        }

        const { record: gift, created } = await recordGiftEvent({
            charId: input.charId.trim(),
            sender: { type: 'character', id: input.charId.trim(), name: input.charName.trim() },
            recipient: { type: 'user', name: (input.userName || '').trim() || '你' },
            gift: {
                name: (record.title || '').trim() || '一份礼物',
                description: record.detail,
                note: record.value,
            },
            source: 'phone_order',
            triggerSource: 'autonomous',
            eventKeyRef: record.id,                       // → gift:phone_order:{charId}:{orderId}
            origin: { kind: 'order-record', refId: record.id },
            // opts 缺省：Phase 2A 不投影聊天卡、不提交记忆，只进 Gift App 列表
        });
        return { bridged: true, created, record: gift };
    } catch (e) {
        // 桥接失败绝不阻断淘宝刷新主流程（含 recordGiftEvent 落库 throw 的透传场景）
        console.warn('[PhoneOrderGift] 订单→礼物桥接失败（订单不受影响）:', e instanceof Error ? e.message : e);
        return { bridged: false, reason: 'error' };
    }
}
