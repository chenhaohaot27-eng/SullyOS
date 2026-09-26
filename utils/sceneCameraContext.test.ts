/**
 * Scene Camera Context Adapter Tests (Phase 3C)
 *
 * 覆盖：
 * 1. 陪伴模式最小必要上下文（最近 N 条、角色名标注、预算截断）
 * 2. 剧情模式复用现有 buildStoryHistory 管线
 * 3. Director 配置从聊天 API config 派生（provider 格式映射）
 * 4. 源码约束：不写聊天、不写记忆、不写 DB、不重复维护生图配置
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Message } from '../types';
import {
    buildCompanionSceneContext,
    buildStorySceneContext,
    deriveDirectorApiConfig,
    pickSceneCameraCharacter,
    COMPANION_SCENE_CONTEXT_MESSAGE_LIMIT,
} from './sceneCameraContext';

const makeMessage = (id: number, role: 'user' | 'assistant', content: string): Message => ({
    id,
    role,
    content,
    timestamp: id,
} as Message);

describe('buildCompanionSceneContext', () => {
    it('应把最近见面消息排成短剧本（玩家 / 角色名标注）', () => {
        const context = buildCompanionSceneContext([
            makeMessage(1, 'user', '今晚想吃什么？'),
            makeMessage(2, 'assistant', '「随你，我都行。」'),
        ], '小满');
        expect(context).toContain('【陪伴见面 · 最近场景】');
        expect(context).toContain('玩家：今晚想吃什么？');
        expect(context).toContain('小满：「随你，我都行。」');
    });

    it('应只取最近 N 条（最小必要上下文，不重新拼整套历史）', () => {
        const total = COMPANION_SCENE_CONTEXT_MESSAGE_LIMIT + 10;
        const messages = Array.from({ length: total }, (_, i) => makeMessage(i + 1, i % 2 ? 'user' : 'assistant', `msg-${i + 1}`));
        const context = buildCompanionSceneContext(messages, '小满');
        expect(context).not.toContain('msg-1\n');
        expect(context).toContain('玩家：msg-' + total);
    });

    it('超字符预算时从尾部截断（保留最接近当下的内容）', () => {
        const long = 'x'.repeat(200);
        const messages = Array.from({ length: 50 }, (_, i) => makeMessage(i + 1, 'user', long));
        const context = buildCompanionSceneContext(messages, '小满', { charBudget: 1000 });
        expect(context.length).toBeLessThanOrEqual(1000);
        expect(context.endsWith('xxxx')).toBe(true);
    });

    it('应跳过空消息', () => {
        const context = buildCompanionSceneContext([
            makeMessage(1, 'user', '   '),
            makeMessage(2, 'assistant', '在场'),
        ], '小满');
        expect(context).toContain('小满：在场');
        expect(context).not.toContain('玩家：');
    });
});

describe('buildStorySceneContext', () => {
    it('应复用剧情模式现有 buildStoryHistory 管线并标注身份', () => {
        const archived = makeMessage(3, 'assistant', '已归档正文');
        (archived as { metadata?: { theaterArchived?: boolean } }).metadata = { theaterArchived: true };
        const context = buildStorySceneContext([
            makeMessage(1, 'user', '推进：夜色渐深'),
            makeMessage(2, 'assistant', '剧场正文：灯亮着'),
            archived,
        ], '深夜剧场', '测试身份');
        expect(context).toContain('【剧情 · 深夜剧场】');
        expect(context).toContain('[测试身份给出的推进]');
        expect(context).toContain('[剧场正文]');
        expect(context).toContain('夜色渐深');
        expect(context).not.toContain('已归档正文');
    });
});

describe('deriveDirectorApiConfig', () => {
    it('gemini-native 聊天配置应派生 gemini-native Director', () => {
        const config = deriveDirectorApiConfig({
            baseUrl: 'https://generativelanguage.googleapis.com',
            apiKey: 'key-gemini',
            model: 'gemini-2.5-pro',
            apiFormat: 'gemini-native',
        });
        expect(config.provider).toBe('gemini-native');
        expect(config.model).toBe('gemini-2.5-pro');
        expect(config.apiKey).toBe('key-gemini');
    });

    it('其余聊天配置应派生 openai-compatible Director（不绑定具体厂商品牌）', () => {
        const config = deriveDirectorApiConfig({
            baseUrl: 'https://api.example.com/v1',
            apiKey: 'key-openai',
            model: 'some-model',
        });
        expect(config.provider).toBe('openai-compatible');
    });
});

describe('pickSceneCameraCharacter', () => {
    it('多 NPC 剧情第一版取首位出场角色', () => {
        const first = { id: 'a', name: 'A' };
        const second = { id: 'b', name: 'B' };
        expect(pickSceneCameraCharacter([first as never, second as never])?.id).toBe('a');
        expect(pickSceneCameraCharacter([])).toBeUndefined();
    });
});

describe('Scene Camera 源码约束（Phase 3C 契约）', () => {
    const readSource = (relative: string): string => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf-8');

    it('Scene Camera 新增/服务文件不写聊天、不写记忆、不建 DB 表、不复制生图配置', () => {
        for (const file of ['./sceneCameraContext.ts', './sceneCameraSession.ts', './sceneCameraService.ts']) {
            const source = readSource(file);
            expect(source, file).not.toContain('saveMessage');
            expect(source, file).not.toContain('saveMemory');
            expect(source, file).not.toContain('addToMemory');
            expect(source, file).not.toContain('CREATE TABLE');
            expect(source, file).not.toContain('saveImageGenerationConfig');
            expect(source, file).not.toContain('localStorage.setItem');
        }
    });
});
