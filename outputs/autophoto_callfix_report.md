# 自主发图意图机制 + 电话 App 协议修复报告 — 2026-10-26（基于 origin/main dd93684a）

## A. 自主发图意图产生机制（前台普通聊天 + 手动 ⚡ 续写）

### 机制如何产生
- `utils/chatPhotoIntent.ts` 新增 `buildChatPhotoAutonomyPrompt()`：**每轮回复前的自主视觉
  分享判断入口**。要求模型组织每条回复时先想"此刻生活中有没有值得拍下来分享的东西"，
  判断材料=角色性格/当前状态/近期经历/对话脉络 + 本轮 prompt 已注入的情境（时间/天气/
  地点/日程/生活记录/世界书）；**明确不依赖玩家最后一句话的拍照关键词**；两道门槛
  （画面真实存在且符合世界观、照片确实增进表达）都成立就直接发，**不必先问**；
  无合适对象就纯文字；不强制、无频率指标、严禁编造。
- `utils/chatPrompts.ts`：该判断入口在最终组装的 system prompt「可用动作」节内、
  SEND_PHOTO 协议教学之前注入（同一个 `chatPhotoTagEnabled` 门控：!forFirePack 且
  生图 enabled）。**不新增任何独立 Planner API 调用**——判断在主回复的同一次模型
  请求内完成。
- **未接入** `autonomousActions.ts` 的 8%/12% 随机门控（该门控只服务送礼/外卖/转账，
  SEND_PHOTO 保留每轮一图 + claim 去重 + enabled 门控 + 真实 Blob 落库 + 视觉身份/锁脸）。

### 普通聊天如何进入
`chatRequestPayload` 每轮组装 prompt 时自动带上判断入口（玩家聊什么都一样注入）；
日志 `[ChatPhoto] 自主发图机会已注入` 留痕。

### ⚡ 如何进入
`chatCompletionClient.GEMINI_NATIVE_CONTINUE_USER_MESSAGE` 从"请接着上一条继续回复"
升级为**新的自主表达回合**语义：可转话题、分享刚刚发生的事（时间/天气/地点/日程皆可
成话题）、主动执行可用行为（含自主发真实照片）；不强制、不复述、不覆盖玩家输入。
仍是一条合法 user 回合 → Gemini 请求仍以 user 结尾，**400 修复不回退**；OpenAI 兼容
路径不追加该消息、行为不变。

### 为什么比单纯放宽提示词更有触发能力
上一轮只是"允许"（移除禁止句），模型没有任何**被要求执行的过程性步骤**，默认行为
仍是纯文字。本轮把判断变成**每轮回复的组织步骤之一**（先想→两道门→直接发），并且
⚡ 续写也明确引导开启新话题/新行为；判断材料锚定在 prompt 已有的情境数据上，使
"想到可拍的东西"成为低成本默认路径而非例外。

### 可观测性（安全脱敏，不含聊天原文/密钥/prompt 内容）
- `[ChatPhoto] 自主发图机会已注入`（chatRequestPayload，charId）
- `[ChatPhoto] 模型未选择发图（本轮纯文字，属正常）`（applyAssistantPostProcessing，charId）
- `[ChatPhoto] SEND_PHOTO 标签检测`（tagCount/parsed/promptChars）+ 解析失败 warn
- `[ChatPhoto] 失败于 {config-disabled|generate|persist} 阶段`（chatPhotoGeneration）

### 测试边界声明
本轮测试验证的是：判断入口确实进入最终组装的 system prompt（enabled/forFirePack 分支）、
⚡ continuation 语义与请求合法性、四阶段日志、以及既有执行链路不回退。**未调用真实
模型**，"模型实际会自主决定发图"由用户在小手机线上验收。

## B. 电话 App 协议修复

### 实际错误 URL 与根因
- 错误 URL：`https://api.relayrouter.app/chat/completions`（主 API baseUrl + 硬拼路径）。
- 根因：CallApp 三处模型请求直接 `safeFetchJson(\`${baseUrl}/chat/completions\`)`，
  绕开 `completeChat` 的 apiFormat 分发；gemini-native 用户（base `https://api.relayrouter.app`
  + gemini-3.8-flash）被发到中转的 OpenAI 端点，返回 HTML 页面 →
  `API返回了HTML而非JSON (HTTP 200): RelayRouter`。

### 三处全部修复（apps/CallApp.tsx）
1. 主通话回复 `sendChatRequest`（原 ~2034 行）→ `completeChat`，显式带
   `apiFormat: apiConfig.apiFormat`；保留 system prompt/跨应用历史/温度 0.85/max_tokens
   8000/非流式语义与快照失败降级重试逻辑。
2. 视频表演人格生成（原 ~1852 行）→ `completeChat`。
3. 视频动作排练（原 ~1931 行）→ `completeChat`。
- `resolvePerformanceDirectorApi`：回退主 API 时**保留 apiFormat**（此前丢失）；副 API
  （emotionConfig.api）无 apiFormat 字段 → 按 OpenAI 兼容走，**不默认假设副 API 是
  Gemini Native**；返回类型显式标注。
- Gemini Native 返回为 OpenAI 形状（choices[0].message），`parseCallAssistantMessage`/
  `extractContent` 解析不变（有 mock 测试锁定）。
- 摄像头快照：data-URL image_url → gemini inlineData（适配器原生支持，测试锁定）；
  `isVisionInputUnsupportedError` 扩展识别 Gemini 形态报错（inline_data 等），降级
   机制保留。
- 未触碰 MiniMax/Fish TTS、语音识别、Live2D/VRM、通话 UI、音频缓存、历史存储。

### 测试（utils/callChatProtocol.test.ts + utils/callAppProtocol.wiring.test.ts，全 Mock）
- gemini 语音通话：URL 为 `:streamGenerateContent?alt=sse`（不再指向 /chat/completions），
  parseCallAssistantMessage 正确解析。
- gemini 快照：inlineData 转换 + 末尾 user 回合；Gemini 形态不支持图片报错可识别。
- openai-compatible：URL/请求体/解析保持原行为；HTTP 200 HTML 仍被明确报错。
- 接线守卫：CallApp 不再有 safeFetchJson/手拼 URL，≥3 处 completeChat，
  apiFormat 传递，副 API 无协议假设。
- TTS/语音识别/Live2D 未做任何运行时验证（未触碰），不宣称通过——由用户线上通话验收。

## 测试与构建
定向 99 用例中 98 通过；唯一失败为 main 上既有失败「不支持参考图的接口降级去掉参考图
再生成」（上轮已在 HEAD 验证为既有问题，与本轮无关，未新增失败）。`vite build` 成功；
`tsc --noEmit` 对全部本轮修改文件零报错（其余 122 行报错均为 main 既有，文件未触碰）。
