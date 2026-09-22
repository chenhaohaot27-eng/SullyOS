/**
 * listenSessionShared —— 「和 ta 一起听」正式会话的纯逻辑层（Batch B）。
 *
 * 这里不 import DB / React（db.ts 恢复链路要用其中的归一化函数，放进带 DB import 的
 * 模块会成环）。DB 落库动作在 utils/listenSession.ts；类型在 ../types。
 *
 * 协议（复用既有 [[...]] 结构化动作体系，见 meetingInvite / chatParser）：
 *  - 角色主动邀请：`[[MUSIC_LISTEN_INVITE]]`（无参数；歌取自当前播放快照）
 *  - 角色回应玩家邀请：`[[MUSIC_LISTEN_RESPONSE:accept]]` / `[[MUSIC_LISTEN_RESPONSE:decline]]`
 * 标签永远先剥掉再渲染；没有 pending 用户邀请时 response 被静默忽略，绝不凭空建 session。
 */

import type { MusicListenSession, MusicListenSessionSongSnapshot } from '../types';

/** 角色主动邀请的兜底冷却：同一 char 6 小时内最多发一次（显式用户邀请不受此限制）。 */
export const MUSIC_LISTEN_INVITE_COOLDOWN_MS = 6 * 60 * 60 * 1000;

export type MusicListenResponseKind = 'accept' | 'decline';
export type MusicListenCardStatus = MusicListenSession['status'];

const LISTEN_INVITE_TAG_RE = /\[\[MUSIC_LISTEN_INVITE\s*\]\]/gi;
// 容错 accepted/declined 变体（模型偶尔写全称）
const LISTEN_RESPONSE_TAG_RE = /\[\[MUSIC_LISTEN_RESPONSE[:：]\s*(accept|accepted|decline|declined)\s*\]\]/gi;

export interface ListenInviteExtraction {
    found: boolean;
    cleanedContent: string;
}

export function extractListenInviteTag(content: string): ListenInviteExtraction {
    let found = false;
    const cleanedContent = content.replace(LISTEN_INVITE_TAG_RE, () => {
        found = true;
        return '';
    })
        .replace(/\n[ \t]*\n+/g, '\n')
        .trim();
    return { found, cleanedContent };
}

export interface ListenResponseExtraction {
    found: MusicListenResponseKind | null;
    cleanedContent: string;
}

export function extractListenResponseTag(content: string): ListenResponseExtraction {
    let found: MusicListenResponseKind | null = null;
    const cleanedContent = content.replace(LISTEN_RESPONSE_TAG_RE, (_m: string, kind: string) => {
        if (!found) {
            found = (kind === 'decline' || kind === 'declined') ? 'decline' : 'accept';
        }
        return '';
    })
        .replace(/\n[ \t]*\n+/g, '\n')
        .trim();
    return { found, cleanedContent };
}

/**
 * 角色主动邀请冷却：以该 char 最近一次「角色发起」的 session.invitedAt 计。
 * 程序层兜底 —— prompt 层已要求低频，这里再挡掉 6h 内的重复邀请。
 */
export function isCharacterInviteCooldownActive(
    sessions: Pick<MusicListenSession, 'inviter' | 'invitedAt'>[],
    now: number = Date.now(),
    cooldownMs: number = MUSIC_LISTEN_INVITE_COOLDOWN_MS,
): boolean {
    let lastCharInvite = 0;
    for (const s of sessions) {
        if (s?.inviter === 'character' && typeof s.invitedAt === 'number') {
            lastCharInvite = Math.max(lastCharInvite, s.invitedAt);
        }
    }
    return lastCharInvite > 0 && (now - lastCharInvite) < cooldownMs;
}

/**
 * 备份恢复归一化：
 *  - active → interrupted，时长冻结到备份时刻（backupTimestamp），绝不从旧 startedAt 一路计到今天；
 *  - pending 保留 pending —— 恢复后玩家仍可在卡片上回应，但不自动接受 / 自动开始；
 *  - 其余状态原样；不合法记录丢弃。旧备份缺失该字段时调用方直接传 []。
 * 恢复全程 0 次额外 AI 调用、0 次新邀请。
 */
export function normalizeMusicListenSessionsForRestore(
    sessions: MusicListenSession[] | undefined,
    backupTimestamp?: number,
): MusicListenSession[] {
    if (!Array.isArray(sessions)) return [];
    const endAt = typeof backupTimestamp === 'number' && backupTimestamp > 0
        ? backupTimestamp
        : Date.now();
    return sessions
        .filter(s => !!s && typeof s.id === 'string' && typeof s.charId === 'string')
        .map(s => {
            if (s.status === 'active' && typeof s.startedAt === 'number') {
                const durationSec = Math.max(0, Math.round((endAt - s.startedAt) / 1000));
                return {
                    ...s,
                    status: 'interrupted' as const,
                    endedAt: endAt,
                    durationSec,
                    endReason: s.endReason || 'restore_interrupted',
                };
            }
            return s;
        });
}

/** 聊天卡上持久化的邀请负载（metadata.listen）。 */
export interface ListenInviteCardMeta {
    sessionId: string;
    inviter: 'user' | 'character';
    status: MusicListenCardStatus;
    song?: MusicListenSessionSongSnapshot;
    inviterName?: string;
    invitedAt: number;
    startedAt?: number;
    endedAt?: number;
    durationSec?: number;
}

/** mm:ss（活跃计时显示用；只是 UI，不写 DB）。 */
export function formatListenClock(sec: number): string {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
}

/** 「7小时26分」/「42分钟」式的累计时长文案。 */
export function formatListenDuration(totalSec: number): string {
    if (!isFinite(totalSec) || totalSec < 0) totalSec = 0;
    const totalMin = Math.floor(totalSec / 60);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (h > 0) return `${h}小时${m}分`;
    if (totalMin > 0) return `${totalMin}分钟`;
    return '不到1分钟';
}

/**
 * 给模型的「一起听回应协议」：只在存在待回应的玩家→角色邀请时随该条历史注入（短且低 token）。
 * 0 额外 Chat 调用 —— 角色在正常的一轮回复里顺带输出标签。
 */
export function buildListenResponseGuide(): string {
    return `用户刚刚向你发出了「一起听」的邀请（一起听当前正在播放的歌）。你可以根据当前情境、你和对方的关系以及你的性格自行决定：想一起就单独一行输出 \`[[MUSIC_LISTEN_RESPONSE:accept]]\`；不想就输出 \`[[MUSIC_LISTEN_RESPONSE:decline]]\`，并在正文里自然说明原因。无论哪种，正常的说话内容照常保留。接受后你们会进入"一起听"状态：切歌、暂停都不会打断，直到对方在播放器里结束；不用每句话都聊歌，自然就好。`;
}
