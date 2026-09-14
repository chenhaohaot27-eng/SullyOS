import type { FoodOrderRecord, FoodOrderStatus, FoodOrderTimeline } from './foodOrderTypes';

const MINUTE = 60_000;
const integerBetween = (min: number, max: number, random: () => number): number =>
    min + Math.floor(Math.min(0.999999999, Math.max(0, random())) * (max - min + 1));

/** 随机只在创建时消费四次；结果写进 OrderRecord 后永不重算。 */
export function createFoodOrderTimeline(
    confirmedAt = Date.now(),
    random: () => number = Math.random,
    etaMinutes?: number,
): FoodOrderTimeline {
    if (typeof etaMinutes === 'number' && Number.isFinite(etaMinutes)) {
        const eta = Math.min(180, Math.max(20, Math.round(etaMinutes))) * MINUTE;
        return {
            confirmedAt,
            preparingAt: confirmedAt + Math.round(eta * 0.2),
            pickedUpAt: confirmedAt + Math.round(eta * 0.5),
            deliveringAt: confirmedAt + Math.round(eta * 0.7),
            estimatedDeliveredAt: confirmedAt + eta,
        };
    }
    const preparingAt = confirmedAt + integerBetween(5, 10, random) * MINUTE;
    const pickedUpAt = preparingAt + integerBetween(10, 20, random) * MINUTE;
    const deliveringAt = pickedUpAt + integerBetween(5, 10, random) * MINUTE;
    const estimatedDeliveredAt = deliveringAt + integerBetween(10, 25, random) * MINUTE;
    return { confirmedAt, preparingAt, pickedUpAt, deliveringAt, estimatedDeliveredAt };
}

/** cancelled/failed 是终止态；其余状态只看已持久化时间线与 now。 */
export function deriveFoodOrderStatus(
    order: Pick<FoodOrderRecord, 'status' | 'timeline'>,
    now = Date.now(),
): FoodOrderStatus {
    if (order.status === 'cancelled' || order.status === 'failed') return order.status;
    if (now < order.timeline.preparingAt) return 'confirmed';
    if (now < order.timeline.pickedUpAt) return 'preparing';
    if (now < order.timeline.deliveringAt) return 'picked_up';
    if (now < order.timeline.estimatedDeliveredAt) return 'delivering';
    return 'delivered';
}

export function foodOrderEtaMinutes(order: Pick<FoodOrderRecord, 'status' | 'timeline'>, now = Date.now()): number | null {
    const status = deriveFoodOrderStatus(order, now);
    if (status === 'delivered' || status === 'cancelled' || status === 'failed') return null;
    return Math.max(1, Math.ceil((order.timeline.estimatedDeliveredAt - now) / MINUTE));
}
