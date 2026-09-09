import { describe, expect, it } from 'vitest';
import { DatePrompts } from './datePrompts';
import type { CharacterProfile, UserProfile, Message, MountedWorldbook } from '../types';

const book = (overrides: Partial<MountedWorldbook> = {}): MountedWorldbook => ({
    id: 'wb-' + Math.random().toString(36).slice(2, 8),
    title: '测试条目',
    content: '占位正文。',
    category: '测试',
    ...overrides,
});

const makeChar = (books: MountedWorldbook[], overrides: Partial<CharacterProfile> = {}): CharacterProfile => ({
    id: 'char-1', name: '小白', avatar: '', description: '',
    systemPrompt: '你是小白。', memories: [], mountedWorldbooks: books,
    ...overrides,
} as CharacterProfile);

const user: UserProfile = { name: '阿明', bio: '' } as UserProfile;

let msgId = 1;
const makeMsg = (content: string, role: 'user' | 'assistant' = 'user'): Message => ({
    id: msgId++, charId: 'char-1', role, type: 'text', content, timestamp: Date.now(),
} as Message);

const baseInput = (char: CharacterProfile, allMsgs: Message[], userText = '我过来啦') => ({
    char, userProfile: user, allMsgs, emojis: [], userText, variant: 'send' as const,
});

const sysOf = (messages: Array<{ role: string; content: any }>): string => {
    const sys = messages.find(m => m.role === 'system');
    return typeof sys?.content === 'string' ? sys.content : '';
};

describe('陪伴世界书 — buildSessionPayload 激活语义', () => {
    it('constant 条目继续生效；本轮玩家输入触发关键词条目', async () => {
        const char = makeChar([
            book({ id: 'wb-c', content: '小白永远喜欢喝热可可。', key: [] }),
            book({ id: 'wb-k', content: '下雨时小白会收起伞递给对方。', constant: false, key: ['下雨'] }),
        ]);
        const { messages } = await DatePrompts.buildSessionPayload(baseInput(char, [makeMsg('今天怎么样？'), makeMsg('还行，刚出门。', 'assistant')], '外面开始下雨了'));
        const sys = sysOf(messages);
        expect(sys).toContain('小白永远喜欢喝热可可。');
        expect(sys).toContain('下雨时小白会收起伞递给对方。');
    });

    it('不匹配关键词时条目不注入（自然失活）', async () => {
        const char = makeChar([book({ id: 'wb-k', content: '下雨时小白会收起伞递给对方。', constant: false, key: ['下雨'] })]);
        const { messages } = await DatePrompts.buildSessionPayload(baseInput(char, [makeMsg('今天好晒。')], '我们走这边吧'));
        expect(sysOf(messages)).not.toContain('下雨时小白会收起伞');
    });

    it('scanDepth 生效：关键词只在窗口外旧消息时不激活', async () => {
        const char = makeChar([book({ id: 'wb-d', content: '提及旧伞局时生效。', constant: false, key: ['雨伞'], scanDepth: 2 })]);
        const history = [makeMsg('我买了把雨伞'), makeMsg('哦？'), makeMsg('然后呢'), makeMsg('没什么'), makeMsg('走吧'), makeMsg('嗯')];
        const far = await DatePrompts.buildSessionPayload(baseInput(char, history, '到了没'));
        expect(sysOf(far.messages)).not.toContain('提及旧伞局');
        const near = await DatePrompts.buildSessionPayload(baseInput(char, history, '我把雨伞带上了'));
        expect(sysOf(near.messages)).toContain('提及旧伞局');
    });

    it('disabled 条目不注入；selective / keysecondary 语义保持既有规则', async () => {
        const char = makeChar([
            book({ id: 'wb-off', content: '被禁用的正文。', constant: false, key: ['下雨'], disable: true }),
            book({
                id: 'wb-sel', content: '学校场景规则正文。', constant: false, key: ['学校'],
                selective: true, keysecondary: ['老师'], selectiveLogic: 0,
            }),
        ]);
        const { messages } = await DatePrompts.buildSessionPayload(baseInput(char, [makeMsg('x')], '我们去的学校里有老师也有同学'));
        const sys = sysOf(messages);
        expect(sys).not.toContain('被禁用的正文');
        expect(sys).toContain('学校场景规则正文');
        const noSecondary = await DatePrompts.buildSessionPayload(baseInput(char, [makeMsg('x')], '我们去的学校空空的'));
        expect(sysOf(noSecondary.messages)).not.toContain('学校场景规则正文');
    });

    it('{{char}} / {{user}} 宏正常展开', async () => {
        const char = makeChar([book({ id: 'wb-m', content: '{{char}} 会在 {{user}} 面前脸红。', constant: false, key: ['见面'] })]);
        const { messages } = await DatePrompts.buildSessionPayload(baseInput(char, [makeMsg('x')], '我们见面了'));
        const sys = sysOf(messages);
        expect(sys).toContain('小白 会在 阿明 面前脸红。');
        expect(sys).not.toContain('{{char}}');
        expect(sys).not.toContain('{{user}}');
    });
});

describe('陪伴世界书 — 位置 / 深度 / 去重 / 边界', () => {
    it('position 2 / 3 进入作者注释位置（system 内、VN 规则附近）', async () => {
        const char = makeChar([
            book({ id: 'wb-an2', content: '文风：克制的短句。', constant: false, key: ['见面'], position: 2 }),
            book({ id: 'wb-an3', content: '节奏：结尾留半拍。', constant: false, key: ['见面'], position: 3 }),
        ]);
        const { messages } = await DatePrompts.buildSessionPayload(baseInput(char, [makeMsg('x')], '我们见面了'));
        const sys = sysOf(messages);
        expect(sys).toContain('世界书 · 作者注释顶部');
        expect(sys).toContain('文风：克制的短句。');
        expect(sys).toContain('世界书 · 作者注释底部');
        expect(sys).toContain('节奏：结尾留半拍。');
    });

    it('position 4 按 depth/role 插入历史消息数组，不拼进巨型 system', async () => {
        const char = makeChar([
            book({ id: 'wb-d4', content: 'AT_DEPTH_MARKER_下三层规则', constant: false, key: ['推进'], position: 4, depth: 2, role: 0 }),
        ]);
        const history = [makeMsg('第一句'), makeMsg('第二句'), makeMsg('第三句', 'assistant'), makeMsg('第四句')];
        const { messages } = await DatePrompts.buildSessionPayload(baseInput(char, history, '继续推进'));
        expect(sysOf(messages)).not.toContain('AT_DEPTH_MARKER');
        const markerIdx = messages.findIndex(m => typeof m.content === 'string' && m.content.includes('AT_DEPTH_MARKER'));
        expect(markerIdx).toBeGreaterThan(0);
        expect(markerIdx).toBeLessThan(messages.length - 1);
        expect(messages[markerIdx].role).toBe('system'); // role 0 → system
    });

    it('VN 核心格式规则保留；单条目不重复注入', async () => {
        const char = makeChar([
            book({ id: 'wb-a', content: '唯一正文：夜晚路灯很亮。', constant: false, key: ['晚上'] }),
        ]);
        const { messages } = await DatePrompts.buildSessionPayload(baseInput(char, [makeMsg('x')], '晚上到了'));
        const sys = sysOf(messages);
        expect(sys.split('唯一正文：夜晚路灯很亮').length - 1).toBe(1);
        const last = messages[messages.length - 1];
        expect(String(last.content)).toContain('严格遵守 VN 格式');
        expect(String(last.content)).toContain('[emotion]');
    });

    it('不引入 StoryTheater 重型模块；图片消息不把 base64 带进 prompt', async () => {
        const char = makeChar([book({ id: 'wb-c', content: '常驻正文。' })]);
        const imgMsg = {
            id: msgId++, charId: 'char-1', role: 'user' as const, type: 'image' as const,
            content: '', timestamp: Date.now(),
            metadata: { image_url: 'data:image/png;base64,QUJDSEdFR0hJS0tMTU5PUFFSU1RVVldYWQ==' },
        } as unknown as Message;
        const { messages } = await DatePrompts.buildSessionPayload(baseInput(char, [imgMsg, makeMsg('看图')], '怎么样'));
        const dump = JSON.stringify(messages.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
        expect(dump).not.toContain('base64');
        for (const banned of ['镜头债', '世界线', '关系温度', '幕后暗格', '事件盒']) {
            expect(dump).not.toContain(banned);
        }
    });

    it('peek 感知开场同样按近期记录激活关键词世界书', () => {
        const char = makeChar([
            book({ id: 'wb-c', content: 'PEEK_CONSTANT_MARKER。' }),
            book({ id: 'wb-k', content: 'PEEK_RAIN_MARKER。', constant: false, key: ['下雨'] }),
        ]);
        const hit = DatePrompts.buildPeekPayload({
            char, userProfile: user, allMsgs: [makeMsg('外面在下雨')] as Message[], emojis: [],
        });
        expect(sysOf(hit.messages)).toContain('PEEK_CONSTANT_MARKER');
        expect(sysOf(hit.messages)).toContain('PEEK_RAIN_MARKER');
        const miss = DatePrompts.buildPeekPayload({
            char, userProfile: user, allMsgs: [makeMsg('今天很晴')] as Message[], emojis: [],
        });
        expect(sysOf(miss.messages)).toContain('PEEK_CONSTANT_MARKER');
        expect(sysOf(miss.messages)).not.toContain('PEEK_RAIN_MARKER');
    });
});

