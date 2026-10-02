# Lemuria Chat Voice Fix Summary

## 1. 根因

- `shouldAutoGenerateVoice` 原先直接读取 `chatVoiceAutoPlay`；用户关闭“收到语音自动播放”时，新 `<语音>` 只显示空语音条，不会预先合成。
- 迁移语音的 `【语音消息 · Ns】` 原文直接进入 Message history，模型会把旧 UI 占位符误当作当前合法输出语法。
- 提示词虽已有 `<语音>` 和禁止复读说明，但未明确禁止迁移占位符及模型自写时长。

## 2. Auto Generate / Auto Play 原逻辑与修后逻辑

- 原逻辑：只有 `chatVoiceAutoPlay=true` 才自动合成并播放；关闭时首次点击语音条才开始 TTS。
- 修后：`chatVoiceEnabled=true`、消息含合法 `<语音>`、TTS 可用且未生成/加载/失败时必定后台合成，与 autoplay 无关。
- `chatVoiceAutoPlay` 现在只决定自动合成成功后是否立即 `audio.play()`；关闭时生成 ready-to-play 语音条，第一次点击直接播放。
- 同步 `voiceInFlightRef` 防止 React state 更新前的重复 TTS；失败消息继续由 `voiceFailedRef` 阻止自动循环重试。

## 3. 修改文件

- `apps/Chat.tsx`
- `utils/voicePlayback.ts`
- `utils/voicePlayback.test.ts`
- `utils/chatVoiceHistory.ts`
- `utils/chatVoiceHistory.test.ts`
- `utils/chatPrompts.ts`
- `utils/applyAssistantPostProcessing.ts`
- `utils/applyAssistantPostProcessing.test.ts`
- `utils/amsgInstantChat.wiring.test.ts`

## 4. 历史语音如何清洗给 LLM

- 仅匹配 `metadata.migrationSource === 'legacy_xiaoyu_messages'` 且 `metadata.legacy.isVoice === true` 的消息。
- 优先读取 `metadata.legacy.voiceText`；缺失时从 `message.content` 去除旧时长占位符并提取转写。
- LLM history 改为 `[历史语音转写]\n实际转写内容`；IndexedDB 内容、UI、timestamp 均不修改。

## 5. 是否避免语音 + 文字复读

- Voice Prompt 明确 `<语音>...</语音>` 是唯一合法语音语法，禁止 `【语音消息 · Ns】` 等占位符、自写时长和同轮文字复读。
- 后处理会丢弃与同轮 `<语音>` 内容完全相同的独立文本 chunk；内容不同的普通文字仍保留。
- `<字幕>` 继续由语音条“转文字”区域处理，不拆成重复普通气泡。

## 6. 测试结果

- 定向 Vitest：语音决策、TTS 解析、legacy history、复读后处理及 AMSG2 接线共 84/84 通过，包含“ready 音频首次点击直接播放”守卫。

## 7. typecheck / build

- `pnpm run build`：成功。
- `tsc --noEmit`：本轮文件无类型错误；全仓仍被既有 MemoryPalace、MessageItem、CompanionHome、vite config 等错误阻断。
- build 自动改写的 Worker bundle 已全部还原，未纳入本轮 diff。

## 8. 已知问题

- 本轮不恢复旧迁移语音的真实音频；历史语音仍沿用现有兼容显示。
- 未配置 TTS 时保留可展开“转文字”的安全 fallback；用户主动点击播放会收到一次配置提示，不会自动反复请求。

## 9. 手机复测步骤

1. 给角色配置可用 TTS，开启“语音消息”，关闭“收到语音自动播放”，让角色生成 `<语音>`；确认先显示“合成中”，随后自动变为可播放语音条且不出声。
2. 第一次点击已就绪语音条，确认立即播放，没有再次等待 TTS。
3. 开启自动播放后再生成语音，确认合成完成即自动播放。
4. 点击“转文字”，确认语音正文只在语音条内展开，没有同内容普通气泡；外语语音确认字幕仍在条内显示。
5. 暂时移除该角色 TTS 配置后生成语音，确认页面不报错、不循环请求，并可查看文字 fallback。
6. 用含旧 `【语音消息 · Ns】` 历史的迁移角色继续聊天，确认新回复不再模仿该占位格式。
