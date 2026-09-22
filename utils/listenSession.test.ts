/**
 * 「和 ta 一起听」正式会话（Batch B）定向测试。
 *
 * 覆盖：user invite → pending / char accept → active + 计时开始 / char decline → 不计时 /
 * 重复 accept 幂等 / 角色主动邀请 → 玩家接受 / 婉拒 / 6h 冷却 / 显式用户邀请绕过冷却 /
 * active 重复邀请被挡 / 手动结束只写一次 duration / 累计时长求和 /
 * PWA 重开恢复 active runtime 状态 / restore active → interrupted（不留幽灵 active）/
 * backup roundtrip / 标签解析 / prompt 指南注入（0 额外 Chat 调用路径上的纯函数）。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { CharacterProfile, MusicListenSession } from '../types';
import { DB } from './db';
import {
    createUserListenInvite,
    applyCharacterListenResponse,
    acceptPendingUserListenSession,
    createCharacterListenInvite,
    userRespondToCharacterInvite,
    endActiveListenSession,
    endAllActiveListenSessions,
    getActiveMusicListenSessions,
    getMusicListenSessionsByChar,
    computeCumulativeListenSec,
    groupListenStatsByChar,
    registerListenRuntimeMirror,
    LISTEN_SESSIONS_CHANGED_EVENT,
} from './listenSession';
import {
    extractListenInviteTag,
    extractListenResponseTag,
    isCharacterInviteCooldownActive,
    normalizeMusicListenSessionsForRestore,
    buildListenResponseGuide,
    MUSIC_LISTEN_INVITE_COOLDOWN_MS,
} from './listenSessionShared';

const char = (id: string, name = id): CharacterProfile => ({
    id, name,
} as unknown as CharacterProfile);

const song = { id: 42, name: '起风了', artists: '买辣椒也用券', album: 'Album', albumPic: 'https://pic/x.jpg' };

let mirrorLog: string[] = [];

beforeEach(async () => {
    await DB.clearMusicListenSessionsForTest();
    mirrorLog = [];
    registerListenRuntimeMirror({
        addPartner: cid => mirrorLog.push(`+${cid}`),
        removePartner: cid => mirrorLog.push(`-${cid}`),
    });
});

/* __TEST_PART_2__ */
describe('user → char 邀请', () => {
    it('user invite creates pending（不开始计时）', async () => {
        const created = await createUserListenInvite({ char: char('c1', '小满'), song, now: 1000 });
        expect(created).not.toBeNull();
        expect(created!.session.status).toBe('pending');
        expect(created!.session.inviter).toBe('user');
        expect(created!.session.startedAt).toBeUndefined();
        const sessions = await getMusicListenSessionsByChar('c1');
        expect(sessions).toHaveLength(1);
        expect(sessions[0].status).toBe('pending');
    });

    it('char accept → active + 计时开始（startedAt = now）', async () => {
        await createUserListenInvite({ char: char('c1'), song, now: 1000 });
        const applied = await applyCharacterListenResponse({ charId: 'c1', response: 'accept', now: 5000 });
        expect(applied).not.toBeNull();
        expect(applied!.status).toBe('active');
        expect(applied!.startedAt).toBe(5000);
        expect(mirrorLog).toContain('+c1');
    });

    it('char decline → declined，不开始计时、不加入 partner', async () => {
        await createUserListenInvite({ char: char('c1'), song, now: 1000 });
        const applied = await applyCharacterListenResponse({ charId: 'c1', response: 'decline', now: 5000 });
        expect(applied!.status).toBe('declined');
        expect(applied!.startedAt).toBeUndefined();
        expect(mirrorLog).not.toContain('+c1');
        const active = await getActiveMusicListenSessions();
        expect(active).toHaveLength(0);
    });

    it('duplicate accept 幂等（重复 accept / decline 都不再生效）', async () => {
        await createUserListenInvite({ char: char('c1'), song, now: 1000 });
        const first = await applyCharacterListenResponse({ charId: 'c1', response: 'accept', now: 5000 });
        expect(first!.startedAt).toBe(5000);
        const second = await applyCharacterListenResponse({ charId: 'c1', response: 'accept', now: 9000 });
        expect(second).toBeNull(); // 已不是 pending
        const third = await applyCharacterListenResponse({ charId: 'c1', response: 'decline', now: 9500 });
        expect(third).toBeNull();
        const sessions = await getMusicListenSessionsByChar('c1');
        expect(sessions).toHaveLength(1);
        expect(sessions[0].startedAt).toBe(5000); // 计时未被第二次调用重置
    });

    it('没有 pending 用户邀请时 response 被忽略（不凭空建 session）', async () => {
        const applied = await applyCharacterListenResponse({ charId: 'c9', response: 'accept' });
        expect(applied).toBeNull();
        expect(await getMusicListenSessionsByChar('c9')).toHaveLength(0);
    });

    it('active 期间不允许再创建邀请（duplicate invite blocked）', async () => {
        await createUserListenInvite({ char: char('c1'), song, now: 1000 });
        await applyCharacterListenResponse({ charId: 'c1', response: 'accept', now: 2000 });
        const again = await createUserListenInvite({ char: char('c1'), song, now: 3000 });
        expect(again).toBeNull();
        const sessions = await getMusicListenSessionsByChar('c1');
        expect(sessions).toHaveLength(1);
    });

    it('pending 未回应时也不允许叠加第二条邀请', async () => {
        await createUserListenInvite({ char: char('c1'), song, now: 1000 });
        const again = await createUserListenInvite({ char: char('c1'), song, now: 1100 });
        expect(again).toBeNull();
    });
});

/* __TEST_PART_2B__ */
describe('char → user 主动邀请', () => {
    it('character invite → user accept（pending → active + 计时开始）', async () => {
        const created = await createCharacterListenInvite({ charId: 'c2', charName: '阿澈', song, now: 1000 });
        expect(created).not.toBeNull();
        expect(created!.session.status).toBe('pending');
        expect(created!.session.inviter).toBe('character');
        expect(created!.session.startedAt).toBeUndefined(); // 不直接开始计时

        const accepted = await userRespondToCharacterInvite({ sessionId: created!.session.id, accept: true, now: 8000 });
        expect(accepted!.status).toBe('active');
        expect(accepted!.startedAt).toBe(8000);
        expect(mirrorLog).toContain('+c2');
    });

    it('character invite → user decline（不计时、不加入 partner）', async () => {
        const created = await createCharacterListenInvite({ charId: 'c2', song, now: 1000 });
        const declined = await userRespondToCharacterInvite({ sessionId: created!.session.id, accept: false, now: 8000 });
        expect(declined!.status).toBe('declined');
        expect(declined!.startedAt).toBeUndefined();
        expect(mirrorLog).not.toContain('+c2');
    });

    it('重复点击（reopen / 双击）不重复执行动作', async () => {
        const created = await createCharacterListenInvite({ charId: 'c2', song, now: 1000 });
        const first = await userRespondToCharacterInvite({ sessionId: created!.session.id, accept: true, now: 8000 });
        expect(first!.status).toBe('active');
        const second = await userRespondToCharacterInvite({ sessionId: created!.session.id, accept: true, now: 9000 });
        expect(second).toBeNull();
        const third = await userRespondToCharacterInvite({ sessionId: created!.session.id, accept: false, now: 9500 });
        expect(third).toBeNull();
        const sessions = await getMusicListenSessionsByChar('c2');
        expect(sessions[0].startedAt).toBe(8000);
    });

    it('cooldown 6h：角色发起的邀请在 6h 内不能再发', async () => {
        const first = await createCharacterListenInvite({ charId: 'c3', song, now: 1000 });
        expect(first).not.toBeNull();
        const tooSoon = await createCharacterListenInvite({ charId: 'c3', song, now: 1000 + MUSIC_LISTEN_INVITE_COOLDOWN_MS - 1 });
        expect(tooSoon).toBeNull();
        // 玩家婉拒掉第一条（清掉 pending），冷却过了才能再发
        await userRespondToCharacterInvite({ sessionId: first!.session.id, accept: false, now: 1000 + MUSIC_LISTEN_INVITE_COOLDOWN_MS });
        const afterCooldown = await createCharacterListenInvite({ charId: 'c3', song, now: 1000 + MUSIC_LISTEN_INVITE_COOLDOWN_MS + 1 });
        expect(afterCooldown).not.toBeNull();
    });

    it('显式用户邀请不受 cooldown 限制（bypass）', async () => {
        // 角色刚发过邀请（冷却中），玩家婉拒掉它之后再显式邀请同一角色
        await createCharacterListenInvite({ charId: 'c3', song, now: 1000 });
        const sessions = await getMusicListenSessionsByChar('c3');
        await userRespondToCharacterInvite({ sessionId: sessions[0].id, accept: false, now: 2000 });
        const userInvite = await createUserListenInvite({ char: char('c3'), song, now: 3000 });
        expect(userInvite).not.toBeNull(); // 冷却只挡角色主动邀请
    });

    it('isCharacterInviteCooldownActive 只看角色发起的记录', () => {
        const now = 1000_000;
        expect(isCharacterInviteCooldownActive([], now)).toBe(false);
        expect(isCharacterInviteCooldownActive([{ inviter: 'character', invitedAt: now - 1000 }], now)).toBe(true);
        expect(isCharacterInviteCooldownActive([{ inviter: 'user', invitedAt: now - 1000 }], now)).toBe(false);
        expect(isCharacterInviteCooldownActive([{ inviter: 'character', invitedAt: now - MUSIC_LISTEN_INVITE_COOLDOWN_MS - 1 }], now)).toBe(false);
    });
});

/* __TEST_PART_3__ */
describe('结束与时长', () => {
    it('manual end 只写一次 duration（重复 end 幂等）', async () => {
        await createUserListenInvite({ char: char('c1'), song, now: 1000 });
        await applyCharacterListenResponse({ charId: 'c1', response: 'accept', now: 10_000 });
        const ended = await endActiveListenSession('c1', 'user_end', 10_000 + 600_000);
        expect(ended!.status).toBe('ended');
        expect(ended!.durationSec).toBe(600);
        expect(mirrorLog).toContain('-c1');
        const again = await endActiveListenSession('c1', 'user_end', 10_000 + 900_000);
        expect(again).toBeNull();
        const sessions = await getMusicListenSessionsByChar('c1');
        expect(sessions[0].durationSec).toBe(600); // 没被第二次覆盖
    });

    it('pause 语义：session 层不存在任何"暂停结束"路径', async () => {
        await createUserListenInvite({ char: char('c1'), song, now: 1000 });
        await applyCharacterListenResponse({ charId: 'c1', response: 'accept', now: 2000 });
        // （无暂停 API；session 仍 active —— 暂停不结束）
        const active = await getActiveMusicListenSessions();
        expect(active).toHaveLength(1);
    });

    it('播放失败等致命路径 endAllActiveListenSessions 不留幽灵 active', async () => {
        await createUserListenInvite({ char: char('c1'), song, now: 1000 });
        await applyCharacterListenResponse({ charId: 'c1', response: 'accept', now: 2000 });
        await createCharacterListenInvite({ charId: 'c2', song, now: 1500 });
        await userRespondToCharacterInvite({ sessionId: (await getMusicListenSessionsByChar('c2'))[0].id, accept: true, now: 2500 });
        const endedCount = await endAllActiveListenSessions('playback_error', 60_000);
        expect(endedCount).toBe(2);
        expect(await getActiveMusicListenSessions()).toHaveLength(0);
    });

    it('累计时长 = Σ ended.durationSec + 当前 active 实时 elapsed', () => {
        const sessions: MusicListenSession[] = [
            { id: 'a', charId: 'c1', inviter: 'user', status: 'ended', invitedAt: 1, startedAt: 2, endedAt: 3, durationSec: 3600 },
            { id: 'b', charId: 'c1', inviter: 'user', status: 'interrupted', invitedAt: 1, startedAt: 2, endedAt: 3, durationSec: 600 },
            { id: 'c', charId: 'c1', inviter: 'user', status: 'active', invitedAt: 1, startedAt: 10_000 },
            { id: 'd', charId: 'c1', inviter: 'user', status: 'declined', invitedAt: 1 },
        ];
        const now = 10_000 + 120_000;
        expect(computeCumulativeListenSec(sessions, now)).toBe(3600 + 600 + 120);
        const stats = groupListenStatsByChar(sessions, now);
        expect(stats).toHaveLength(1);
        expect(stats[0].cumulativeSec).toBe(3600 + 600 + 120);
        expect(stats[0].activeSession?.id).toBe('c');
    });

    it('切歌不结束 session：session 层无切歌钩子，active 保持且不重新计时', async () => {
        await createUserListenInvite({ char: char('c1'), song, now: 1000 });
        await applyCharacterListenResponse({ charId: 'c1', response: 'accept', now: 2000 });
        // （换歌不会调用任何 listenSession API；模拟"换歌后什么都没发生"）
        const active = await getActiveMusicListenSessions();
        expect(active).toHaveLength(1);
        expect(active[0].startedAt).toBe(2000); // 没有重新计时
    });
});

describe('runtime mirror 恢复（PWA 重开）', () => {
    it('getActiveMusicListenSessions 是 Provider mount 恢复 mirror 的数据源', async () => {
        await createUserListenInvite({ char: char('c1'), song, now: 1000 });
        await applyCharacterListenResponse({ charId: 'c1', response: 'accept', now: 2000 });
        await createUserListenInvite({ char: char('c2'), song, now: 1500 });
        await applyCharacterListenResponse({ charId: 'c2', response: 'decline', now: 2500 });
        const actives = await getActiveMusicListenSessions();
        // "重开"：mirror 只恢复 active session 对应的 char
        expect(actives.map(s => s.charId).sort()).toEqual(['c1']);
    });

    it('session 变化会广播事件（Provider 据此重算 mirror）', async () => {
        // Node 测试环境没有 window —— 用 EventTarget 顶一只（模块侧 typeof window 守卫会认它）
        const hadWindow = typeof (globalThis as any).window !== 'undefined';
        const stub = new EventTarget();
        if (!hadWindow) (globalThis as any).window = stub;
        let fired = 0;
        const handler = () => { fired++; };
        window.addEventListener(LISTEN_SESSIONS_CHANGED_EVENT, handler);
        try {
            await createUserListenInvite({ char: char('c1'), song, now: 1000 });
            await applyCharacterListenResponse({ charId: 'c1', response: 'accept', now: 2000 });
            expect(fired).toBeGreaterThanOrEqual(2);
        } finally {
            window.removeEventListener(LISTEN_SESSIONS_CHANGED_EVENT, handler);
            if (!hadWindow) delete (globalThis as any).window;
        }
    });
});

describe('legacy MUSIC_ACTION:join 兼容映射', () => {
    it('存在 pending 用户邀请时 join 等价 accept', async () => {
        await createUserListenInvite({ char: char('c1'), song, now: 1000 });
        const applied = await acceptPendingUserListenSession('c1');
        expect(applied!.status).toBe('active');
    });

    it('没有邀请时 join 映射是 no-op', async () => {
        expect(await acceptPendingUserListenSession('nobody')).toBeNull();
    });
});

/* __TEST_PART_4__ */
describe('backup / restore', () => {
    it('restore: active → interrupted，时长冻结到备份时刻（不留幽灵 active、不计到今天）', () => {
        const backupAt = 1_700_000_000_000;
        const started = backupAt - 3600_000;
        const restored = normalizeMusicListenSessionsForRestore([
            { id: 'a', charId: 'c1', inviter: 'user', status: 'active', invitedAt: started - 1000, startedAt: started },
            { id: 'b', charId: 'c2', inviter: 'user', status: 'pending', invitedAt: started },
            { id: 'c', charId: 'c3', inviter: 'user', status: 'ended', invitedAt: 1, startedAt: 2, endedAt: 3, durationSec: 60 },
        ], backupAt);
        expect(restored[0].status).toBe('interrupted');
        expect(restored[0].durationSec).toBe(3600);
        expect(restored[0].endedAt).toBe(backupAt);
        expect(restored[1].status).toBe('pending'); // pending 原样（不自动接受）
        expect(restored[2].status).toBe('ended');
        // 空输入 / 旧备份缺失字段
        expect(normalizeMusicListenSessionsForRestore(undefined, backupAt)).toEqual([]);
    });

    it('backup roundtrip：exportFullData 带 musicListenSessions，import 后状态正确', async () => {
        await createUserListenInvite({ char: char('c1'), song, now: 1000 });
        await applyCharacterListenResponse({ charId: 'c1', response: 'accept', now: 2000 });
        await createCharacterListenInvite({ charId: 'c2', song, now: 1500 });

        const backup = await DB.exportFullData();
        expect(Array.isArray((backup as any).musicListenSessions)).toBe(true);
        expect((backup as any).musicListenSessions.length).toBe(2);

        // 模拟"恢复到另一台设备"：清掉本库再导入（active → interrupted）
        await DB.clearMusicListenSessionsForTest();
        expect(await getMusicListenSessionsByChar('c1')).toHaveLength(0);
        await DB.importFullData(backup as any);
        const after = [
            ...(await getMusicListenSessionsByChar('c1')),
            ...(await getMusicListenSessionsByChar('c2')),
        ];
        const c1 = after.find(s => s.charId === 'c1')!;
        const c2 = after.find(s => s.charId === 'c2')!;
        expect(c1.status).toBe('interrupted'); // 不留幽灵 active
        expect(typeof c1.durationSec).toBe('number');
        expect(c2.status).toBe('pending'); // pending 不自动接受
        expect(await getActiveMusicListenSessions()).toHaveLength(0); // 恢复不产生 active
    });

    it('旧备份缺失 musicListenSessions → 恢复为空（不抛错）', async () => {
        const oldBackup: any = { timestamp: Date.now(), version: 1 };
        delete oldBackup.musicListenSessions;
        await DB.importFullData(oldBackup);
        expect(await getMusicListenSessionsByChar('c1')).toHaveLength(0);
    });
});

describe('标签解析与 prompt 指南', () => {
    it('extractListenInviteTag 剥掉 [[MUSIC_LISTEN_INVITE]]', () => {
        const out = extractListenInviteTag('一起听吧！\n[[MUSIC_LISTEN_INVITE]]\n之后继续说');
        expect(out.found).toBe(true);
        expect(out.cleanedContent).not.toContain('MUSIC_LISTEN_INVITE');
        expect(out.cleanedContent).toContain('一起听吧');
        const none = extractListenInviteTag('普通回复');
        expect(none.found).toBe(false);
    });

    it('extractListenResponseTag 解析 accept / decline（含 accepted/declined 容错）', () => {
        expect(extractListenResponseTag('好呀\n[[MUSIC_LISTEN_RESPONSE:accept]]').found).toBe('accept');
        expect(extractListenResponseTag('不了\n[[MUSIC_LISTEN_RESPONSE:decline]]').found).toBe('decline');
        expect(extractListenResponseTag('[[MUSIC_LISTEN_RESPONSE:accepted]]').found).toBe('accept');
        expect(extractListenResponseTag('普通回复').found).toBeNull();
        const out = extractListenResponseTag('a[[MUSIC_LISTEN_RESPONSE:accept]]b');
        expect(out.cleanedContent).toBe('ab');
    });

    it('buildListenResponseGuide 教模型输出回应标签（0 额外 Chat 调用路径）', () => {
        const guide = buildListenResponseGuide();
        expect(guide).toContain('[[MUSIC_LISTEN_RESPONSE:accept]]');
        expect(guide).toContain('[[MUSIC_LISTEN_RESPONSE:decline]]');
    });
});

