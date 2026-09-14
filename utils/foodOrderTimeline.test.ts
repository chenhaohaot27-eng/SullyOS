import { describe, expect, it, vi } from 'vitest';
import { createFoodOrderTimeline, deriveFoodOrderStatus } from './foodOrderTimeline';

const base = 1_000_000;
const timeline = { confirmedAt: base, preparingAt: base + 10, pickedUpAt: base + 20, deliveringAt: base + 30, estimatedDeliveredAt: base + 40 };
const order = (status: any = 'confirmed') => ({ status, timeline });

describe('foodOrderTimeline', () => {
    it('confirmed', () => expect(deriveFoodOrderStatus(order(), base + 1)).toBe('confirmed'));
    it('preparing', () => expect(deriveFoodOrderStatus(order(), base + 10)).toBe('preparing'));
    it('picked_up', () => expect(deriveFoodOrderStatus(order(), base + 20)).toBe('picked_up'));
    it('delivering', () => expect(deriveFoodOrderStatus(order(), base + 30)).toBe('delivering'));
    it('delivered', () => expect(deriveFoodOrderStatus(order(), base + 40)).toBe('delivered'));
    it('cancelled 是终止态', () => expect(deriveFoodOrderStatus(order('cancelled'), base + 999)).toBe('cancelled'));
    it('failed 是终止态', () => expect(deriveFoodOrderStatus(order('failed'), base + 999)).toBe('failed'));
    it('相同已存 timeline 在相同 now 得到相同状态', () => {
        expect(deriveFoodOrderStatus(order(), base + 25)).toBe(deriveFoodOrderStatus(order(), base + 25));
    });
    it('关闭很久后重开直接 delivered', () => expect(deriveFoodOrderStatus(order(), base + 10_000)).toBe('delivered'));
    it('derive 不调用随机数', () => {
        const spy = vi.spyOn(Math, 'random');
        deriveFoodOrderStatus(order(), base + 25);
        expect(spy).not.toHaveBeenCalled();
    });
    it('创建时一次固定四个递增节点', () => {
        const random = vi.fn(() => 0);
        const made = createFoodOrderTimeline(base, random);
        expect(random).toHaveBeenCalledTimes(4);
        expect(made).toEqual({ confirmedAt: base, preparingAt: base + 5 * 60_000, pickedUpAt: base + 15 * 60_000, deliveringAt: base + 20 * 60_000, estimatedDeliveredAt: base + 30 * 60_000 });
    });
});
