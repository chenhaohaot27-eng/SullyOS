import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DB } from './db';
import {
    buildMeetInviteGuide,
    executeMeetInvite,
    extractMeetInviteIntent,
    findPendingMeetInvitation,
    meetingInviteLaunch,
    parseMeetTimestamp,
    readMeetInvitation,
    resolveMeetIdentity,
    updateMeetInviteStatus,
    validateMeetInviteTiming,
    type MeetInviteIntent,
} from './meetingInvite';

const applyPostSource = readFileSync(
    fileURLToPath(new URL('./applyAssistantPostProcessing.ts', import.meta.url)),
    'utf-8',
);
const cardSource = readFileSync(
    fileURLToPath(new URL('../components/chat/MeetingInviteCard.tsx', import.meta.url)),
    'utf-8',
);

const CHAR = { id: 'c1', name: '小星', avatar: 'data:image/png;base64,x' } as any;
const OTHER = { id: 'c2', name: '阿月', avatar: '' } as any;
const CHARS = [CHAR, OTHER];

const VALID = JSON.stringify({
    initiatorName: '小星',
    participantNames: ['小星'],
    invitationText: '下来，我在楼下。',
    locationText: '宿舍楼下',
    timeText: '现在',
    sceneSeed: '角色在宿舍楼下等玩家，下着小雨，带了伞。',
    contextSummary: '玩家刚结束组会，还在实验室，没吃晚饭。',
});

beforeEach(async () => {
    await DB.deleteDB();
});

afterEach(() => {
    vi.restoreAllMocks();
    meetingInviteLaunch.consume();
});

describe('extractMeetInviteIntent — 解析', () => {
    const TAG = (p: string) => `[[MEET_INVITE: ${p}]]`;

    it('合法标签：白名单字段解析 + 正文剥离', () => {
        const out = extractMeetInviteIntent(`今晚有空吗？\n${TAG(VALID)}`);
        expect(out.intent).toMatchObject({
            initiatorName: '小星',
            participantNames: ['小星'],
            invitationText: '下来，我在楼下。',
            locationText: '宿舍楼下',
            timeText: '现在',
        });
        expect(out.intent!.sceneSeed).toContain('宿舍楼下等玩家');
        expect(out.cleanedContent).toBe('今晚有空吗？');
        expect(out.cleanedContent).not.toContain('MEET_INVITE');
    });

    it('超短正文（"下来。"）合法；缺 invitationText / sceneSeed / initiatorName 作废', () => {
        const short = JSON.stringify({ initiatorName: '小星', participantNames: ['小星'], invitationText: '下来。', sceneSeed: '楼下' });
        expect(extractMeetInviteIntent(TAG(short)).intent?.invitationText).toBe('下来。');
        expect(extractMeetInviteIntent(TAG(JSON.stringify({ initiatorName: '小星', sceneSeed: 'x' }))).intent).toBeNull();
        expect(extractMeetInviteIntent(TAG(JSON.stringify({ initiatorName: '小星', invitationText: 'x' }))).intent).toBeNull();
        expect(extractMeetInviteIntent(TAG(JSON.stringify({ invitationText: 'x', sceneSeed: 'y' }))).intent).toBeNull();
    });

    it('非法 JSON：作废但标签仍剥掉', () => {
        const bad = extractMeetInviteIntent(`话\n${TAG('not json')}`);
        expect(bad.intent).toBeNull();
        expect(bad.invalidTagFound).toBe(true);
        expect(bad.cleanedContent).toBe('话');
    });

    it('participantNames 缺省回退 [initiator]；多名字全保留；超长截断', () => {
        const solo = extractMeetInviteIntent(TAG(JSON.stringify({ initiatorName: '小星', invitationText: 'x', sceneSeed: 'y' })));
        expect(solo.intent!.participantNames).toEqual(['小星']);
        const multi = extractMeetInviteIntent(TAG(JSON.stringify({
            initiatorName: '小星', participantNames: ['阿月', '小星', 'NPC丙'], invitationText: 'x', sceneSeed: 'y',
        })));
        expect(multi.intent!.participantNames).toEqual(['阿月', '小星', 'NPC丙']);
        const long = extractMeetInviteIntent(TAG(JSON.stringify({
            initiatorName: '小星', invitationText: '很'.repeat(1000), sceneSeed: '种'.repeat(1000),
        })));
        expect(long.intent!.invitationText.length).toBe(300);
        expect(long.intent!.sceneSeed.length).toBe(600);
    });

    it('多标签只认第一个合法的；locationText/timeText 缺省 undefined', () => {
        const second = JSON.stringify({ initiatorName: '阿月', participantNames: ['阿月'], invitationText: 'b', sceneSeed: 's' });
        const out = extractMeetInviteIntent(`话\n${TAG(VALID)}\n中间\n${TAG(second)}`);
        expect(out.intent!.initiatorName).toBe('小星');
        expect(out.cleanedContent).toBe('话\n中间');
        const minimal = extractMeetInviteIntent(TAG(JSON.stringify({ initiatorName: '小星', invitationText: 'x', sceneSeed: 'y' })));
        expect(minimal.intent!.locationText).toBeUndefined();
        expect(minimal.intent!.timeText).toBeUndefined();
        expect(minimal.intent!.contextSummary).toBeUndefined();
    });

    it('指南包含协议、玩家自主权与多角色说明', () => {
        const g = buildMeetInviteGuide();
        expect(g).toContain('MEET_INVITE');
        expect(g).toContain('participantNames');
        expect(g).toContain('不要接着描写对方已经答应');
        expect(g).toContain('替别人传话');
    });
});

describe('resolveMeetIdentity — 身份解析', () => {
    it('self / 角色名 / 注册表命中 / NPC slug', () => {
        expect(resolveMeetIdentity('self', CHARS, CHAR)).toMatchObject({ id: 'c1', registered: true });
        expect(resolveMeetIdentity('小星', CHARS, CHAR).id).toBe('c1');
        expect(resolveMeetIdentity('阿月', CHARS, CHAR)).toMatchObject({ id: 'c2', registered: true });
        const npc = resolveMeetIdentity('神秘商人', CHARS, CHAR);
        expect(npc.registered).toBe(false);
        expect(npc.id).toBe('npc:神秘商人');
        expect(npc.name).toBe('神秘商人');
    });
});

describe('executeMeetInvite — 落卡与状态', () => {
    const intentOf = (over: Partial<MeetInviteIntent> = {}): MeetInviteIntent => ({
        initiatorName: '小星',
        participantNames: ['小星'],
        invitationText: '下来，我在楼下。',
        sceneSeed: '角色在楼下等玩家。',
        ...over,
    });

    it('主角自己邀请：meet_card 消息 + 全量 metadata；刷新后可读回', async () => {
        const res = await executeMeetInvite({ intent: intentOf(), char: CHAR, characters: CHARS, persistMessage: m => DB.saveMessage(m) });
        expect(res.messageId).toBeGreaterThan(0);
        const card = (await DB.getMessagesByCharId('c1', true)).find(m => m.id === res.messageId)!;
        expect(card.type).toBe('meet_card');
        expect(card.role).toBe('assistant');
        const inv = readMeetInvitation(card)!;
        expect(inv.initiatorId).toBe('c1');
        expect(inv.initiatorName).toBe('小星');
        expect(inv.status).toBe('pending');
        expect(inv.sceneSeed).toBe('角色在楼下等玩家。');
        expect(inv.sourceCharId).toBe('c1');
    });

    it('NPC 代其他角色邀请 + 多 participant：initiator 与 participants 独立', async () => {
        const res = await executeMeetInvite({
            intent: intentOf({ initiatorName: '传达室大爷', participantNames: ['阿月', '小星', '神秘NPC'] }),
            char: CHAR,
            characters: CHARS,
            persistMessage: m => DB.saveMessage(m),
        });
        expect(res.invitation.initiatorId).toBe('npc:传达室大爷');
        expect(res.invitation.initiatorName).toBe('传达室大爷');
        expect(res.invitation.participantIds).toEqual(['c2', 'c1', 'npc:神秘NPC']);
        expect(res.invitation.participantNames).toEqual(['阿月', '小星', '神秘NPC']);
    });

    it('稍后 → deferred；接受 → accepted；只改 status 不动其它字段', async () => {
        const res = await executeMeetInvite({ intent: intentOf(), char: CHAR, persistMessage: m => DB.saveMessage(m) });
        await updateMeetInviteStatus(res.messageId, 'deferred');
        let inv = readMeetInvitation((await DB.getMessagesByCharId('c1', true)).find(m => m.id === res.messageId)!)!;
        expect(inv.status).toBe('deferred');
        expect(inv.invitationText).toBe('下来，我在楼下。');
        await updateMeetInviteStatus(res.messageId, 'accepted');
        inv = readMeetInvitation((await DB.getMessagesByCharId('c1', true)).find(m => m.id === res.messageId)!)!;
        expect(inv.status).toBe('accepted');
    });

    it('旧消息（无 meet 字段）readMeetInvitation → null，不炸', async () => {
        const id = await DB.saveMessage({ charId: 'c1', role: 'user', type: 'text', content: '旧消息', timestamp: 1 });
        const msg = (await DB.getMessagesByCharId('c1', true)).find(m => m.id === id)!;
        expect(readMeetInvitation(msg)).toBeNull();
    });
});

describe('meetingInviteLaunch — 跳转意图', () => {
    it('request → peek/consume 一次；consume 后为空', () => {
        expect(meetingInviteLaunch.peek()).toBeNull();
        const inv = { id: 'mi_1', status: 'accepted' as const, initiatorId: 'c1', initiatorName: '小星', participantIds: ['c1'], participantNames: ['小星'], invitationText: 'x', sceneSeed: 'y', sourceCharId: 'c1', createdAt: 1 };
        meetingInviteLaunch.request({ invitation: inv, primaryCharId: 'c1', participantsText: '小星' });
        expect(meetingInviteLaunch.peek()?.invitation.id).toBe('mi_1');
        expect(meetingInviteLaunch.consume()?.primaryCharId).toBe('c1');
        expect(meetingInviteLaunch.peek()).toBeNull();
    });
});

describe('parseMeetTimestamp — 时间解析', () => {
    it('接受 ISO 与 YYYY-MM-DD HH:mm，拒绝垃圾值', () => {
        expect(parseMeetTimestamp('2026-09-09 15:30')).toBe('2026-09-09T15:30');
        expect(parseMeetTimestamp('2026-09-09T15:30:00')).toBe('2026-09-09T15:30:00');
        expect(parseMeetTimestamp('2026-09-09')).toBe('2026-09-09');
        expect(parseMeetTimestamp('明天下午')).toBeNull();
        expect(parseMeetTimestamp('')).toBeNull();
        expect(parseMeetTimestamp(123)).toBeNull();
    });

    it('标签解析携带 meetingMode / scheduledAt / earliestFeasibleAt；坏时间被丢弃', () => {
        const TAG = (p: string) => `[[MEET_INVITE: ${p}]]`;
        const good = extractMeetInviteIntent(TAG(JSON.stringify({
            initiatorName: '小星', participantNames: ['小星'], invitationText: '周五晚上给我留着。',
            meetingMode: 'scheduled', scheduledAt: '2026-09-11 19:00', earliestFeasibleAt: '2026-09-11 18:00',
            sceneSeed: '周五晚上角色抵达上海。',
        })));
        expect(good.intent).toMatchObject({
            meetingMode: 'scheduled',
            scheduledAt: '2026-09-11T19:00',
            earliestFeasibleAt: '2026-09-11T18:00',
        });
        // 无显式 mode 但带合法 scheduledAt → 推断 scheduled
        const inferred = extractMeetInviteIntent(TAG(JSON.stringify({
            initiatorName: '小星', invitationText: 'x', sceneSeed: 'y', scheduledAt: '2030-01-01 10:00',
        })));
        expect(inferred.intent!.meetingMode).toBe('scheduled');
        // 坏 scheduledAt 丢弃（落卡前由 timing guard 拦下）
        const bad = extractMeetInviteIntent(TAG(JSON.stringify({
            initiatorName: '小星', invitationText: 'x', sceneSeed: 'y', meetingMode: 'scheduled', scheduledAt: '周五傍晚',
        })));
        expect(bad.intent!.scheduledAt).toBeUndefined();
        // 老格式（无任何新字段）不受影响
        const legacy = extractMeetInviteIntent(TAG(JSON.stringify({ initiatorName: '小星', invitationText: '下来。', sceneSeed: '楼下' })));
        expect(legacy.intent!.meetingMode).toBe('immediate');
        expect(legacy.intent!.scheduledAt).toBeUndefined();
    });
});

describe('validateMeetInviteTiming — 前端轻量 feasibility', () => {
    const NOW = Date.parse('2026-09-08T21:30:00');
    const intentOf = (over: Partial<MeetInviteIntent> = {}): MeetInviteIntent => ({
        initiatorName: '小星', participantNames: ['小星'], invitationText: 'x', sceneSeed: 'y', ...over,
    });

    it('immediate 通过（无结构化地点状态，跨城判断交给 prompt 规则）', () => {
        expect(validateMeetInviteTiming(intentOf({ meetingMode: 'immediate' }), NOW)).toEqual({ ok: true });
    });

    it('scheduled 缺 scheduledAt → reject', () => {
        expect(validateMeetInviteTiming(intentOf({ meetingMode: 'scheduled' }), NOW))
            .toEqual({ ok: false, reason: 'scheduled_at_missing' });
    });

    it('scheduledAt 在当前时间之前 → reject', () => {
        expect(validateMeetInviteTiming(intentOf({ meetingMode: 'scheduled', scheduledAt: '2026-09-08 20:00' }), NOW))
            .toEqual({ ok: false, reason: 'scheduled_at_in_past' });
    });

    it('scheduledAt 早于 earliestFeasibleAt → reject；不早于则通过', () => {
        expect(validateMeetInviteTiming(intentOf({ meetingMode: 'scheduled', scheduledAt: '2026-09-09 13:00', earliestFeasibleAt: '2026-09-09 14:30' }), NOW))
            .toEqual({ ok: false, reason: 'scheduled_before_earliest_feasible' });
        expect(validateMeetInviteTiming(intentOf({ meetingMode: 'scheduled', scheduledAt: '2026-09-09 15:30', earliestFeasibleAt: '2026-09-09 14:30' }), NOW))
            .toEqual({ ok: true });
    });

    it('prompt 指南包含物理连续性 / meetingMode / 不编造位置 / 刚婉拒不重发等规则', () => {
        const guide = buildMeetInviteGuide();
        expect(guide).toContain('meetingMode');
        expect(guide).toContain('scheduledAt');
        expect(guide).toContain('earliestFeasibleAt');
        expect(guide).toContain('瞬移');
        expect(guide).toContain('不要发 immediate 邀请');
        expect(guide).toContain('编造对方的精确位置');
        expect(guide).toContain('再发新邀请');
    });
});

describe('findPendingMeetInvitation — pending 去重', () => {
    const meetMsg = (id: number, status: string) => ({
        id, charId: 'c1', role: 'assistant' as const, type: 'meet_card' as const, content: '', timestamp: id,
        metadata: { meet: { id: `mi_${id}`, status, initiatorId: 'c1', participantIds: ['c1'], invitationText: 'x', sceneSeed: 'y', sourceCharId: 'c1', createdAt: id } },
    });

    it('已有 pending → 命中；accepted/declined/无卡 → null', () => {
        expect(findPendingMeetInvitation([meetMsg(1, 'accepted'), meetMsg(2, 'pending')] as any)).toMatchObject({ id: 2 });
        expect(findPendingMeetInvitation([meetMsg(1, 'declined'), meetMsg(2, 'accepted')] as any)).toBeNull();
        expect(findPendingMeetInvitation([{ id: 3, charId: 'c1', role: 'user', type: 'text', content: '旧消息', timestamp: 3 }] as any)).toBeNull();
    });
});

describe('scheduled 邀请持久化与婉拒 — Phase 1 delta', () => {
    it('meetingMode/scheduledAt/earliestFeasibleAt 落卡后刷新读回不丢', async () => {
        const res = await executeMeetInvite({
            intent: {
                initiatorName: '小星', participantNames: ['小星'], invitationText: '周五晚上给我留着。',
                meetingMode: 'scheduled', scheduledAt: '2030-01-01T19:00', earliestFeasibleAt: '2030-01-01T18:00',
                locationText: '上海 外滩', sceneSeed: '角色出差结束后抵达上海。',
            },
            char: CHAR,
            characters: CHARS,
            persistMessage: m => DB.saveMessage(m),
        });
        const card = (await DB.getMessagesByCharId('c1', true)).find(m => m.id === res.messageId)!;
        const inv = readMeetInvitation(card)!;
        expect(inv.meetingMode).toBe('scheduled');
        expect(inv.scheduledAt).toBe('2030-01-01T19:00');
        expect(inv.earliestFeasibleAt).toBe('2030-01-01T18:00');
        expect(inv.locationText).toBe('上海 外滩');
    });

    it('婉拒 → declined + resolvedAt 持久化；刷新后仍是 declined', async () => {
        const res = await executeMeetInvite({ intent: {
            initiatorName: '小星', participantNames: ['小星'], invitationText: '下来。', sceneSeed: '楼下',
        }, char: CHAR, persistMessage: m => DB.saveMessage(m) });
        await updateMeetInviteStatus(res.messageId, 'declined');
        const inv = readMeetInvitation((await DB.getMessagesByCharId('c1', true)).find(m => m.id === res.messageId)!)!;
        expect(inv.status).toBe('declined');
        expect(typeof inv.resolvedAt).toBe('number');
    });

    it('历史渲染层：chatPrompts 把 declined 译成「已婉拒」供下一轮模型感知', () => {
        const chatPromptsSource = readFileSync(fileURLToPath(new URL('./chatPrompts.ts', import.meta.url)), 'utf-8');
        expect(chatPromptsSource).toContain("'declined' ? '已婉拒'");
    });

    it('接线：后处理层有 timing guard + pending 去重；卡片有婉拒按钮与 scheduled 展示', () => {
        expect(applyPostSource).toContain('validateMeetInviteTiming(meetInviteExtraction.intent)');
        expect(applyPostSource).toContain('findPendingMeetInvitation(recentMessages)');
        expect(cardSource).toContain('婉拒');
        expect(cardSource).toContain('handleDecline');
        expect(cardSource).toContain("invitation.meetingMode === 'scheduled' ? '约好时间' : '现在见面'");
        expect(cardSource).toContain('formatScheduleText(invitation.scheduledAt)');
    });
});
