export type FoodOrderSource = 'catalog_imported' | 'simulated';

export type FoodOrderStatus =
    | 'confirmed'
    | 'preparing'
    | 'picked_up'
    | 'delivering'
    | 'delivered'
    | 'cancelled'
    | 'failed';

export interface FoodOrderParty {
    type: 'user' | 'character';
    id: string;
    nameSnapshot: string;
}

/**
 * 谁为这笔订单付钱（玩家钱包视角）。
 * - 'user'：玩家付款（下单时原子扣玩家余额，取消时按状态退款）
 * - 'character'：角色付款（完全不触碰玩家钱包）
 * 旧数据没有该字段：按 orderer.type 推断（player 下单 = user 付款，角色下单 = character 付款）。
 */
export type FoodOrderPayer = 'user' | 'character';


export interface FoodOrderItemSnapshot {
    catalogItemId?: string;
    name: string;
    merchantName?: string;
    quantity: number;
    unitPrice?: number;
    description?: string;
    note?: string;
    imageRef?: string;
    originalUrl?: string;
}

export interface FoodOrderTimeline {
    confirmedAt: number;
    preparingAt: number;
    pickedUpAt: number;
    deliveringAt: number;
    estimatedDeliveredAt: number;
    deliveredAt?: number;
}

export interface FoodOrderChatState {
    orderCardMessageId?: string;
    orderReactionMessageIds?: string[];
    /** 自动回应先持久认领再请求；失败也不无限自动重试。 */
    orderReactionAttemptedAt?: number;
    deliveryEventClaimedAt?: number;
    deliveryEventMessageId?: string;
    /** 备份恢复的旧订单禁止补发历史送达事件或 API 回应。 */
    deliveryEventSuppressed?: boolean;
    deliveryReactionMessageIds?: string[];
    deliveryReactionAttemptedAt?: number;
}

export interface FoodOrderRecord {
    schemaVersion: 1;
    id: string;
    eventKey: string;
    source: FoodOrderSource;
    /** 付款方；旧记录缺省时按 orderer.type 推断。 */
    payer?: FoodOrderPayer;
    /** 多商家一次结算的批次 id（同批各订单共享；单商家/旧记录缺省）。 */
    checkoutBatchId?: string;
    /** 本单由显式请求还是自主机会触发（cooldown 推导用；旧记录缺省视为既有行为）。 */
    triggerSource?: 'explicit' | 'autonomous';
    orderer: FoodOrderParty;
    recipient: FoodOrderParty;

    charId: string;
    merchantName?: string;
    items: FoodOrderItemSnapshot[];
    subtotal?: number;
    deliveryFee?: number;
    total?: number;
    currency: 'CNY';
    locationLabel?: string;
    status: FoodOrderStatus;
    timeline: FoodOrderTimeline;
    chat?: FoodOrderChatState;
    createdAt: number;
    updatedAt: number;
}

export const FOOD_ORDER_STATUS_LABEL: Record<FoodOrderStatus, string> = {
    confirmed: '已下单',
    preparing: '商家备餐中',
    picked_up: '骑手已取餐',
    delivering: '配送中',
    delivered: '已送达',
    cancelled: '已取消',
    failed: '订单异常',
};
