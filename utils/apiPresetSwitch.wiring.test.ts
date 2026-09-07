// 「设置 → API 预设」这块的接线守卫。
//
// 仓库的 vitest 跑在纯 Node 环境（组件测试没装 testing-library），所以沿用
// amsg2CharToggle.wiring.test.ts 的做法做**源码级**断言。验证不了运行时时序，
// 只防下面这几种回归——它们的共同点是全都不报错、界面上也看不出来：
//
//   1. 草稿同步 effect 又拿整个 apiConfig 当依赖
//      → 在识图 / 语音那块点一下保存，主 API 这边没保存的输入被悄悄冲回旧值
//   2. 保存按钮又顺手覆盖「选中的」预设
//      → 上一条冲回来的旧值被写进预设，那条预设从此永久坏掉，只能删了重建
//   3. 点预设绕开 commitApiConfig 自己写配置
//      → 聊天换了 API，后台已排程的主动消息还拿旧 Key 打请求，到点一片 401
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const settings = readFileSync(fileURLToPath(new URL('../apps/Settings.tsx', import.meta.url)), 'utf8');

/** 截出某个顶层箭头函数的函数体（这些函数在文件里都是两空格缩进 + `};` 收尾）。 */
const bodyOf = (name: string): string => {
  const start = settings.indexOf(`const ${name} = `);
  expect(start, `${name} 没找到`).toBeGreaterThan(-1);
  const end = settings.indexOf('\n  };', start);
  expect(end, `${name} 的函数体没收尾`).toBeGreaterThan(start);
  return settings.slice(start, end);
};

describe('草稿同步不跨区块打架', () => {
  it('同步 effect 不以整个 apiConfig 对象为依赖', () => {
    // updateApiConfig 每次都返回新对象。整个对象当依赖 = 任何一处保存都会重置所有输入框。
    expect(settings).not.toMatch(/\}, \[apiConfig\]\);/);
  });

  it('主 API 那份只盯自己的六个字段（含请求格式）', () => {
    expect(settings).toMatch(
      /\}, \[apiConfig\.baseUrl, apiConfig\.apiKey, apiConfig\.model, apiConfig\.apiFormat, apiConfig\.stream, apiConfig\.temperature\]\);/,
    );
  });
});

describe('请求格式设置与预设持久化', () => {
  it('只在现有 API 配置内提供两种格式，不新增 SettingsSection', () => {
    expect(settings).toContain('<option value="openai-compatible">OpenAI 兼容</option>');
    expect(settings).toContain('<option value="gemini-native">Gemini 原生</option>');
    expect(settings.match(/<SettingsSection/g) ?? []).toHaveLength(12);
  });

  it('保存当前配置和新预设都携带 apiFormat', () => {
    expect(bodyOf('handleSaveApi')).toMatch(/apiFormat:\s*normalizeChatApiFormat\(localApiFormat\)/);
    expect(bodyOf('handleSavePreset')).toMatch(/apiFormat:\s*normalizeChatApiFormat\(localApiFormat\)/);
  });

  it('编辑预设可读取并保存格式，旧值通过 normalize 回退', () => {
    expect(bodyOf('openEditPreset')).toMatch(/setEditPresetApiFormat\(normalizeChatApiFormat\(preset\.config\.apiFormat\)\)/);
    expect(bodyOf('handleUpdatePreset')).toMatch(/apiFormat:\s*normalizeChatApiFormat\(editPresetApiFormat\)/);
  });

  it('连接测试统一走 completeChat，不再硬编码 chat/completions', () => {
    const testApi = bodyOf('handleTestApi');
    expect(testApi).toMatch(/completeChat\(/);
    expect(testApi).toMatch(/apiFormat:\s*normalizeChatApiFormat\(localApiFormat\)/);
    expect(testApi).not.toContain('/chat/completions');
  });

  it('Native 模型列表不猜 endpoint，明确回到手动填写', () => {
    const fetchModels = bodyOf('fetchModels');
    expect(fetchModels).toMatch(/localApiFormat === 'gemini-native'/);
    expect(fetchModels).toContain('Gemini 原生暂不自动获取模型，请手动填写模型名称');
  });
});

describe('点预设 = 直接切过去', () => {
  it('预设名按钮走 applyPreset，不是「载入草稿」', () => {
    expect(settings).toMatch(/onClick=\{\(\) => applyPreset\(preset\)\}/);
    expect(settings).not.toMatch(/loadPreset/);
  });

  it('切换走 commitApiConfig，不自己调 updateApiConfig（否则漏掉凭据同步）', () => {
    const applyPreset = bodyOf('applyPreset');
    expect(applyPreset).toMatch(/commitApiConfig\(configFromPreset\(preset\)\)/);
    expect(applyPreset).not.toMatch(/updateApiConfig\(/);
  });

  it('高亮的是「当前生效的那条」，按已保存配置反查', () => {
    expect(settings).toMatch(/activePresetId = useMemo\(\s*\(\) => findActivePresetId\(apiPresets, apiConfig\)/);
  });
});

describe('保存配置不反写预设', () => {
  it('handleSaveApi 只改当前配置', () => {
    const handleSaveApi = bodyOf('handleSaveApi');
    expect(handleSaveApi).toMatch(/commitApiConfig\(nextConfig\)/);
    expect(handleSaveApi).not.toMatch(/updateApiPreset/);
  });

  it('改预设只有编辑弹窗这一个入口', () => {
    expect(settings.match(/updateApiPreset\(/g) ?? []).toHaveLength(1);
    expect(bodyOf('handleUpdatePreset')).toMatch(/updateApiPreset\(preset\.id, name, nextConfig\)/);
  });

  it('改的正好是在用的那条时，当前配置一起跟着走', () => {
    const handleUpdatePreset = bodyOf('handleUpdatePreset');
    // wasActive 必须在 updateApiPreset 之前算好：改完值就对不上了，反查会落空
    expect(handleUpdatePreset).toMatch(
      /const wasActive = activePresetId === preset\.id;[\s\S]*updateApiPreset\(/,
    );
    expect(handleUpdatePreset).toMatch(/if \(wasActive\) commitApiConfig\(/);
  });
});

describe('换 API 一定连着换云端凭据', () => {
  it('commitApiConfig 里三件事齐全', () => {
    const commitApiConfig = bodyOf('commitApiConfig');
    expect(commitApiConfig).toMatch(/updateApiConfig\(patch\)/);
    expect(commitApiConfig).toMatch(/syncAmsgLlmCredentials\(\{ \.\.\.apiConfig, \.\.\.patch \}\)/);
    expect(commitApiConfig).toMatch(/refreshApiCredentialsForPendingTasks\(\{ \.\.\.apiConfig, \.\.\.patch \}\)/);
  });
});
