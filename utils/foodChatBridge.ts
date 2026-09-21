import type { APIConfig, CharacterProfile, GroupProfile, RealtimeConfig, UserProfile } from '../types';
import { DB } from './db';
import { applyAssistantPostProcessing, type XhsCaches } from './applyAssistantPostProcessing';
import { buildChatRequestPayload } from './chatRequestPayload';
import { completeChat } from './chatCompletionClient';
import { extractChatPhotoIntent } from './chatPhotoIntent';
import { ChatPrompts } from './chatPrompts';
import { resolveCharacterChatApiConfig } from './formalNpcRegistry';
import { extractGiftSendIntent } from './giftIntent';
import {
    claimFoodOrderReaction,
    claimFoodDeliveryEvent,
    getFoodOrder,
    updateFoodOrder,
} from './foodOrderStore';
import { deriveFoodOrderStatus } from './foodOrderTimeline';
import { FOOD_ORDER_STATUS_LABEL, type FoodOrderRecord } from './foodOrderTypes';

export interface FoodOrderCardSnapshot {
    orderId: string;
    phase: 'ordered';
    status: FoodOrderRecord['status'];
    source: FoodOrderRecord['source'];
    ordererType: FoodOrderRecord['orderer']['type'];
    ordererName: string;
    recipientType: FoodOrderRecord['recipient']['type'];
    recipientName: string;
    merchantName?: string;
    items: Array<{ name: string; quantity: number; note?: string }>;
    total?: number;
    representativeImageRef?: string;
}

const cardSnapshot = (order: FoodOrderRecord): FoodOrderCardSnapshot => ({
    orderId: order.id,
    phase: 'ordered',
    status: order.status,
    source: order.source,
    ordererType: order.orderer.type,
    ordererName: order.orderer.nameSnapshot,
    recipientType: order.recipient.type,
    recipientName: order.recipient.nameSnapshot,
    merchantName: order.merchantName,
    items: order.items.map(item => ({ name: item.name, quantity: item.quantity, note: item.note })),
    total: order.total,
    representativeImageRef: order.items.find(item => item.imageRef)?.imageRef,
});

const itemSummary = (order: FoodOrderRecord): string =>
    order.items.map(item => `${item.name} ×${item.quantity}${item.note ? `（${item.note}）` : ''}`).join('；');

function findNoActionReply(raw: string): string {
    // 自动外卖回应只允许自然聊天；越界动作在进入通用 post-processing 前统一丢弃。
    const withoutPhoto = extractChatPhotoIntent(raw).cleanedContent;
    return extractGiftSendIntent(withoutPhoto).cleanedContent
        .replace(/\[\[[\s\S]*?\]\]/g, '')
        .replace(/\[schedule_message[^\]]*\]/gi, '')
        .trim();
}

async function findOrderCard(order: FoodOrderRecord) {
    const messages = await DB.getMessagesByCharId(order.charId, true);
    return messages.find(message => message.type === 'food_order_card'
        && message.metadata?.foodOrder?.orderId === order.id
        && message.metadata?.foodOrder?.phase === 'ordered') || null;
}

export async function projectFoodOrderToChat(order: FoodOrderRecord): Promise<{ cardMessageId: string; created: boolean }> {
    if (order.chat?.orderCardMessageId) {
        const id = Number(order.chat.orderCardMessageId);
        const existing = Number.isFinite(id)
            ? (await DB.getMessagesByCharId(order.charId, true)).find(message => message.id === id)
            : null;
        if (existing) return { cardMessageId: order.chat.orderCardMessageId, created: false };
    }
    const existing = await findOrderCard(order);
    if (existing) {
        const cardMessageId = String(existing.id);
        await updateFoodOrder(order.id, { chat: { ...(order.chat || {}), orderCardMessageId: cardMessageId } });
        return { cardMessageId, created: false };
    }
    const messageId = await DB.saveMessage({
        charId: order.charId,
        role: order.orderer.type === 'character' ? 'assistant' : 'user',
        type: 'food_order_card',
        content: '',
        metadata: { foodOrder: cardSnapshot(order) },
    });
    const cardMessageId = String(messageId);
    const latest = await getFoodOrder(order.id);
    await updateFoodOrder(order.id, { chat: { ...(latest?.chat || order.chat || {}), orderCardMessageId: cardMessageId } });
    return { cardMessageId, created: true };
}

export async function materializeFoodOrderStatus(orderId: string, now = Date.now()): Promise<FoodOrderRecord | null> {
    const order = await getFoodOrder(orderId);
    if (!order) return null;
    const status = deriveFoodOrderStatus(order, now);
    if (status === order.status && (status !== 'delivered' || order.timeline.deliveredAt !== undefined)) return order;
    const updated = await updateFoodOrder(order.id, {
        status,
        timeline: status === 'delivered'
            ? { ...order.timeline, deliveredAt: order.timeline.deliveredAt ?? order.timeline.estimatedDeliveredAt }
            : order.timeline,
    });
    const cardId = Number(updated?.chat?.orderCardMessageId);
    if (updated && Number.isFinite(cardId)) {
        await DB.updateMessageMetadata(cardId, previous => ({
            ...(previous || {}),
            foodOrder: { ...(previous?.foodOrder || {}), status },
        })).catch(() => {});
    }
    return updated;
}

async function projectDeliveryEvent(order: FoodOrderRecord): Promise<{ messageId: string; created: boolean }> {
    const messages = await DB.getMessagesByCharId(order.charId, true);
    if (order.chat?.deliveryEventMessageId) {
        const existing = messages.find(message => String(message.id) === order.chat?.deliveryEventMessageId);
        if (existing) return { messageId: order.chat.deliveryEventMessageId, created: false };
    }
    const existing = messages.find(message => message.metadata?.foodOrder?.orderId === order.id
        && message.metadata?.foodOrder?.phase === 'delivered');
    if (existing) {
        const messageId = String(existing.id);
        await updateFoodOrder(order.id, { chat: { ...(order.chat || {}), deliveryEventMessageId: messageId } });
        return { messageId, created: false };
    }
    if (!(await claimFoodDeliveryEvent(order.id))) return { messageId: '', created: false };
    const messageId = String(await DB.saveMessage({
        charId: order.charId,
        role: 'system',
        type: 'text',
        content: `[外卖送达] ${order.merchantName || '外卖'}：${itemSummary(order)}`,
        metadata: {
            source: 'food_order',
            foodOrder: { orderId: order.id, phase: 'delivered', merchantName: order.merchantName, items: order.items.map(item => ({ name: item.name, quantity: item.quantity })) },
        },
    }));
    const latest = await getFoodOrder(order.id);
    await updateFoodOrder(order.id, { chat: { ...(latest?.chat || order.chat || {}), deliveryEventMessageId: messageId } });
    return { messageId, created: true };
}

export interface FoodReactionDeps {
    char: CharacterProfile;
    userProfile: UserProfile;
    groups: GroupProfile[];
    apiConfig: APIConfig;
    realtimeConfig?: RealtimeConfig;
    addToast?: (message: string, type: 'info' | 'success' | 'error') => void;
}

export interface FoodReactionResult {
    ok: boolean;
    reason?: string;
    messageIds?: string[];
}

function reactionInstruction(order: FoodOrderRecord, phase: 'ordered' | 'delivered', userName: string): string {
    const fact = phase === 'ordered'
        ? `[外卖订单·已下单]\n${userName || '用户'}已经在 Lemuria 中为你下了一份真实存在于系统内的外卖订单，这不是假设。`
        : `[外卖订单·已送达]\n${userName || '用户'}之前为你下的外卖现在已经送达。`;
    return `${fact}\n收餐人：${order.recipient.nameSnapshot}\n商家：${order.merchantName || '未记录'}\n商品：${itemSummary(order)}\n状态：${FOOD_ORDER_STATUS_LABEL[phase === 'ordered' ? order.status : 'delivered']}\n请结合你的人设、饮食偏好、关系和当前语境自然回应。可以喜欢、一般、吐槽、提醒或拒绝某种口味，不要被强制表现得感动。只输出自然聊天正文，不输出任何 [[ACTION]]、SEND_PHOTO、GIFT_SEND 或其他结构化动作。`;
}

/** 批次摘要（多商家一次结算 → 单条聚合指令文案）。 */
export function batchReactionSummary(orders: FoodOrderRecord[], userName: string): string {
    const merchantCount = new Set(orders.map(order => (order.merchantName || '').trim().toLowerCase()).filter(Boolean)).size;
    const lines = orders.map(order => `· ${order.merchantName || '未记录商家'}：${itemSummary(order)}${order.total !== undefined ? `（¥${order.total}）` : ''}`).join('\n');
    return `[外卖订单·已下单]\n${userName || '用户'}一次为你下了 ${orders.length} 份外卖订单，来自 ${merchantCount} 家店，这些都已真实存在于系统内，不是假设：\n${lines}\n收餐人：${orders[0]?.recipient.nameSnapshot || '角色'}\n请结合你的人设、饮食偏好、关系和当前语境，把这批订单当作一件事自然回应（可以逐店点评、也可以整体表态）。只输出自然聊天正文，不输出任何 [[ACTION]]、SEND_PHOTO、GIFT_SEND 或其他结构化动作。`;
}

/** 单订单回应（兼容旧入口）。 */
export async function triggerFoodOrderReaction(
    orderId: string,
    phase: 'ordered' | 'delivered',
    deps: FoodReactionDeps,
): Promise<FoodReactionResult> {
    return triggerFoodOrderReactions([orderId], phase, deps);
}

/**
 * 批量回应（Hotfix Phase1）：认领批内全部订单的本阶段槽位，但只发起一次
 * 聚合 completion（多商家 = 「一次为你下了 N 份订单、来自 M 家店」）。
 * delivered 阶段同样支持（当前只按单订单调用，行为不变）。
 */
export async function triggerFoodOrderReactions(
    orderIds: string[],
    phase: 'ordered' | 'delivered',
    deps: FoodReactionDeps,
): Promise<FoodReactionResult> {
    const fail = (reason: string): FoodReactionResult => ({ ok: false, reason });
    try {
        if (orderIds.length === 0) return fail('no_orders');
        const orders: FoodOrderRecord[] = [];
        for (const orderId of orderIds) {
            const order = await getFoodOrder(orderId);
            if (!order) return fail('order_not_found');
            if (order.charId !== deps.char.id) return fail('char_mismatch');
            if (phase === 'delivered' && deriveFoodOrderStatus(order) !== 'delivered') return fail('not_delivered');
            if (order.status === 'cancelled' || order.status === 'failed') return fail('terminal_order');
            orders.push(order);
        }
        // 先认领批内全部订单的本阶段槽位——之后任何单订单触发都会 already_attempted，
        // 保证每个 checkout batch 的 placed 回应最多 1 次 Chat 调用。
        for (const order of orders) {
            if (!(await claimFoodOrderReaction(order.id, phase))) return fail('already_attempted');
        }
        const order = orders[0];

        const effectiveApi = resolveCharacterChatApiConfig(deps.apiConfig, deps.char);
        const contextLimit = Math.max(1, deps.char.contextLimit || 500);
        const historyMsgs = await DB.getRecentMessagesByCharId(deps.char.id, contextLimit, true);
        const beforeIds = new Set(historyMsgs.map(message => message.id));
        const { emojis, categories } = ChatPrompts.filterVisibleEmojis(
            await DB.getEmojis(), await DB.getEmojiCategories(), deps.char.id,
        );
        const payload = await buildChatRequestPayload({
            char: deps.char,
            userProfile: deps.userProfile,
            groups: deps.groups,
            emojis,
            categories,
            historyMsgs,
            contextLimit: Math.max(1, historyMsgs.length),
            realtimeConfig: deps.realtimeConfig,
            // 外卖订单使用 Phase 1 已缓存字段，绝不重新识图。
            visionApiConfig: undefined,
            // Hotfix Phase1：外卖回应是特殊 completion，不开高成本自主机会（避免回应里又自主转账/送礼）。
            disableAutonomousOpportunity: true,
        });
        const fullMessages = [
            ...payload.fullMessages,
            { role: 'system', content: phase === 'ordered' && orders.length > 1
                ? batchReactionSummary(orders, deps.userProfile?.name || '')
                : reactionInstruction(order, phase, deps.userProfile?.name || '') },
        ];
        const data = await completeChat(effectiveApi, {
            model: effectiveApi.model,
            messages: fullMessages,
            temperature: effectiveApi.temperature ?? 0.85,
            stream: false,
        }, {
            maxRetries: 0,
            meta: { appName: '消息', charId: deps.char.id, charName: deps.char.name, purpose: phase === 'ordered' ? '外卖下单回应' : '外卖送达回应' },
        });
        const raw = data?.choices?.[0]?.message?.content || '';
        const aiContent = findNoActionReply(raw);
        if (!aiContent.trim()) return fail('empty_reply');

        const xhsCaches: XhsCaches = {
            xsecTokenCache: new Map(), noteTitleCache: new Map(), commentUserIdCache: new Map(),
            commentAuthorNameCache: new Map(), commentParentIdCache: new Map(),
        };
        const baseUrl = (effectiveApi.baseUrl || '').replace(/\/+$/, '');
        await applyAssistantPostProcessing(aiContent, {
            char: deps.char,
            userProfile: deps.userProfile,
            emojis,
            realtimeConfig: deps.realtimeConfig,
            groups: deps.groups,
            contextMsgs: historyMsgs,
            fullMessages,
            initialData: data,
            historyMsgCount: historyMsgs.length,
            xhsCaches,
            api: {
                baseUrl,
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${effectiveApi.apiKey || 'sk-none'}` },
                effectiveApi,
            },
            hooks: { setMessages: () => {}, addToast: deps.addToast || (() => {}) },
            instantRender: true,
        });

        const after = await DB.getMessagesByCharId(order.charId, true);
        const messageIds = after
            .filter(message => message.role === 'assistant' && !beforeIds.has(message.id))
            .map(message => String(message.id));
        // 批内每个订单都挂同一份回应（单订单时与原行为一致）
        for (const item of orders) {
            const latest = await getFoodOrder(item.id);
            const chat = { ...(latest?.chat || {}) };
            if (phase === 'ordered') chat.orderReactionMessageIds = messageIds;
            else chat.deliveryReactionMessageIds = messageIds;
            await updateFoodOrder(item.id, { chat });
        }
        return { ok: true, messageIds };
    } catch (error) {
        console.warn('[Food] 角色外卖回应未完成，订单不受影响:', error instanceof Error ? error.message : error);
        return fail(error instanceof Error ? error.message : 'unknown');
    }
}

export interface HandleFoodDeliveryResult {
    order: FoodOrderRecord | null;
    eventCreated: boolean;
    reactionTriggered: boolean;
}

/** App 打开/可见/分钟刷新时调用；关闭很久后也能直接补落一次送达事件。 */
export async function handleFoodOrderDelivery(
    orderId: string,
    deps: FoodReactionDeps,
    now = Date.now(),
): Promise<HandleFoodDeliveryResult> {
    const materialized = await materializeFoodOrderStatus(orderId, now);
    if (!materialized || materialized.status !== 'delivered') {
        return { order: materialized, eventCreated: false, reactionTriggered: false };
    }
    if (materialized.chat?.deliveryEventSuppressed) {
        return { order: materialized, eventCreated: false, reactionTriggered: false };
    }
    const event = await projectDeliveryEvent(materialized);
    const shouldReact = materialized.orderer.type === 'user' && materialized.recipient.type === 'character';
    const reaction = shouldReact
        ? await triggerFoodOrderReaction(materialized.id, 'delivered', deps)
        : { ok: false };
    return {
        order: await getFoodOrder(materialized.id),
        eventCreated: event.created,
        reactionTriggered: reaction.ok,
    };
}
