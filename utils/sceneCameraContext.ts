/**
 * Scene Camera Context Adapters (Phase 3C)
 *
 * 职责：为共享 SceneCameraModal 提供两个入口的「最小必要上下文」与 Director 配置派生。
 *
 * 原则：
 * - 陪伴模式：直接使用 DateSession 已加载的见面消息（不重新拼一套历史）
 * - 剧情模式：复用 storyTheater 现有 buildStoryHistory / limitStoryHistoryByCharBudget
 * - Director 配置：从当前聊天 API config 派生（不在 Scene Camera UI 重新输入 Key）
 */

import type { APIConfig, CharacterProfile, Message } from '../types';
import type { DirectorApiConfig } from './sceneCameraPrompt';
import { buildStoryHistory, limitStoryHistoryByCharBudget } from './storyTheater';

export type SceneCameraContextSource = 'companion' | 'story';

/** 陪伴模式：Director 输入取最近 N 条见面消息（时间顺序，最后一条最接近当下）。 */
export const COMPANION_SCENE_CONTEXT_MESSAGE_LIMIT = 24;

/** Scene Camera 场景上下文字符预算（Director 只需要「此刻」，不需要整段历史）。 */
export const SCENE_CONTEXT_CHAR_BUDGET = 6000;

/** 超预算时从尾部截断（保留最接近当下的内容），并丢掉被截断的残行开头。 */
function clampToTail(text: string, budget: number): string {
    if (text.length <= budget) return text;
    return text.slice(text.length - budget).replace(/^[\S]+\s*/, '…');
}

/**
 * 陪伴模式场景上下文：最近 N 条见面消息按时间排列成短剧本。
 * 只做「最小必要」压缩，不复用 buildSessionPayload（那是聊天 reply 的重型管线）。
 */
export function buildCompanionSceneContext(
    messages: Message[],
    characterName: string,
    options: { messageLimit?: number; charBudget?: number } = {},
): string {
    const limit = options.messageLimit ?? COMPANION_SCENE_CONTEXT_MESSAGE_LIMIT;
    const budget = options.charBudget ?? SCENE_CONTEXT_CHAR_BUDGET;
    const recent = messages
        .filter(m => typeof m.content === 'string' && m.content.trim())
        .slice(-limit);
    const lines = recent.map(m => `${m.role === 'user' ? '玩家' : characterName}：${m.content.trim()}`);
    return clampToTail(`【陪伴见面 · 最近场景】\n\n${lines.join('\n\n')}`, budget);
}

/**
 * 剧情模式场景上下文：复用剧情模式现有的 buildStoryHistory + 字符预算裁剪，
 * 不复制 Director / Renderer 逻辑，也不重复维护第二套压缩器。
 */
export function buildStorySceneContext(
    messages: Message[],
    entryTitle: string,
    identityName: string,
    options: { charBudget?: number } = {},
): string {
    const budget = options.charBudget ?? SCENE_CONTEXT_CHAR_BUDGET;
    const history = limitStoryHistoryByCharBudget(buildStoryHistory(messages));
    const lines = history.map(m => `[${m.role === 'user' ? `${identityName}给出的推进` : '剧场正文'}]\n${m.content}`);
    return clampToTail(`【剧情 · ${entryTitle}】\n\n${lines.join('\n\n')}`, budget);
}

/**
 * Director 配置派生：默认复用当前可用聊天 API config。
 * provider 只决定请求格式（gemini-native / openai-compatible），UI 不绑定具体厂商品牌。
 */
export function deriveDirectorApiConfig(
    apiConfig: Pick<APIConfig, 'baseUrl' | 'apiKey' | 'model' | 'apiFormat'>,
): DirectorApiConfig {
    return {
        provider: apiConfig.apiFormat === 'gemini-native' ? 'gemini-native' : 'openai-compatible',
        baseUrl: apiConfig.baseUrl,
        apiKey: apiConfig.apiKey,
        model: apiConfig.model,
    };
}

/** Scene Camera 使用的角色对象（Phase 3C：剧情多 NPC 群像暂不实现，取首位出场角色）。 */
export function pickSceneCameraCharacter(characters: CharacterProfile[]): CharacterProfile | undefined {
    return characters.length > 0 ? characters[0] : undefined;
}
