/**
 * listenSession —— 「和 ta 一起听」正式会话的落库动作层（Batch B）。
 *
 * canonical store = IndexedDB `music_listen_sessions`（DB v78，见 utils/db.ts）。
 * MusicContext.listeningTogetherWith 只是 UI/runtime mirror：Provider mount 时从这里
 * 恢复 active 状态，session start/end 时通过 registerListenRuntimeMirror 同步 ——
 * PWA 重开后 active 状态不凭空丢失。
 *
 * 幂等铁律：
 *  - 只有 pending → active / pending → declined / active → ended 会生效；重复 accept /
 *    重复 end / 双击全部 no-op（updateMusicListenSession 内部按当前状态守卫）。
 *  - 没有待回应的用户邀请时，MUSIC_LISTEN_RESPONSE 被忽略，绝不凭空建 session。
 *  - 同一 char 已有 active session 时禁止再创建新的 active session。
 *  - durationSec 只在结束/中断时写一次；elapsed 实时值一律现算（Date.now() - startedAt）。
 */

import type { CharacterProfile, MusicListenSession, MusicListenSessionSongSnapshot } from '../types';
import { DB } from './db';
import { isCharacterInviteCooldownActive, type ListenInviteCardMeta } from './listenSessionShared';

export const LISTEN_SESSIONS_CHANGED_EVENT = 'sullyos:music-listen-sessions-changed';

/** React runtime mirror —— MusicProvider mount 时注册；Node 测试 / Provider 未挂时 no-op。 */
export interface ListenRuntimeMirror {
    addPartner: (charId: string) => void;
    removePartner: (charId: string) => void;
}
let __mirror: ListenRuntimeMirror | null = null;
export const registerListenRuntimeMirror = (mirror: ListenRuntimeMirror | null): void => {
    __mirror = mirror;
};

function notifyChanged(): void {
    if (typeof window !== 'undefined') {
        try { window.dispatchEvent(new CustomEvent(LISTEN_SESSIONS_CHANGED_EVENT)); } catch { /* ignore */ }
    }
}

async function putSession(session: MusicListenSession): Promise<MusicListenSession> {
    await DB.saveMusicListenSession(session);
    notifyChanged();
    return session;
}

function sessionCardMeta(session: MusicListenSession, overrides?: Partial<ListenInviteCardMeta>): ListenInviteCardMeta {
    return {
        sessionId: session.id,
        inviter: session.inviter,
        status: session.status,
        song: session.songSnapshot,
        inviterName: session.inviter === 'user' ? '你' : session.charName,
        invitedAt: session.invitedAt,
        ...(session.startedAt != null ? { startedAt: session.startedAt } : {}),
        ...(session.endedAt != null ? { endedAt: session.endedAt } : {}),
        ...(session.durationSec != null ? { durationSec: session.durationSec } : {}),
        ...(overrides || {}),
    };
}

/** 卡片状态回写：只动 metadata.listen，不动消息本体（镜像 meetingInvite.updateMeetInviteStatus）。 */
async function updateInviteCard(session: MusicListenSession, patch: Partial<ListenInviteCardMeta>): Promise<void> {
    if (typeof session.inviteMessageId !== 'number') return;
    try {
        await DB.updateMessageMetadata(session.inviteMessageId, prev => ({
            ...(prev || {}),
            listen: { ...(prev?.listen || {}), ...patch },
        }));
    } catch (e) {
        console.warn('[Listen] 邀请卡状态回写失败（session 真相源不受影响）:', e);
    }
}

// ─── 查询 ───────────────────────────────────────────────────────────────────

export async function getMusicListenSessionsByChar(charId: string): Promise<MusicListenSession[]> {
    return DB.getMusicListenSessions(charId);
}

export async function getAllMusicListenSessions(): Promise<MusicListenSession[]> {
    return DB.getMusicListenSessions();
}

export async function getActiveMusicListenSessions(): Promise<MusicListenSession[]> {
    const all = await DB.getMusicListenSessions();
    return all.filter(s => s.status === 'active' && typeof s.startedAt === 'number');
}

export async function getActiveMusicListenSessionForChar(charId: string): Promise<MusicListenSession | null> {
    const sessions = await getActiveMusicListenSessions();
    return sessions.find(s => s.charId === charId) || null;
}

function newSessionId(now: number): string {
    return `mls_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// ─── user → char：玩家从 Music App 发起（显式邀请，绕过冷却） ────────────────

export async function createUserListenInvite(args: {
    char: CharacterProfile;
    userName?: string;
    song: MusicListenSessionSongSnapshot;
    now?: number;
}): Promise<{ session: MusicListenSession; messageId: number } | null> {
    const { char, userName, song, now = Date.now() } = args;
    if (!char?.id || !song?.name) return null;
    const existing = await getMusicListenSessionsByChar(char.id);
    if (existing.some(s => s.status === 'active')) return null; // 已在听：不允许重复 active
    if (existing.some(s => s.status === 'pending')) return null; // 已有待回应邀请：不叠加

    let session: MusicListenSession = {
        id: newSessionId(now),
        charId: char.id,
        charName: char.name,
        inviter: 'user',
        status: 'pending',
        songSnapshot: song,
        invitedAt: now,
    };
    const messageId = await DB.saveMessage({
        charId: char.id,
        role: 'user',
        type: 'listen_invite_card',
        content: `[一起听邀请] 《${song.name}》${song.artists ? ` — ${song.artists}` : ''}`,
        metadata: {
            listen: {
                sessionId: session.id,
                inviter: 'user',
                status: 'pending',
                song,
                inviterName: userName || '你',
                invitedAt: now,
            },
        },
    } as Parameters<typeof DB.saveMessage>[0]);
    session = { ...session, inviteMessageId: messageId };
    await putSession(session);
    return { session, messageId };
}

// ─── char 回应 user 邀请：[[MUSIC_LISTEN_RESPONSE:accept|decline]] ──────────

export async function findPendingUserListenSession(charId: string): Promise<MusicListenSession | null> {
    const sessions = await getMusicListenSessionsByChar(charId);
    return sessions.find(s => s.inviter === 'user' && s.status === 'pending') || null;
}

/**
 * 应用角色回应。幂等：session 已不是 pending 时直接返回 null（重复 accept / 无邀请时
 * 均为 no-op，正文不受影响）。accept 才开始计时（pending → active + startedAt = now）。
 */
export async function applyCharacterListenResponse(args: {
    charId: string;
    response: 'accept' | 'decline';
    now?: number;
}): Promise<MusicListenSession | null> {
    const { charId, response, now = Date.now() } = args;
    const pending = await findPendingUserListenSession(charId);
    if (!pending) return null;

    const nextStatus = response === 'accept' ? 'active' : 'declined';
    const updated = await DB.updateMusicListenSession(pending.id, prev => {
        if (!prev || prev.status !== 'pending') return undefined; // 幂等守卫（undefined = no-op）
        if (nextStatus === 'active') {
            return { ...prev, status: 'active', startedAt: now };
        }
        return { ...prev, status: 'declined' };
    });
    if (!updated || updated.status !== nextStatus) return null;

    await updateInviteCard(updated, sessionCardMeta(updated));
    if (updated.status === 'active') {
        __mirror?.addPartner(updated.charId); // 复用现有 listeningTogetherWith
    } // declined：不计时、不加入 listeningTogetherWith
    await putSession(updated);
    return updated;
}

// ─── char → user：角色主动邀请 [[MUSIC_LISTEN_INVITE]]（6h 冷却兜底） ────────

export async function createCharacterListenInvite(args: {
    charId: string;
    charName?: string;
    song: MusicListenSessionSongSnapshot;
    now?: number;
}): Promise<{ session: MusicListenSession; messageId: number } | null> {
    const { charId, charName, song, now = Date.now() } = args;
    if (!charId || !song?.name) return null;
    const existing = await getMusicListenSessionsByChar(charId);
    if (existing.some(s => s.status === 'active')) return null; // 一起听中：不允许
    if (existing.some(s => s.status === 'pending')) return null; // 已有待回应邀请
    if (isCharacterInviteCooldownActive(existing, now)) return null; // 6h 冷却（显式用户邀请不走这里）

    let session: MusicListenSession = {
        id: newSessionId(now),
        charId,
        ...(charName ? { charName } : {}),
        inviter: 'character',
        status: 'pending',
        songSnapshot: song,
        invitedAt: now,
    };
    const messageId = await DB.saveMessage({
        charId,
        role: 'assistant',
        type: 'listen_invite_card',
        content: `[一起听邀请] 《${song.name}》${song.artists ? ` — ${song.artists}` : ''}`,
        metadata: {
            listen: {
                sessionId: session.id,
                inviter: 'character',
                status: 'pending',
                song,
                ...(charName ? { inviterName: charName } : {}),
                invitedAt: now,
            },
        },
    } as Parameters<typeof DB.saveMessage>[0]);
    session = { ...session, inviteMessageId: messageId };
    await putSession(session);
    return { session, messageId };
}

// ─── user 回应 char 邀请：卡片按钮，0 Chat API ─────────────────────────────

export async function userRespondToCharacterInvite(args: {
    sessionId: string;
    accept: boolean;
    now?: number;
}): Promise<MusicListenSession | null> {
    const { sessionId, accept, now = Date.now() } = args;
    const nextStatus = accept ? 'active' : 'declined';
    const updated = await DB.updateMusicListenSession(sessionId, prev => {
        if (!prev || prev.status !== 'pending') return undefined; // 幂等：reopen 不重复执行
        if (nextStatus === 'active') {
            return { ...prev, status: 'active', startedAt: now };
        }
        return { ...prev, status: 'declined' };
    });
    if (!updated || updated.status !== nextStatus) return null;

    await updateInviteCard(updated, sessionCardMeta(updated));
    if (updated.status === 'active') {
        __mirror?.addPartner(updated.charId);
    }
    await putSession(updated);
    return updated;
}

/** legacy 兼容映射：存在 pending 用户邀请时，MUSIC_ACTION:join 等价 accept（无邀请则 no-op）。 */
export const acceptPendingUserListenSession = (charId: string): Promise<MusicListenSession | null> =>
    applyCharacterListenResponse({ charId, response: 'accept' });

// ─── 结束 ───────────────────────────────────────────────────────────────────

/**
 * 结束某 char 的 active session（Music App「结束一起听」/ 卡片 ×）。幂等：只有
 * active → ended 生效，durationSec 一次性写死（endedAt - startedAt）。
 */
export async function endActiveListenSession(charId: string, endReason = 'user_end', now = Date.now()): Promise<MusicListenSession | null> {
    const active = await getActiveMusicListenSessionForChar(charId);
    if (!active) return null;
    const endedAt = now;
    const durationSec = Math.max(0, Math.round((endedAt - (active.startedAt || endedAt)) / 1000));
    const updated = await DB.updateMusicListenSession(active.id, prev => {
        if (!prev || prev.status !== 'active') return undefined; // 幂等守卫：重复 end no-op
        return { ...prev, status: 'ended', endedAt, durationSec, endReason };
    });
    if (!updated || updated.status !== 'ended') return null;

    __mirror?.removePartner(updated.charId); // 从 listeningTogetherWith 移除
    await updateInviteCard(updated, sessionCardMeta(updated));
    await putSession(updated);
    return updated;
}

/**
 * 结束所有 active session（播放失败等致命路径）—— 不留幽灵 active。
 * 普通的暂停 / 切歌 / 离开 Music App 不走这里。
 */
export async function endAllActiveListenSessions(endReason = 'playback_error', now = Date.now()): Promise<number> {
    const actives = await getActiveMusicListenSessions();
    let ended = 0;
    for (const s of actives) {
        const result = await endActiveListenSession(s.charId, endReason, now);
        if (result) ended++;
    }
    return ended;
}

// ─── 统计 ───────────────────────────────────────────────────────────────────

/**
 * 累计一起听时长（秒）：Σ 已结束/中断 session 的 durationSec + 当前 active session 的
 * 实时 elapsed（现算，不写 DB）。declined / 从未开始的 pending 不计入。
 */
export function computeCumulativeListenSec(
    sessions: MusicListenSession[],
    now: number = Date.now(),
): number {
    let total = 0;
    for (const s of sessions) {
        if ((s.status === 'ended' || s.status === 'interrupted') && typeof s.durationSec === 'number') {
            total += s.durationSec;
        } else if (s.status === 'active' && typeof s.startedAt === 'number') {
            total += Math.max(0, Math.round((now - s.startedAt) / 1000));
        }
    }
    return total;
}

export interface CharListenStats {
    charId: string;
    charName?: string;
    cumulativeSec: number;
    activeSession?: MusicListenSession;
    sessions: MusicListenSession[];
}

/** 按角色聚合（记录页用）：累计时长 = 历史求和 + 活跃实时。 */
export function groupListenStatsByChar(
    sessions: MusicListenSession[],
    now: number = Date.now(),
): CharListenStats[] {
    const byChar = new Map<string, MusicListenSession[]>();
    for (const s of sessions) {
        if (!s?.charId) continue;
        const list = byChar.get(s.charId) || [];
        list.push(s);
        byChar.set(s.charId, list);
    }
    const stats: CharListenStats[] = [];
    for (const [charId, list] of byChar) {
        stats.push({
            charId,
            charName: list[list.length - 1]?.charName,
            cumulativeSec: computeCumulativeListenSec(list, now),
            activeSession: list.find(s => s.status === 'active'),
            sessions: [...list].sort((a, b) => (b.invitedAt || 0) - (a.invitedAt || 0)),
        });
    }
    return stats.sort((a, b) => b.cumulativeSec - a.cumulativeSec);
}
