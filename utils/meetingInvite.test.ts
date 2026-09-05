import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DB } from './db';
import {
    buildMeetInviteGuide,
    executeMeetInvite,
    extractMeetInviteIntent,
    meetingInviteLaunch,
    readMeetInvitation,
    resolveMeetIdentity,
    updateMeetInviteStatus,
    type MeetInviteIntent,
} from './meetingInvite';

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
