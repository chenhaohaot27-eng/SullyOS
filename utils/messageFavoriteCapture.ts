/**
 * messageFavoriteCapture —— 把一条聊天 Message 变成留音海螺的收藏快照。
 *
 * 快照纪律：
 * - 图片 → mediaRef = 消息 content（blobref 令牌 / data URL / http，全部可恢复）；
 * - 语音 → mediaRef = assets store 的音频资产 key（`voice_msg_<id>`，与 Chat.tsx
 *   voiceAssetKey 同一约定）；判定依据：已有合成音频 或 原文带 <语音> 标签；
 * - 文字 → 只存 contentSnapshot（截断到 8000 字，防超长楼层把 store 撑爆）；
 * - metadataSnapshot 只放渲染所需最小字段（spokenText/lang），不保存大型上下文。
 */

import type { CharacterProfile, Message, MessageFavorite } from '../types';

export const VOICE_MSG_ASSET_PREFIX = 'voice_msg_';
export const voiceAssetKeyForMessage = (msgId: number): string => `${VOICE_MSG_ASSET_PREFIX}${msgId}`;

const VOICE_TAG_RE = /<[语語]音[^>]*>/;

export interface VoiceSnapshotLite {
    url?: string;
    originalText?: string;
    spokenText?: string;
    lang?: string;
}

/** 收藏展示分类：图片 / 语音 / 文字。 */
export const resolveFavoriteType = (msg: Pick<Message, 'type' | 'content' | 'role'>, voiceData?: VoiceSnapshotLite | null): MessageFavorite['favoriteType'] => {
    if (msg.type === 'image') return 'image';
    if (voiceData?.url || VOICE_TAG_RE.test(msg.content || '')) return 'voice';
    return 'text';
};

export const MESSAGE_FAVORITE_ID_PREFIX = 'mfav-';

export const buildMessageFavorite = (args: {
    msg: Message;
    char: CharacterProfile;
    voiceData?: VoiceSnapshotLite | null;
    now?: number;
}): MessageFavorite => {
    const { msg, char, voiceData, now = Date.now() } = args;
    const favoriteType = resolveFavoriteType(msg, voiceData);
    const content = typeof msg.content === 'string' ? msg.content : '';
    return {
        id: `${MESSAGE_FAVORITE_ID_PREFIX}${msg.id}`,
        sourceMessageId: msg.id,
        charId: char.id,
        charNameSnapshot: char.name || '',
        messageRole: msg.role,
        messageType: msg.type,
        favoriteType,
        contentSnapshot: favoriteType === 'image' ? '' : content.slice(0, 8000),
        mediaRef: favoriteType === 'image'
            ? content
            : favoriteType === 'voice'
                ? voiceAssetKeyForMessage(msg.id)
                : undefined,
        metadataSnapshot: favoriteType === 'voice'
            ? { spokenText: voiceData?.spokenText, lang: voiceData?.lang }
            : undefined,
        favoritedAt: now,
        originalTimestamp: msg.timestamp || now,
    };
};
