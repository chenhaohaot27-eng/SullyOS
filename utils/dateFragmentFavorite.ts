/**
 * dateFragmentFavorite — 见面模式精准收藏（文字选区 / 单句语音原声）。
 *
 * 数据模型（复用 MessageFavorite，无新 store、无新字段）：
 *  - 文字片段：id = mfav-<msgId>-ft-<hash(msgId|occurrence|text)>，favoriteType 'text'，
 *    contentSnapshot = 用户实际选中的文字（绝不是整条 Message）。
 *  - 语音片段：id = mfav-<msgId>-fv-<lineIdx>-<hash(msgId|lineIdx|lineText)>，favoriteType 'voice'，
 *    mediaRef = voice_frag_<hash>（独立持久化音频资产），**绝不带 lazySynth**——
 *    回放只读原始 Blob，资产丢失就显示失联，不允许重新合成冒充原声。
 *  - 旧整条收藏（mfav-<msgId>）原样保留，与片段收藏并存互不覆盖（DB v79 非唯一索引）。
 *
 * 单句音频一一对应：见面 TTS 按句合成（minimaxTts/fish 均返回 TtsResult{url,blob}），
 * 播放时把 {url, blob} 记入本模块的页面级缓存（key = msgId|lineIdx|lineText）；
 * 收藏时从缓存取原始 Blob（blob 直取 / objectURL fetch / 远程 URL 合法下载），
 * 取不到 = 「原语音未保存，无法收藏原声」——绝不触发新的 TTS 请求。
 *
 * 一致性：先写音频资产，再写收藏；收藏写失败则回滚孤儿资产；取消收藏时仅在
 * 无其它收藏引用同一 mediaRef 时才删资产（voice_frag_* 独立成键，天然不误删他人）。
 */

import type { CharacterProfile, Message, MessageFavorite } from '../types';

/** djb2 稳定哈希（与 giftIntent.giftSendIntentKey 同风格）。 */
function stableHash(seed: string): string {
    let hash = 5381;
    for (let i = 0; i < seed.length; i++) hash = ((hash << 5) + hash + seed.charCodeAt(i)) >>> 0;
    return hash.toString(36);
}

export const TEXT_FRAGMENT_ID_PART = 'ft';
export const VOICE_FRAGMENT_ID_PART = 'fv';
export const VOICE_FRAG_ASSET_PREFIX = 'voice_frag_';

export interface FragmentMeta {
    fragment: {
        kind: 'text' | 'voice';
        messageId: number;
        /** 文字：同一节点内第几次出现（同文重复选区区分）；语音：台词在消息内的行号。 */
        occurrence?: number;
        lineIdx?: number;
    };
    /** 语音片段的台词文字（回放失联时海螺已有 contentSnapshot，这里仅语义冗余）。 */
    spokenText?: string;
}

// ─── 单句音频页面级缓存（不落库、不膨胀：只记本页面播放过的句子） ───────────────

export interface LineAudioEntry {
    url: string;
    blob: Blob | null;
    /** 台词文字（供历史收藏选择器展示与确认；不参与 key）。 */
    lineText?: string;
}

/** key = voiceLineFragmentKey(msgId, lineIdx, lineText)。 */
const lineAudioCache = new Map<string, LineAudioEntry>();

export function voiceLineFragmentKey(msgId: number, lineIdx: number, lineText: string): string {
    return `${msgId}|${lineIdx}|${stableHash(lineText)}`;
}

export function rememberLineAudio(key: string, entry: LineAudioEntry): void {
    lineAudioCache.set(key, entry);
}

/** 测试专用：清空页面级音频缓存。 */
export function resetLineAudioCacheForTests(): void {
    lineAudioCache.clear();
}

export function hasLineAudio(key: string): boolean {
    return lineAudioCache.has(key);
}

/** 某消息里“本页面播放过、原声仍可取”的行（供历史收藏选择器）。 */
export function cachedVoiceLinesForMessage(msgId: number): Array<{ lineIdx: number; lineText: string; key: string }> {
    const prefix = `${msgId}|`;
    const result: Array<{ lineIdx: number; lineText: string; key: string }> = [];
    for (const [key, entry] of lineAudioCache) {
        if (!key.startsWith(prefix)) continue;
        const lineIdx = Number(key.slice(prefix.length).split('|')[0]);
        if (Number.isFinite(lineIdx)) result.push({ lineIdx, lineText: entry.lineText || '', key });
    }
    return result.sort((a, b) => a.lineIdx - b.lineIdx);
}

/**
 * 取某句的原始音频 Blob（不产生任何 TTS 请求）：
 * blob 直取 → objectURL fetch → 远程 URL 合法下载（cache-bust）；全部失败返回 null。
 */
export async function takeLineAudioBlob(key: string): Promise<Blob | null> {
    const entry = lineAudioCache.get(key);
    if (!entry) return null;
    if (entry.blob instanceof Blob && entry.blob.size > 0) return entry.blob;
    if (entry.url.startsWith('blob:')) {
        try { const b = await (await fetch(entry.url)).blob(); return b.size > 0 ? b : null; } catch { return null; }
    }
    if (/^https?:/i.test(entry.url)) {
        try {
            const { fetchRemoteAudioBlob } = await import('./minimaxTts');
            return await fetchRemoteAudioBlob(entry.url);
        } catch { return null; }
    }
    return null;
}

// ─── 文字片段收藏 ─────────────────────────────────────────────────────────────

export interface TextFragmentInput {
    msg: Message;
    char: CharacterProfile;
    /** 用户实际选中的文字（调用方保证非空）。 */
    selectedText: string;
    /** 同一文本节点内第几次出现（重复内容去重用）；缺省 0。 */
    occurrence?: number;
    now?: number;
}

export function textFragmentId(msgId: number, occurrence: number, selectedText: string): string {
    return `mfav-${msgId}-${TEXT_FRAGMENT_ID_PART}-${stableHash(`${msgId}|${occurrence}|${selectedText}`)}`;
}

export function buildTextFragmentFavorite(input: TextFragmentInput): MessageFavorite {
    const selected = input.selectedText.replace(/\s+/g, ' ').trim().slice(0, 8000);
    const occurrence = Math.max(0, Math.floor(input.occurrence || 0));
    return {
        id: textFragmentId(input.msg.id, occurrence, selected),
        sourceMessageId: input.msg.id,
        charId: input.char.id,
        charNameSnapshot: input.char.name || '',
        messageRole: input.msg.role,
        messageType: input.msg.type,
        favoriteType: 'text',
        contentSnapshot: selected, // 只存选中的文字，绝不退化整条
        favoritedAt: input.now ?? Date.now(),
        originalTimestamp: input.msg.timestamp || Date.now(),
        metadataSnapshot: { fragment: { kind: 'text', messageId: input.msg.id, occurrence } },
    };
}

// ─── 单句语音原声收藏 ─────────────────────────────────────────────────────────

export function voiceFragmentId(msgId: number, lineIdx: number, lineText: string): string {
    return `mfav-${msgId}-${VOICE_FRAGMENT_ID_PART}-${lineIdx}-${stableHash(`${msgId}|${lineIdx}|${lineText}`)}`;
}

export function voiceFragmentAssetRef(msgId: number, lineIdx: number, lineText: string): string {
    return `${VOICE_FRAG_ASSET_PREFIX}${stableHash(`${msgId}|${lineIdx}|${lineText}`)}`;
}

export interface VoiceFragmentInput {
    msg: Message;
    char: CharacterProfile;
    /** 台词在消息内的行号（与渲染切分一致，稳定标识，不以台词文本为唯一索引）。 */
    lineIdx: number;
    lineText: string;
    now?: number;
}

export type FavoriteVoiceLineResult =
    | { ok: true; created: boolean; favorite: MessageFavorite }
    | { ok: false; reason: 'audio_unavailable' | 'save_failed' };

/**
 * 收藏一句语音原声。音频获取由调用方注入（acquireAudio 返回原始 Blob 或 null）——
 * 本函数不做任何 TTS/合成调用。成功路径：先写资产 → 再写收藏；收藏写失败回滚孤儿资产。
 */
export async function favoriteVoiceLine(
    input: VoiceFragmentInput,
    acquireAudio: () => Promise<Blob | null>,
): Promise<FavoriteVoiceLineResult> {
    const { DB } = await import('./db');
    const assetRef = voiceFragmentAssetRef(input.msg.id, input.lineIdx, input.lineText);
    const favoriteId = voiceFragmentId(input.msg.id, input.lineIdx, input.lineText);

    // 幂等快路径：同一句已收藏 → 直接返回既有记录（不重复写资产，零额外占用）
    const existingRows = await DB.getMessageFavorites(input.char.id).catch(() => [] as MessageFavorite[]);
    const existing = existingRows.find(r => r.id === favoriteId);
    if (existing) return { ok: true, created: false, favorite: existing };

    const blob = await acquireAudio();
    if (!blob || blob.size === 0) return { ok: false, reason: 'audio_unavailable' };

    await DB.saveAssetRaw(assetRef, { blob });
    const favorite: MessageFavorite = {
        id: favoriteId,
        sourceMessageId: input.msg.id,
        charId: input.char.id,
        charNameSnapshot: input.char.name || '',
        messageRole: input.msg.role,
        messageType: input.msg.type,
        favoriteType: 'voice',
        contentSnapshot: input.lineText.slice(0, 8000),
        mediaRef: assetRef,
        favoritedAt: input.now ?? Date.now(),
        originalTimestamp: input.msg.timestamp || Date.now(),
        metadataSnapshot: {
            fragment: { kind: 'voice', messageId: input.msg.id, lineIdx: input.lineIdx },
            spokenText: input.lineText,
            // 注意：刻意不写 lazySynth —— 原声收藏不允许重新合成替代
        } as Record<string, any>,
    };
    try {
        await DB.saveMessageFavorite(favorite);
        return { ok: true, created: true, favorite };
    } catch (e) {
        // 一致性回滚：收藏没落库，资产就是孤儿 —— best-effort 删除，不留泄漏
        try { await DB.deleteAsset(assetRef); } catch { /* ignore */ }
        console.warn('[FragmentFavorite] 语音片段收藏写入失败（已回滚音频资产）:', e instanceof Error ? e.message : e);
        return { ok: false, reason: 'save_failed' };
    }
}

/**
 * 取消收藏后的资产清理：仅当没有其它收藏引用同一 mediaRef 时才删资产。
 * 只处理本模块的 voice_frag_* 资产；旧 voice_msg_*（整条语音）语义不动。
 */
export async function cleanupFragmentAssetIfOrphaned(mediaRef: string | undefined): Promise<void> {
    if (!mediaRef || !mediaRef.startsWith(VOICE_FRAG_ASSET_PREFIX)) return;
    const { DB } = await import('./db');
    const all = await DB.getMessageFavorites().catch(() => [] as MessageFavorite[]);
    if (all.some(r => r.mediaRef === mediaRef)) return; // 仍有引用，绝不误删
    try { await DB.deleteAsset(mediaRef); } catch { /* ignore */ }
}

