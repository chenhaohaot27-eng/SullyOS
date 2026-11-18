/**
 * autonomyPhoto — 群聊自主发图的**决策层**（纯函数，可直测）。
 *
 * 决策只回答一个问题：这一轮的这条 SEND_PHOTO 意图，到底允不允许真正生成？
 * 五道闸（全过才放行，对应需求 C1/C7）：
 *   1. 群自主活跃开着（自主发图是自主活跃的子能力）；
 *   2. 群「允许角色自主发图」开关开着；
 *   3. 生图 API 已配置且启用（configEnabled 由调用方读配置后传入，保持本模块纯净）；
 *   4. 当天每群配额还有剩余（默认 2 张/天，可在群设置调整；0 = 关闭）；
 *   5. 本轮已生成过 1 张就不再放行（每次自主触发最多 1 张）。
 *
 * 决策之外的事（真正的生成、落库、配额消耗）由 GroupChat 组件执行：
 * 消息带 groupId + charId 双关联，生成复用 utils/chatPhotoGeneration 的
 * runGroupChatPhotoMessage（视觉身份/参考图/预设/相册同步与单聊完全同一套）。
 * 禁止一切「[图片]/文字描述冒充图片」的降级——不放行就是不发，不留占位文本。
 */

import type { GroupProfile } from '../../types';
import { DirectorAction } from './parse';
import { extractChatPhotoIntent, type ChatPhotoIntent } from '../chatPhotoIntent';
import {
    isGroupAutonomyEnabled,
    photoQuotaRemaining,
    type GroupAutonomyState,
    type GroupAutonomyStateEntry,
} from './autonomy';

export interface GroupPhotoPlanInput {
    group: Pick<GroupProfile, 'id' | 'autonomyConfig'>;
    /** 调用方从 loadImageGenerationConfig() 读出的可用性（enabled && 已配凭据）。 */
    imageApiReady: boolean;
    state: GroupAutonomyState;
    /** 本轮已经生成过的图片数（单轮上限 1）。 */
    photosThisRound: number;
    now?: Date;
}

export interface GroupPhotoPlan {
    allowed: boolean;
    reason?: string;
    /** 允许时：今天还能生成几张（含本次）。 */
    remainingToday?: number;
}

/** 自主轮单轮图片上限：每次自主触发最多生成 1 张，避免反复扣费。 */
export const MAX_PHOTOS_PER_AUTONOMY_ROUND = 1;

/** 决策入口：见文件头五道闸。 */
export function planGroupAutonomyPhoto(input: GroupPhotoPlanInput): GroupPhotoPlan {
    const now = input.now ?? new Date();
    if (!isGroupAutonomyEnabled(input.group)) return { allowed: false, reason: 'autonomy-disabled' };
    if (input.group.autonomyConfig?.photoEnabled !== true) return { allowed: false, reason: 'photo-disabled' };
    if (!input.imageApiReady) return { allowed: false, reason: 'image-api-unavailable' };
    if (input.photosThisRound >= MAX_PHOTOS_PER_AUTONOMY_ROUND) return { allowed: false, reason: 'round-cap' };
    const entry: GroupAutonomyStateEntry | undefined = input.state[input.group.id];
    const remaining = photoQuotaRemaining(input.group, entry, now);
    if (remaining <= 0) return { allowed: false, reason: 'daily-cap' };
    return { allowed: true, remainingToday: remaining };
}

export interface ExtractedGroupPhoto {
    /** 发送者成员 id（必须是群成员，由调用方再校验一次）。 */
    charId: string;
    intent: ChatPhotoIntent;
}

/**
 * 从导演动作里抽 SEND_PHOTO 意图（复用单聊 chatPhotoIntent 解析器，协议同源）。
 * 每轮至多取第一个能安全解析的意图；返回的 cleanedActions 已把标签从正文剥掉——
 * 不放行时正文照常发（只是没有图），放行时由调用方落真正的 image 消息。
 * 图片意图对应成员若 content 剥掉标签后为空，则该条文本动作整体跳过（只发图不发文字）。
 */
export function extractGroupPhotoFromActions(actions: DirectorAction[]): {
    photos: ExtractedGroupPhoto[];
    cleanedActions: DirectorAction[];
} {
    const photos: ExtractedGroupPhoto[] = [];
    const cleanedActions: DirectorAction[] = [];
    let photoTaken = false;
    for (const action of actions) {
        const extraction = extractChatPhotoIntent(action.content);
        if (extraction.intent && !photoTaken) {
            photoTaken = true;
            photos.push({ charId: action.charId, intent: extraction.intent });
        }
        const cleaned = extraction.cleanedContent.trim();
        if (cleaned) cleanedActions.push({ charId: action.charId, content: cleaned });
    }
    return { photos, cleanedActions };
}
