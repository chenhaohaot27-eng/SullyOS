import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AppID } from '../types';
import { INSTALLED_APPS } from '../constants';

describe('Food App registration wiring', () => {
    it('AppID 与桌面配置注册为外卖', () => {
        expect(AppID.FoodDelivery).toBe('food_delivery');
        expect(INSTALLED_APPS).toContainEqual(expect.objectContaining({ id: AppID.FoodDelivery, name: '外卖', icon: 'FoodDelivery' }));
    });

    it('PhoneShell 包含 lazy、preload、mapping 与 render wiring', () => {
        const source = readFileSync(new URL('../components/PhoneShell.tsx', import.meta.url), 'utf8');
        expect(source).toContain("lazyApp(() => import('../apps/FoodDelivery'))");
        expect(source).toContain('SpecialMomentsApp, FoodDeliveryApp, CharCreatorDevApp');
        expect(source).toContain('[AppID.FoodDelivery]: FoodDeliveryApp');
        expect(source).toContain('case AppID.FoodDelivery: return <FoodDeliveryApp />');
    });
});
