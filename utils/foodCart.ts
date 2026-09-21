import type { FoodCatalogItem } from './foodTypes';
import type { FoodOrderItemSnapshot } from './foodOrderTypes';

export const FOOD_DELIVERY_FEE = 5;

export interface FoodCartLine {
    item: FoodCatalogItem;
    quantity: number;
    note?: string;
}

export type FoodCart = FoodCartLine[];

/** 清理：merchantKey 不再用于加购限制，但保留导出供分组排序复用。 */
const merchantKey = (value?: string): string => (value || '').normalize('NFKC').trim().toLocaleLowerCase();

export interface MerchantCartGroup {
    /** 归一化后的商家名（排序键）。 */
    key: string;
    merchantName: string;
    lines: FoodCartLine[];
    totals: FoodCartTotals;
}

/** 购物车按商家分组（保持首次加入顺序），每组带独立小计/配送费/总价。 */
export function groupFoodCartByMerchant(cart: FoodCart): MerchantCartGroup[] {
    const groups: MerchantCartGroup[] = [];
    for (const line of cart) {
        const key = merchantKey(line.item.merchantName);
        let group = groups.find(item => item.key === key);
        if (!group) {
            group = { key, merchantName: line.item.merchantName || '未记录商家', lines: [], totals: calculateFoodCartTotals([]) };
            groups.push(group);
        }
        group.lines.push(line);
    }
    for (const group of groups) group.totals = calculateFoodCartTotals(group.lines);
    return groups;
}


export interface AddFoodCartResult {
    cart: FoodCart;
    /** @deprecated 多商家购物车（Hotfix Phase1）后恒为 false；保留字段兼容旧调用方。 */
    merchantConflict: boolean;
}

/** 多商家购物车：不同商家可共存于同一购物车；同款商品合并数量。 */
export function addFoodCartItem(cart: FoodCart, item: FoodCatalogItem): AddFoodCartResult {
    const index = cart.findIndex(line => line.item.id === item.id);
    if (index >= 0) {
        return {
            cart: cart.map((line, i) => i === index ? { ...line, quantity: line.quantity + 1 } : line),
            merchantConflict: false,
        };
    }
    return { cart: [...cart, { item, quantity: 1 }], merchantConflict: false };
}

export function setFoodCartQuantity(cart: FoodCart, itemId: string, quantity: number): FoodCart {
    if (!Number.isFinite(quantity) || quantity <= 0) return removeFoodCartItem(cart, itemId);
    return cart.map(line => line.item.id === itemId ? { ...line, quantity: Math.floor(quantity) } : line);
}

export function setFoodCartNote(cart: FoodCart, itemId: string, note: string): FoodCart {
    return cart.map(line => line.item.id === itemId ? { ...line, note: note.trim().slice(0, 300) || undefined } : line);
}

export function removeFoodCartItem(cart: FoodCart, itemId: string): FoodCart {
    return cart.filter(line => line.item.id !== itemId);
}

export interface FoodCartTotals {
    itemCount: number;
    knownSubtotal: number;
    deliveryFee: number;
    total?: number;
    hasUnknownPrices: boolean;
}

export function calculateFoodCartTotals(cart: FoodCart): FoodCartTotals {
    let knownSubtotal = 0;
    let itemCount = 0;
    let hasUnknownPrices = false;
    for (const line of cart) {
        itemCount += line.quantity;
        if (line.item.price === undefined) hasUnknownPrices = true;
        else knownSubtotal += line.item.price * line.quantity;
    }
    const rounded = Math.round(knownSubtotal * 100) / 100;
    return {
        itemCount,
        knownSubtotal: rounded,
        deliveryFee: FOOD_DELIVERY_FEE,
        ...(hasUnknownPrices ? {} : { total: Math.round((rounded + FOOD_DELIVERY_FEE) * 100) / 100 }),
        hasUnknownPrices,
    };
}

/** 下单时复制 Catalog 数据，后续 Catalog 修改不会改变历史订单。 */
export function snapshotFoodCart(cart: FoodCart): FoodOrderItemSnapshot[] {
    return cart.map(({ item, quantity, note }) => ({
        catalogItemId: item.id,
        name: item.name,
        merchantName: item.merchantName,
        quantity,
        unitPrice: item.price,
        description: item.description,
        note,
        imageRef: item.imageRef,
        originalUrl: item.originalUrl,
    }));
}

export function clearFoodCartAfterOrder(cart: FoodCart, orderCreated: boolean): FoodCart {
    return orderCreated ? [] : cart;
}
