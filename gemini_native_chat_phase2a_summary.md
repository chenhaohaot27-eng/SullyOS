# Gemini Native Chat Phase 2A

## 修改/新增文件

- `types.ts`：新增 `ChatApiFormat`，`APIConfig` 与角色聊天 override 支持可选 `apiFormat`。
- `utils/apiConfigNormalize.ts`、`utils/apiConfigNormalize.test.ts`：缺失/非法格式回退 `openai-compatible`。
- `utils/apiPresetSwitch.ts`、`utils/apiPresetSwitch.test.ts`：预设切换携带格式，预设匹配比较格式。
- `utils/chatCompletionClient.ts`、`utils/chatCompletionClient.test.ts`：统一 completion dispatch；旧配置仍走 OpenAI-compatible。
- `utils/geminiNativeChat.ts`、`utils/geminiNativeChat.test.ts`：Native URL、消息/图片/工具转换、SSE、错误及响应归一。
- 本文件仅记录结果。业务实现/测试文件共 9 个。

## Gemini Native 已完成能力

- RelayRouter Bearer 请求；兼容 root、尾斜杠、已含 `/v1beta`、普通或 `models/...` 模型名。
- OpenAI-shaped system/user/assistant/tool、相邻角色合并、data image、generationConfig 转换；远程/blob 图片明确报错，不静默丢弃。
- function declarations、常见 JSON Schema、auto/none/required/指定函数、单/多 functionCall 与 functionResponse。
- JSON/SSE、UTF-8 跨 chunk、多 parts、candidate 0、无 `[DONE]` 依赖。
- `thought:true`、thoughtSignature 与 metadata 不进入正文；工具轮原始 parts/signature/order 保存在不可序列化的本轮 provider state。
- OpenAI-shaped content/tool_calls/finish_reason/model/usage；400/401/429/500 保留上游 message，默认零重试，支持 AbortSignal。

## OpenAI 兼容

- PASS：缺失或非法 `apiFormat` 均走 `<baseUrl>/chat/completions`；原 body 与现有 `safeFetchJson` 解析路径保持不变。
- 未按模型名推断协议。

## tests

- PASS：9 个相关测试文件，62 tests passed。
- 覆盖新增核心测试、配置/预设、既有 OpenAI SSE、tool calls、content 与 API 日志回归；全部 mock，无真实付费请求。

## typecheck

- 全仓 `tsc --noEmit`：FAIL（仓库既有错误）。
- 本轮修改/新增文件：无新增 TypeScript 错误。
- 既有错误集中于 `MemoryPalaceApp`、`MessageItem`、`CompanionHome`、`apiCallLog`、若干既有测试、`vite.config.ts` 等，未越界修复。

## build

- PASS：`vite build` 成功（6139 modules）。
- 仅有既有 circular chunk 与 pdf.js eval 警告。按限制未执行会重写 Worker bundle 的 `build:workers`。

## 未迁移场景

- 本阶段只提供底层能力，尚未接入主私聊 `useChatAI`、本地主动消息、Story Theater、Date、GroupChat、relationshipChat、theaterGenerator、情绪评估及其他独立 completion 调用。
- Worker / AMSG / Instant Push 未迁移、未修改；设置 UI 未开放。

## 阻塞问题

- Phase 2A 核心无阻塞。
- 运行时启用 Native 仍需后续阶段逐条迁移调用方和工具循环，并另行开放设置 UI；远程/blob 图片在加入可靠转换前会给出明确不支持错误。
