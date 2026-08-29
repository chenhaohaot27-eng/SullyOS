import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, afterEach } from 'vitest';
import {
    parseImmersiveStoryText,
    stripLeadingEmotionTags,
    readDateTextPresentation,
    writeDateTextPresentation,
    DATE_TEXT_PRESENTATION_STORAGE_KEY,
    STORY_TEXT_PRESENTATION_STORAGE_KEY,
} from './storyTextPresentation';

describe('Story Theater 沉浸分层文本解析', () => {
    it('按原顺序拆分旁白、内心、台词和后续动作', () => {
        expect(parseImmersiveStoryText('祁煜挑了下眉。~~差点就笑出来了。~~「你确定？」他慢悠悠地朝你靠近一步。')).toEqual([
            { kind: 'narration', text: '祁煜挑了下眉。' },
            { kind: 'thought', text: '差点就笑出来了。' },
            { kind: 'dialogue', text: '「你确定？」' },
            { kind: 'narration', text: '他慢悠悠地朝你靠近一步。' },
        ]);
    });

    it('优先区分 strong 与 atmosphere，并保留多段和空行', () => {
        const text = '*初夏的夜风。*\n\n他看着你，**心跳**快了几分。';
        expect(parseImmersiveStoryText(text)).toEqual([
            { kind: 'atmosphere', text: '初夏的夜风。' },
            { kind: 'narration', text: '\n\n他看着你，' },
            { kind: 'strong', text: '心跳' },
            { kind: 'narration', text: '快了几分。' },
        ]);
    });

    it('支持同段多个同类标记并合并相邻普通文本', () => {
        expect(parseImmersiveStoryText('「一。」旁白。「二。」~~甲~~与~~乙~~')).toEqual([
            { kind: 'dialogue', text: '「一。」' },
            { kind: 'narration', text: '旁白。' },
            { kind: 'dialogue', text: '「二。」' },
            { kind: 'thought', text: '甲' },
            { kind: 'narration', text: '与' },
            { kind: 'thought', text: '乙' },
        ]);
    });

    it('异常或未闭合标记原样回退，不吞字', () => {
        const text = '旁白 ~~未闭合 **也未闭合 「仍未闭合';
        expect(parseImmersiveStoryText(text)).toEqual([{ kind: 'narration', text }]);
    });

    it('中文弯引号 “……” 识别为台词，引号保留', () => {
        expect(parseImmersiveStoryText('他顿了顿。“别走。”然后转过身。')).toEqual([
            { kind: 'narration', text: '他顿了顿。' },
            { kind: 'dialogue', text: '“别走。”' },
            { kind: 'narration', text: '然后转过身。' },
        ]);
    });

    it('英文直引号 "……" 识别为台词，引号保留', () => {
        expect(parseImmersiveStoryText('她低声说"我等你很久了。"才松开手。')).toEqual([
            { kind: 'narration', text: '她低声说' },
            { kind: 'dialogue', text: '"我等你很久了。"' },
            { kind: 'narration', text: '才松开手。' },
        ]);
    });

    it('未标记旧文本保持普通正文', () => {
        expect(parseImmersiveStoryText('他把伞递了过来，什么也没说。')).toEqual([
            { kind: 'narration', text: '他把伞递了过来，什么也没说。' },
        ]);
    });
});

describe('见面阅读模式情绪标签剥离', () => {
    const emotions = new Set(['normal', 'happy', 'shy', 'angry', 'sad', 'sulky']);

    it('剥离行首已知情绪标签（含角色自定义），可连续多个', () => {
        expect(stripLeadingEmotionTags('[shy] “台词”', emotions)).toBe('“台词”');
        expect(stripLeadingEmotionTags('[happy][sulky] 台词', emotions)).toBe('台词');
    });

    it('只有情绪标签的行剥成空串，不产生空段落', () => {
        expect(stripLeadingEmotionTags('[shy]', emotions)).toBe('');
    });

    it('普通方括号文本不被误删', () => {
        expect(stripLeadingEmotionTags('[提示] 普通正文', emotions)).toBe('[提示] 普通正文');
        expect(stripLeadingEmotionTags('[unknown] 正文', emotions)).toBe('[unknown] 正文');
        expect(stripLeadingEmotionTags('正文 [shy] 结尾', emotions)).toBe('正文 [shy] 结尾');
    });

    it('组合：[shy] “台词” 剥离后交给分层解析仍识别为台词', () => {
        const line = stripLeadingEmotionTags('[shy] “我来晚了。”', emotions);
        expect(parseImmersiveStoryText(line)).toEqual([{ kind: 'dialogue', text: '“我来晚了。”' }]);
    });
});

describe('见面阅读模式文字呈现开关', () => {
    const read = (relative: string): string => readFileSync(
        fileURLToPath(new URL(relative, import.meta.url)),
        'utf8',
    ).replace(/\r\n?/g, '\n');

    const originalLocalStorage = (globalThis as any).localStorage;
    const stubLocalStorage = (): Map<string, string> => {
        const store = new Map<string, string>();
        (globalThis as any).localStorage = {
            getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
            setItem: (key: string, value: string) => { store.set(key, value); },
            removeItem: (key: string) => { store.delete(key); },
            clear: () => store.clear(),
        };
        return store;
    };
    afterEach(() => { (globalThis as any).localStorage = originalLocalStorage; });

    it('缺失或非法 localStorage 值回退 immersive，original/immersive 合法读取与保存', () => {
        const store = stubLocalStorage();
        expect(readDateTextPresentation()).toBe('immersive'); // 缺失设置
        store.set(DATE_TEXT_PRESENTATION_STORAGE_KEY, 'garbage');
        expect(readDateTextPresentation()).toBe('immersive'); // 非法值
        writeDateTextPresentation('original');
        expect(store.get(DATE_TEXT_PRESENTATION_STORAGE_KEY)).toBe('original');
        expect(readDateTextPresentation()).toBe('original');
        writeDateTextPresentation('immersive');
        expect(readDateTextPresentation()).toBe('immersive');
        writeDateTextPresentation('garbage' as any); // 非法写入也规范成合法值
        expect(store.get(DATE_TEXT_PRESENTATION_STORAGE_KEY)).toBe('immersive');
    });

    it('与 Story Theater 的设置 key 互不覆盖', () => {
        const store = stubLocalStorage();
        writeDateTextPresentation('original');
        expect(store.get(DATE_TEXT_PRESENTATION_STORAGE_KEY)).toBe('original');
        expect(store.has(STORY_TEXT_PRESENTATION_STORAGE_KEY)).toBe(false);
        expect(DATE_TEXT_PRESENTATION_STORAGE_KEY).not.toBe(STORY_TEXT_PRESENTATION_STORAGE_KEY);
    });

    it('两种模式渲染分支接线正确（原文回退 <p>，沉浸走 ImmersiveStoryText）', () => {
        const source = read('../components/date/DateSession.tsx');
        const novelView = source.slice(source.indexOf('{/* Novel Mode View */}'), source.indexOf('{/* Visual Mode View */}'));
        expect(novelView).toContain("dateTextPresentation === 'immersive'");
        expect(novelView).toContain('<ImmersiveStoryText');
        // 菜单里的切换入口只在阅读模式显示
        const menuBlock = source.slice(source.indexOf('Menu Layer'), source.indexOf('Novel Mode View'));
        expect(menuBlock).toContain('isNovelMode && showMenu');
        expect(menuBlock).toContain('沉浸分层');
        expect(menuBlock).toContain('原文');
        // 状态从持久化助手初始化并回写
        expect(source).toContain('useState<StoryTextPresentation>(readDateTextPresentation)');
        expect(source).toContain('writeDateTextPresentation(dateTextPresentation)');
    });

    it('Story Theater 的设置 key 和调用点保持不变', () => {
        const theme = read('../components/date/story/StoryTheaterTheme.tsx');
        expect(theme).toContain('STORY_TEXT_PRESENTATION_STORAGE_KEY');
        expect(theme).not.toContain('DATE_TEXT_PRESENTATION_STORAGE_KEY');
        const theater = read('../components/date/story/StoryTheaterSession.tsx');
        expect(theater).toContain('<ImmersiveStoryText key={index} text={block.text} />');
        expect(theater).not.toContain('readDateTextPresentation');
    });
});
