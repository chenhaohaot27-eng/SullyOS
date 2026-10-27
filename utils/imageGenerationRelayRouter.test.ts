import { describe, it, expect } from 'vitest';
import { applyRelayRouterProviderSwitch, isRelayRouterUrl, RELAY_ROUTER_HOST, RELAY_ROUTER_HOSTS } from './imageGenerationRelayRouter';

describe('imageGenerationRelayRouter — host 识别', () => {
    it('仅 api.relayrouter.ai（忽略大小写）命中', () => {
        expect(RELAY_ROUTER_HOST).toBe('api.relayrouter.ai');
        expect(isRelayRouterUrl('https://api.relayrouter.ai/v1')).toBe(true);
        expect(isRelayRouterUrl('https://API.RELAYROUTER.AI/v1beta')).toBe(true);
        expect(isRelayRouterUrl('https://api.relayrouter.ai')).toBe(true);
        expect(isRelayRouterUrl('https://generativelanguage.googleapis.com/v1beta')).toBe(false);
        expect(isRelayRouterUrl('https://api.openai.com/v1')).toBe(false);
        expect(isRelayRouterUrl('https://evil-relayrouter.ai.attacker.com/v1')).toBe(false);
        expect(isRelayRouterUrl('')).toBe(false);
    });

    it('新域名 api.relayrouter.app 同样命中（保留 .ai 兼容）', () => {
        expect(RELAY_ROUTER_HOSTS.has('api.relayrouter.ai')).toBe(true);
        expect(RELAY_ROUTER_HOSTS.has('api.relayrouter.app')).toBe(true);
        expect(isRelayRouterUrl('https://api.relayrouter.app/v1')).toBe(true);
        expect(isRelayRouterUrl('https://API.RELAYROUTER.APP/v1beta')).toBe(true);
        expect(isRelayRouterUrl('https://api.relayrouter.app')).toBe(true);
        expect(isRelayRouterUrl('https://api.relayrouter.app.attacker.com/v1')).toBe(false);
        expect(isRelayRouterUrl('https://relayrouter.app/v1')).toBe(false);
    });
});

describe('imageGenerationRelayRouter — 协议切换 /v1 ↔ /v1beta', () => {
    it('切到 gemini-native：/v1 → /v1beta', () => {
        expect(applyRelayRouterProviderSwitch('https://api.relayrouter.ai/v1', 'gemini-native'))
            .toBe('https://api.relayrouter.ai/v1beta');
    });

    it('切到 openai-images：/v1beta → /v1', () => {
        expect(applyRelayRouterProviderSwitch('https://api.relayrouter.ai/v1beta', 'openai-images'))
            .toBe('https://api.relayrouter.ai/v1');
    });

    it('.app 新域名同样改写 /v1 ↔ /v1beta，且不重复追加', () => {
        expect(applyRelayRouterProviderSwitch('https://api.relayrouter.app/v1', 'gemini-native'))
            .toBe('https://api.relayrouter.app/v1beta');
        expect(applyRelayRouterProviderSwitch('https://api.relayrouter.app/v1beta', 'openai-images'))
            .toBe('https://api.relayrouter.app/v1');
        expect(applyRelayRouterProviderSwitch('https://api.relayrouter.app/v1beta', 'gemini-native'))
            .toBe('https://api.relayrouter.app/v1beta');
        expect(applyRelayRouterProviderSwitch('https://api.relayrouter.app/v1', 'gpt-images'))
            .toBe('https://api.relayrouter.app/v1');
        expect(applyRelayRouterProviderSwitch('https://api.relayrouter.app/v1beta/v1', 'gemini-native'))
            .toBe('https://api.relayrouter.app/v1beta/v1beta'); // 仅按设计改写尾部版本段
    });

    it('支持末尾斜杠与大小写 host', () => {
        expect(applyRelayRouterProviderSwitch('https://Api.RelayRouter.ai/v1/', 'gemini-native'))
            .toBe('https://Api.RelayRouter.ai/v1beta');
    });

    it('不带版本后缀的 RelayRouter 地址原样返回', () => {
        expect(applyRelayRouterProviderSwitch('https://api.relayrouter.ai', 'gemini-native'))
            .toBe('https://api.relayrouter.ai');
    });

    it('已是目标版本时不重复追加', () => {
        expect(applyRelayRouterProviderSwitch('https://api.relayrouter.ai/v1beta', 'gemini-native'))
            .toBe('https://api.relayrouter.ai/v1beta');
        expect(applyRelayRouterProviderSwitch('https://api.relayrouter.ai/v1', 'openai-images'))
            .toBe('https://api.relayrouter.ai/v1');
    });
});

describe('imageGenerationRelayRouter — 非 RelayRouter URL 绝不改写', () => {
    it('官方 Google / OpenAI / 自建中转地址保持原样', () => {
        const untouched: Array<[string, 'gemini-native' | 'openai-images']> = [
            ['https://generativelanguage.googleapis.com/v1', 'gemini-native'],
            ['https://api.openai.com/v1', 'openai-images'],
            ['https://my-proxy.example.com/v1', 'gemini-native'],
            ['https://my-proxy.example.com/v1beta', 'openai-images'],
        ];
        for (const [url, provider] of untouched) {
            expect(applyRelayRouterProviderSwitch(url, provider)).toBe(url);
        }
    });

    it('非法 / 空地址原样返回不抛错', () => {
        expect(applyRelayRouterProviderSwitch('', 'gemini-native')).toBe('');
        expect(applyRelayRouterProviderSwitch('not a url', 'openai-images')).toBe('not a url');
    });
});
