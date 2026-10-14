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

/** 收藏展示分类：图片 / 语音 / 文字。forceVoice：date 场景显式按语音收藏（惰性合成回放）。 */
export const resolveFavoriteType = (
    msg: Pick<Message, 'type' | 'content' | 'role'>,
    voiceData?: VoiceSnapshotLite | null,
    forceVoice?: boolean,
): MessageFavorite['favoriteType'] => {
    if (msg.type === 'image') return 'image';
    if (voiceData?.url || forceVoice || VOICE_TAG_RE.test(msg.content || '')) return 'voice';
    return 'text';
};

export const MESSAGE_FAVORITE_ID_PREFIX = 'mfav-';

/** 见面场景的 TTS 正文：剥掉 [v:xxx] 情绪标记与 <语音> 标签，剩下的就是可朗读文本。 */
export const stripVoiceMarkersForSpeech = (content: string): string =>
    (content || '')
        .replace(/\[v:[^\]]*\]/gi, '')
        .replace(/<[语語]音[^>]*>/g, '')
        .trim();

export interface BuildMessageFavoriteArgs {
    msg: Message;
    char: CharacterProfile;
    voiceData?: VoiceSnapshotLite | null;
    /**
     * 见面模式：见面对话中角色开口即有 TTS 语音（播放时即时合成、不持久化），
     * 传 true 强制按 voice 收藏——只存 spokenText 快照，回放时惰性合成（不现场生成）。
     */
    forceVoice?: boolean;
    now?: number;
}

export const buildMessageFavorite = (args: BuildMessageFavoriteArgs): MessageFavorite => {
    const { msg, char, voiceData, forceVoice, now = Date.now() } = args;
    const favoriteType = resolveFavoriteType(msg, voiceData, forceVoice);
    const content = typeof msg.content === 'string' ? msg.content : '';
    const lazyVoice = favoriteType === 'voice' && !voiceData?.url;
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
            ? {
                // 惰性语音（date 收藏）：无已存音频，回放时用现有 TTS 流程重新合成
                spokenText: voiceData?.spokenText || (lazyVoice ? stripVoiceMarkersForSpeech(content) : undefined),
                lang: voiceData?.lang,
                ...(lazyVoice ? { lazySynth: true } : {}),
            }
            : undefined,
        favoritedAt: now,
        originalTimestamp: msg.timestamp || now,
    };
};

// ─── 共享收藏开关（Chat / DateApp 共用，保持幂等与取消收藏） ──────────────────

export interface ToggleMessageFavoriteArgs extends BuildMessageFavoriteArgs {
    /**
     * 调用方已知收藏状态时传入，跳过一次 DB 查询（Chat 维护 favoritedMsgIds 集合）；
     * 缺省时自动查当前角色的收藏列表判断。
     */
    wasFavorited?: boolean;
}

export interface ToggleMessageFavoriteResult {
    /** true = 本次收藏；false = 本次取消收藏。 */
    added: boolean;
    favorite?: MessageFavorite;
}

/**
 * 收藏 / 取消收藏一条消息（幂等：id = mfav-<msgId>；重复收藏不产生第二条）。
 * 取消收藏只删收藏记录，绝不触碰原消息与音频/图片资产。
 */
export async function toggleMessageFavorite(args: ToggleMessageFavoriteArgs): Promise<ToggleMessageFavoriteResult> {
    const { DB } = await import('./db');
    const { msg, char, wasFavorited } = args;
    const existingKey = `${MESSAGE_FAVORITE_ID_PREFIX}${msg.id}`;
    let favorited = wasFavorited;
    if (favorited === undefined) {
        try {
            const rows = await DB.getMessageFavorites(char.id);
            favorited = rows.some(r => r.sourceMessageId === msg.id);
        } catch {
            favorited = false; // 读取失败按未收藏处理（与 Chat 现行为一致）
        }
    }
    if (favorited) {
        await DB.deleteMessageFavorite(existingKey);
        return { added: false };
    }
    const favorite = buildMessageFavorite(args);
    await DB.saveMessageFavorite(favorite);
    return { added: true, favorite };
}
