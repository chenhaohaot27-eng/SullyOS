import { readFileSync } from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import { STORY_PLAYER_AGENCY_GUARD, buildStoryIdentityGuard, BUILTIN_NIGHT_SCREENING_PRESET } from './storyTheater';

// StoryTheaterSession 是组件，无法直接单测 payload 组装；按 callAppRuntimeReferences /
// callTtsEmotionPriority 的惯例做「导入 + 注入点」源码级断言，锁定接线不被误删。
const read = (rel: string) => readFileSync(path.resolve(__dirname, rel), 'utf8');
const sessionSource = read('../components/date/story/StoryTheaterSession.tsx');
const storyTheaterHostSource = read('../components/date/story/StoryTheater.tsx');
const dateAppSource = read('../apps/DateApp.tsx');
const chatPromptsSource = read('./chatPrompts.ts');
const datePromptsSource = read('./datePrompts.ts');
const callAppSource = read('../apps/CallApp.tsx');

describe('STORY_PLAYER_AGENCY_GUARD 内容底线', () => {
  it('明确区分玩家执笔权与剧情免疫权', () => {
    expect(STORY_PLAYER_AGENCY_GUARD).toContain('执笔权');
    expect(STORY_PLAYER_AGENCY_GUARD).toContain('剧情免疫权');
    expect(STORY_PLAYER_AGENCY_GUARD).toContain('不得替玩家做重大决定 ≠ 不得让玩家承受重大后果');
  });
  it('允许客观外部后果（受伤/被捕获/物品被夺等）', () => {
    expect(STORY_PLAYER_AGENCY_GUARD).toContain('受伤');
    expect(STORY_PLAYER_AGENCY_GUARD).toContain('被捕获或挟持');
    expect(STORY_PLAYER_AGENCY_GUARD).toContain('被夺走或损坏');
    expect(STORY_PLAYER_AGENCY_GUARD).toContain('客观后果');
  });
  it('禁止无依据的自动救援 / 降智 / 心软', () => {
    expect(STORY_PLAYER_AGENCY_GUARD).toContain('巧合救援');
    expect(STORY_PLAYER_AGENCY_GUARD).toContain('敌人突然降智');
    expect(STORY_PLAYER_AGENCY_GUARD).toContain('危险人物突然心软');
    expect(STORY_PLAYER_AGENCY_GUARD).toContain('自动脱险');
  });
  it('危机允许跨回合持续，不要求当回合闭环', () => {
    expect(STORY_PLAYER_AGENCY_GUARD).toContain('跨多个回合持续');
    expect(STORY_PLAYER_AGENCY_GUARD).toContain('危险仍未解除');
    expect(STORY_PLAYER_AGENCY_GUARD).toContain('不要主动降低危险等级');
  });
  it('已发生的后果必须在后续剧情中持续', () => {
    expect(STORY_PLAYER_AGENCY_GUARD).toContain('继续成立');
    expect(STORY_PLAYER_AGENCY_GUARD).toContain('自行重置不利状态');
    expect(STORY_PLAYER_AGENCY_GUARD).toContain('身份暴露');
  });
  it('同样禁止为了反主角光环而强行制造危险', () => {
    expect(STORY_PLAYER_AGENCY_GUARD).toContain('反向极端化');
    expect(STORY_PLAYER_AGENCY_GUARD).toContain('凭空制造伤害');
    expect(STORY_PLAYER_AGENCY_GUARD).toContain('因果真实，不是故意虐玩家');
  });
});

describe('Story Theater payload 注入与链路隔离', () => {
  it('STORY_PLAYER_AGENCY_GUARD 被导入并无条件注入 payloadBeforeTurn（紧跟 identityGuard 之前）', () => {
    expect(sessionSource).toContain('STORY_PLAYER_AGENCY_GUARD,');
    expect(sessionSource).toMatch(
      /const payloadBeforeTurn = \[[\s\S]*\{ role: 'system' as const, content: STORY_PLAYER_AGENCY_GUARD \},\s*\n\s*\{ role: 'system' as const, content: identityGuard \},/,
    );
  });
  it('注入不依赖任何开关（不以三元/条件展开形式出现）', () => {
    expect(sessionSource).not.toMatch(/STORY_PLAYER_AGENCY_GUARD \? /);
    expect(sessionSource).not.toMatch(/\?\s*\[\{ role: 'system' as const, content: STORY_PLAYER_AGENCY_GUARD \}\]/);
  });
  it('微信聊天链路（chatPrompts）不引用该 guard', () => {
    expect(chatPromptsSource).not.toContain('STORY_PLAYER_AGENCY_GUARD');
  });
  it('普通陪伴链路（datePrompts）不引用该 guard', () => {
    expect(datePromptsSource).not.toContain('STORY_PLAYER_AGENCY_GUARD');
  });
  it('电话链路（CallApp）不引用该 guard', () => {
    expect(callAppSource).not.toContain('STORY_PLAYER_AGENCY_GUARD');
  });
  it('buildStoryIdentityGuard 含执笔权/免疫权澄清行', () => {
    const guard = buildStoryIdentityGuard(BUILTIN_NIGHT_SCREENING_PRESET.document, '测试身份', ['角色A']);
    expect(guard).toContain('剧情免疫权');
    expect(guard).toContain('不等于“不得让玩家承受重大后果”');
  });
});

describe('reply_choices 与入口路径不受影响', () => {
  it('内置预设的 reply_choices 原规则保持不变（仍只写可以说/做、不宣布已发生）', () => {
    const presetRaw = read('../assets/presets/night-screening-v6.14.sully.json');
    expect(presetRaw).toContain('reply_choices');
    expect(presetRaw).toContain('不能宣布已经发生');
  });
  it('聊天邀请 (meetStoryLaunch) 进入的剧情同样经过 StoryTheaterSession 组装点', () => {
    expect(dateAppSource).toContain('meetStoryLaunch');
    expect(dateAppSource).toMatch(/import StoryTheater from '\.\.\/components\/date\/story\/StoryTheater';/);
    expect(storyTheaterHostSource).toMatch(/StoryTheaterSession/);
  });
});
