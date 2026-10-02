# Gemini Native Chat Phase 2C

## 修改文件

- `components/date/story/StoryTheaterSession.tsx`：`callCompletion` 从手写 fetch 改为统一 `completeChat`；`send` 中 assistant prefill 在 Gemini Native 下强制走既有 user-last 兼容路径。
- `apps/DateApp.tsx`：`callLLM`（peek / send / reroll 共用）从手写 fetch 改为统一 `completeChat`。
- 新增 `utils/storyTheaterChatClient.test.ts`（8 tests）。
- 新增 `utils/dateAppChatClient.test.ts`（4 tests）。
- `utils/datePrompts.ts`、`utils/storyTheater.ts`、`utils/chatCompletionClient.ts`、`utils/geminiNativeChat.ts` 本阶段**未改动**，全部复用 Phase 2A/2B 实现。

## Story Theater 迁移情况

- 唯一传输出口 `callCompletion` 统一走 `utils/chatCompletionClient.ts` 的 `completeChat(apiConfig, { model, messages, stream: false, ...settings }, { maxRetries: 0 })`。
- 剧情 prompt 构建（`compileStoryPreset` / 剧场上下文 / 世界书 / 记忆 / 归档 summary）、正文解析、UI、Story Theater 数据结构全部未改。
- 归档 summary 调用（`temperature 0.2 / max_tokens 1600`）走同一 `callCompletion`，自然继承协议切换。
- OpenAI 行为等价：请求 URL、body（model/messages/stream/settings 展开）、零重试与原手写 fetch 一致；`usage.prompt_tokens` 回填 `onPromptTokens` 的逻辑保持不变。

## Date 迁移情况

- `callLLM` 统一走 `completeChat(apiConfig, { model, messages, temperature, max_tokens: 8000, stream }, { maxRetries: 0 })`；peek / send / reroll 三处自动继承。
- 约会/见面 prompt（`utils/datePrompts.ts`）、剧情状态、角色关系、UI、历史记录均未改。
- 仍然只使用现有「通用 API」（`useOS().apiConfig`，含 `apiFormat`）；未新增任何 API 入口 / Key / Base URL / 模型配置，API 入口仍为 3 个。

## prefill 处理

- 复用既有机制：`appendStoryUserTurn` → `buildStoryPrefillInstruction`（400 兼容路径）。
- OpenAI-compatible：默认仍保留原生 assistant prefill 作为最后一条消息，行为与迁移前完全一致。
- Gemini Native：`forceUserLast = entry.forceUserLastMessage === true || apiFormat === 'gemini-native'`。Native 不把最后一条 model turn 当作普通新请求结尾，预填改写为紧邻 user 之前的 system 约束，最终消息保持 user；返回正文缺失预填前缀时仍由组件本地补齐（`generated.startsWith(prefill)` 判断），「续写/剧情正文」语义不变，未删除 prefill 语义。

## OpenAI 回归

- Story Theater：`chat/completions` URL、body 字节级等价（含 settings 展开、`stream:false`、零重试）；usage.prompt_tokens 回填不变。
- Date：URL、`model/messages/temperature/max_tokens:8000/stream` 原样透传，空回复错误文案不变。
- 测试断言均为快照式 body 对比。

## Gemini Native

- 完全复用 Phase 2A/2B 的 message adapter（system→systemInstruction、user/assistant→user/model、相邻合并）、SSE parser、thought 过滤、thoughtSignature provider state、usage 归一（usageMetadata → prompt/completion/total_tokens）、错误处理与 AbortSignal 能力。
- Story Theater / Date 内没有第二套 Gemini 请求实现（wiring 测试断言组件源码不含原生端点/硬编码路径）。
- temperature/top_p/max_tokens → generationConfig 自动转换；frequency/presence penalty 由 adapter 按 Phase 2A 规则丢弃。

## 429

- Native 与 OpenAI 路径均 `maxRetries: 0`，单次失败直接抛错，不自动重发。
- RelayRouter 原始 `error.message`（如「当前分组上游负载已饱和」）保留在异常信息中，Story Theater 调试终端 toast 可见完整错误；不吞异常。
- thought / thoughtSignature / metadata 不进入正文，不显示给玩家（测试断言序列化结果不含 signature）。

## tests

- PASS：新增 `utils/storyTheaterChatClient.test.ts`（8 tests：OpenAI 回归 ×2、Native 普通剧情、Native SSE 中文跨 chunk + thought 过滤 + usage、Native 429 单次、prefill 兼容 ×3 含组件接线）。
- PASS：新增 `utils/dateAppChatClient.test.ts`（4 tests：OpenAI 回归、Native system/user/assistant 转换 + 中文回复、Native 429 单次、组件接线）。
- PASS：回归 29 个测试文件 263 tests——含 Phase 2A/2B Gemini/OpenAI 12 个（chatCompletionClient、geminiNativeChat、apiConfigNormalize、apiPresetSwitch×3、safeApi×4、apiCallLog、toolCallCompat）、Story Theater 现有全部（storyTheater、db.storyTheater、ArchiveView/Backup/BillingSafety/Deletion/Typography/VectorMemory wiring、storyTextPresentation、theaterGenerator）与 Date 相关（datePrompts、datePromptsTimezone、dateHistory、dateLaunch、dateSessionHistory、dateSessionRecovery、dateSprites）。全部 mock，无真实付费请求。

## typecheck

- 全仓 `tsc --noEmit`：FAIL（仓库既有错误，82 行，集中于 MemoryPalaceApp、MessageItem、CompanionHome、apiCallLog、builtinSullyLive2D、userCameraEmotion、emojiRuntimeDiagnostic、vite.config 及若干既有测试——与 Phase 2A/2B 记录一致，未越界修复）。
- 本阶段修改/新增 4 个文件：无任何 TypeScript 错误。

## build

- PASS：`vite build` 成功（36.50s）。仅既有 circular chunk 与 pdf.js eval 警告。按限制未执行会重写 Worker bundle 的 `build:workers`。

## 尚未迁移场景

- GroupChat、relationshipChat、theaterGenerator（日程小剧场）、本地主动消息、独立情绪评估、Worker、AMSG、Instant Push 均未迁移、未修改。
- 声音 API、生图 API、Gemini 生图模块、普通私聊 prompt、角色卡/世界书/记忆系统均未改动。
- 本阶段未 commit、未 push、未 merge、未发布 Pages。
