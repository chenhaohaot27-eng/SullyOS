import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DB } from './db';
import {
    applyMeetReply,
    buildMeetInviteGuide,
    buildPlayerInviteReplyGuide,
    createUserMeetInvite,
    executeMeetInvite,
    extractMeetReplyIntent,
    findPendingMeetInvitation,
    findPendingUserMeetInvite,
    meetInviteDirection,
    readMeetInvitation,
    type MeetInviteIntent,
} from './meetingInvite';
import { ChatPrompts } from './chatPrompts';

const chatSource = readFileSync(fileURLToPath(new URL('../apps/Chat.tsx', import.meta.url)), 'utf-8');
const inputAreaSource = readFileSync(fileURLToPath(new URL('../components/chat/ChatInputArea.tsx', import.meta.url)), 'utf-8');
const cardSource = readFileSync(fileURLToPath(new URL('../components/chat/MeetingInviteCard.tsx', import.meta.url)), 'utf-8');
const dateAppSource = readFileSync(fileURLToPath(new URL('../apps/DateApp.tsx', import.meta.url)), 'utf-8');
const postSource = readFileSync(fileURLToPath(new URL('./applyAssistantPostProcessing.ts', import.meta.url)), 'utf-8');
const inviteSource = readFileSync(fileURLToPath(new URL('./meetingInvite.ts', import.meta.url)), 'utf-8');

const CHAR = { id: 'c1', name: '祁煜', avatar: '' } as any;
const USER = { name: '阿明', bio: '' } as any;

beforeEach(async () => { await DB.deleteDB(); });
afterEach(() => { vi.resetModules(); });
import { vi } from 'vitest';

const userMeetCard = (id: number, status: string) => ({
    id, charId: 'c1', role: 'user' as const, type: 'meet_card' as const, content: '', timestamp: id,
    metadata: { meet: { id: `mi_${id}`, status, direction: 'user_to_character', initiatorId: 'user', initiatorName: '阿明', participantIds: ['c1'], participantNames: ['祁煜'], invitationText: '想见你。', sceneSeed: 'x', sourceCharId: 'c1', createdAt: id } },
});

describe('玩家发起邀请 — createUserMeetInvite', () => {
    it('写入结构化 meet_card：direction=user_to_character、role=user、附言入 invitationText，刷新可读回', async () => {
        const res = await createUserMeetInvite({ char: CHAR, userName: '阿明', note: '想见你。', persistMessage: m => DB.saveMessage(m) });
        const card = (await DB.getMessagesByCharId('c1', true)).find(m => m.id === res.messageId)!;
        expect(card.type).toBe('meet_card');
        expect(card.role).toBe('user');
        const inv = readMeetInvitation(card)!;
        expect(inv.direction).toBe('user_to_character');
        expect(inv.status).toBe('pending');
        expect(inv.invitationText).toBe('想见你。');
        expect(inv.participantIds).toEqual(['c1']);
        expect(meetInviteDirection(inv)).toBe('user_to_character');
    });

    it('附言可空且超长截断到 200；不调用任何 API（纯 DB 写入）', async () => {
        const noNote = await createUserMeetInvite({ char: CHAR, userName: '阿明', persistMessage: m => DB.saveMessage(m) });
        expect(readMeetInvitation((await DB.getMessagesByCharId('c1', true)).find(m => m.id === noNote.messageId)!)!.invitationText).toBe('');
        const long = await createUserMeetInvite({ char: CHAR, userName: '阿明', note: '长'.repeat(500), persistMessage: m => DB.saveMessage(m) });
        expect(readMeetInvitation((await DB.getMessagesByCharId('c1', true)).find(m => m.id === long.messageId)!)!.invitationText).toHaveLength(200);
        const fnBody = inviteSource.slice(inviteSource.indexOf('export async function createUserMeetInvite'), inviteSource.indexOf('// ─── 角色回应玩家邀请'));
        expect(fnBody).not.toContain('fetch(');
        expect(fnBody).not.toContain('completeChat');
    });

    it('pending 去重：玩家/角色任一方向的 pending 都占用名额', () => {
        expect(findPendingMeetInvitation([userMeetCard(1, 'pending')] as any)).toMatchObject({ id: 1 });
        expect(findPendingMeetInvitation([userMeetCard(1, 'accepted')] as any)).toBeNull();
        expect(findPendingUserMeetInvite([userMeetCard(1, 'pending')] as any)).toMatchObject({ id: 1 });
    });

    it('旧邀请无 direction 默认按角色→玩家解释，历史渲染不炸', async () => {
        const legacy = { id: 'mi_l', status: 'pending', initiatorId: 'c1', initiatorName: '祁煜', participantIds: ['c1'], participantNames: ['祁煜'], invitationText: '下来。', sceneSeed: '楼下', sourceCharId: 'c1', createdAt: 1 };
        expect(meetInviteDirection(legacy as any)).toBe('character_to_user');
        // 旧 pending 不算玩家邀请
        const legacyMsg = { id: 2, charId: 'c1', role: 'assistant', type: 'meet_card', content: '', timestamp: 2, metadata: { meet: legacy } } as any;
        expect(findPendingUserMeetInvite([legacyMsg])).toBeNull();
        expect(findPendingMeetInvitation([legacyMsg])).toMatchObject({ id: 2 });
    });
});

describe('角色回应玩家邀请 — MEET_REPLY', () => {
    it('解析 accepted / declined / deferred 标签并从正文剥离', () => {
        expect(extractMeetReplyIntent('好，等我。[[MEET_REPLY: accepted]]')).toMatchObject({ reply: 'accepted', cleanedContent: '好，等我。' });
        expect(extractMeetReplyIntent('今晚赶不过去。[[MEET_REPLY: declined]]').reply).toBe('declined');
        expect(extractMeetReplyIntent('明晚呢？[[MEET_REPLY: deferred]]').reply).toBe('deferred');
        expect(extractMeetReplyIntent('普通回复，没有标签').reply).toBeNull();
        expect(extractMeetReplyIntent('非法值 [[MEET_REPLY: yes]] 原样保留').cleanedContent).toContain('MEET_REPLY');
    });

    it('applyMeetReply 把角色回应写回玩家 pending 邀请卡；declined 不触发 Date/Story', async () => {
        const created = await createUserMeetInvite({ char: CHAR, userName: '阿明', note: '想见你。', persistMessage: m => DB.saveMessage(m) });
        const messages = await DB.getMessagesByCharId('c1', true);
        const accepted = await applyMeetReply({ reply: 'accepted', messages });
        expect(accepted?.messageId).toBe(created.messageId);
        expect(readMeetInvitation((await DB.getMessagesByCharId('c1', true)).find(m => m.id === created.messageId)!)!.status).toBe('accepted');

        await createUserMeetInvite({ char: CHAR, userName: '阿明', note: '再来一次', persistMessage: m => DB.saveMessage(m) });
        const second = await applyMeetReply({ reply: 'declined', messages: await DB.getMessagesByCharId('c1', true) });
        expect(second).not.toBeNull();
        const declinedCard = readMeetInvitation((await DB.getMessagesByCharId('c1', true)).find(m => m.id === second!.messageId)!)!;
        expect(declinedCard.status).toBe('declined');
        const declinedBranch = cardSource.slice(cardSource.indexOf('婉拒了这次邀请'), cardSource.indexOf('婉拒了这次邀请') + 120);
        expect(declinedBranch).not.toContain('handleEnterSurface');
        expect(declinedBranch).not.toContain('openDateWithChar');
    });

    it('没有待回应玩家邀请时 MEET_REPLY 静默忽略（正文不受影响）', async () => {
        expect(await applyMeetReply({ reply: 'accepted', messages: [] })).toBeNull();
    });
});

describe('历史注入 — 玩家邀请进入主聊天 prompt（压缩短文本）', () => {
    const render = async (meetStatus: string) => {
        const { apiMessages } = ChatPrompts.buildMessageHistory(
            [userMeetCard(1, meetStatus) as any],
            20,
            CHAR,
            USER,
            [],
        );
        return apiMessages.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');
    };

    it('pending 玩家邀请注入邀请短文本 + [[MEET_REPLY]] 回应协议', async () => {
        const text = await render('pending');
        expect(text).toContain('[见面邀请] 用户邀请祁煜见面：「想见你。」');
        expect(text).toContain('[[MEET_REPLY: accepted]]');
        expect(text).toContain('[[MEET_REPLY: declined]]');
        expect(text).toContain('自行决定');
        expect(text).not.toContain('invitationId');
    });

    it('已回应的玩家邀请注入结果短文本', async () => {
        expect(await render('accepted')).toContain('祁煜接受了邀请');
        expect(await render('declined')).toContain('祁煜婉拒了这次邀请');
    });

    it('旧的角色→玩家邀请仍走原 [邀请记录] 渲染', async () => {
        const legacyMsg = { id: 3, charId: 'c1', role: 'assistant', type: 'meet_card', content: '', timestamp: 3, metadata: { meet: { initiatorName: '祁煜', participantNames: ['祁煜'], invitationText: '下来。', status: 'accepted' } } } as any;
        const { apiMessages } = ChatPrompts.buildMessageHistory([legacyMsg], 20, CHAR, USER, []);
        const text = apiMessages.map(m => typeof m.content === 'string' ? m.content : '').join('\n');
        expect(text).toContain('[邀请记录] 祁煜向用户发出了见面邀请');
        expect(text).toContain('已接受');
    });
});

describe('线上→线下硬协议 — prompt 规则', () => {
    it('MEET_INVITE 指南包含硬协议：到达/动身类表达必须先发邀请；想念/询问不需要', () => {
        const guide = buildMeetInviteGuide();
        expect(guide).toContain('线上→线下的硬协议');
        expect(guide).toContain('我到你楼下了');
        expect(guide).toContain('先输出上面的 MEET_INVITE');
        expect(guide).toContain('我想见你');
        expect(guide).toContain('只有真正准备发生物理见面时才用它');
        expect(guide).toContain('[[MEET_INVITE:');
    });

    it('玩家邀请回应协议短小且强调角色自主性与不代叙', () => {
        const guide = buildPlayerInviteReplyGuide();
        expect(guide).toContain('真实的见面邀请');
        expect(guide).toContain('自行决定');
        expect(guide).toContain('不要在聊天正文里描写已经见面');
        expect(guide.length).toBeLessThan(300);
    });

    it('没有关键词正则强拦截', () => {
        for (const banned of [".includes('电梯')", ".includes('楼下'", '/电梯/', '/开门/']) {
            expect(postSource).not.toContain(banned);
            expect(inviteSource).not.toContain(banned);
            expect(chatSource).not.toContain(banned);
            expect(dateAppSource).not.toContain(banned);
        }
    });
});

describe('UI / 路由接线', () => {
    it('私聊「+」菜单出现「邀请见面」入口，点击走 meet-invite 动作', () => {
        expect(inputAreaSource).toContain('邀请见面');
        expect(inputAreaSource).toContain("onPanelAction('meet-invite')");
    });

    it('Chat：pending 拦截重复发送；发送走 createUserMeetInvite 且不调 API', () => {
        const sendFn = chatSource.slice(chatSource.indexOf('const handleSendMeetInvite'), chatSource.indexOf('const handleSendMeetInvite') + 900);
        expect(sendFn).toContain('findPendingMeetInvitation(recent)');
        expect(sendFn).toContain('已有一份待回应的见面邀请');
        expect(sendFn).toContain('createUserMeetInvite');
        expect(sendFn).not.toContain('completeChat');
        expect(sendFn).not.toContain('fetch(');
        expect(chatSource).toContain("case 'meet-invite'");
    });

    it('卡片：玩家邀请 pending 可取消；accepted 出现进入陪伴/进入剧情（携带 surface）', () => {
        expect(cardSource).toContain('取消邀请');
        expect(cardSource).toContain('handleCancelInvite');
        expect(cardSource).toContain('进入陪伴');
        expect(cardSource).toContain('进入剧情');
        expect(cardSource).toContain("handleEnterSurface('companion')");
        expect(cardSource).toContain("handleEnterSurface('story')");
        expect(cardSource).toContain('openDateWithChar(primaryCharId)');
        expect(cardSource).toContain('去见TA');
        expect(cardSource).toContain('婉拒');
    });

    it('DateApp：launch 带 surface 跳过选择层；玩家邀请的陪伴/剧情锚点', () => {
        expect(dateAppSource).toContain('pendingMeetInvite?.surface');
        expect(dateAppSource).toContain('handleMeetInviteChoice(pendingMeetInvite.surface)');
        expect(dateAppSource).toContain("direction === 'user_to_character'");
        expect(dateAppSource).toContain('玩家主动发起见面邀请并已到场');
    });

    it('后处理：MEET_REPLY 剥离并写回；角色主动邀请回归不受影响', () => {
        expect(postSource).toContain('extractMeetReplyIntent(aiContent)');
        expect(postSource).toContain('applyMeetReply({ reply: meetReplyExtraction.reply');
        expect(postSource).toContain('没有待回应的玩家邀请');
        expect(meetInviteDirection({ id: 'x', status: 'pending', initiatorId: 'c1', initiatorName: '祁煜', participantIds: [], participantNames: [], invitationText: '', sceneSeed: '', sourceCharId: 'c1', createdAt: 1 } as any)).toBe('character_to_user');
    });
});


