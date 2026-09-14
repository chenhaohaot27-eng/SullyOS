import type { FoodCatalogItem } from './foodTypes';
import type { FoodOrderItemSnapshot } from './foodOrderTypes';

export const FOOD_DELIVERY_FEE = 5;

export interface FoodCartLine {
    item: FoodCatalogItem;
    quantity: number;
    note?: string;
}

export type FoodCart = FoodCartLine[];

const merchantKey = (value?: string): string => (value || '').normalize('NFKC').trim().toLocaleLowerCase();

export interface AddFoodCartResult {
    cart: FoodCart;
    merchantConflict: boolean;
}

export function addFoodCartItem(cart: FoodCart, item: FoodCatalogItem): AddFoodCartResult {
    const first = cart[0]?.item;
    if (first && merchantKey(first.merchantName) !== merchantKey(item.merchantName)) {
        return { cart, merchantConflict: true };
    }
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
