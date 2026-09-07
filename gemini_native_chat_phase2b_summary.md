# Gemini Native Chat Phase 2B

## 修改文件

- `hooks/useChatAI.ts`：主私聊初始请求、OpenAI 兼容重试、MCD/Luckin/MCP/AMSG2 工具续跑统一走 `completeChat`；Native 工具轮保留 provider state。
- `utils/applyAssistantPostProcessing.ts`：仅将主私聊可能触发的 15 处二次 completion 传输改走统一客户端；提示词、判断、解析和落库逻辑未改。主动消息的 `skipSecondPassLLM=true` 路径仍不发这些请求。
- `utils/chatCompletionClient.ts`：新增工具续跑 assistant message helper；OpenAI 保持原消息形状，Gemini 保留不可枚举的原始 parts / thoughtSignature。
- `apps/Settings.tsx`、`context/OSContext.tsx`：现有“通用 API”内增加中文请求格式选择；默认 OpenAI 兼容；保存、编辑、切换 preset 均携带格式；Native 测试连接走统一客户端，模型暂手填。
- `utils/chatCompletionClient.test.ts`、`utils/mainChatCompletionClient.wiring.test.ts`、`utils/apiConfigNormalize.test.ts`、`utils/apiPresetSwitch.wiring.test.ts`：补充 Phase 2B 回归与接线测试。

## 主私聊迁移

- OpenAI-compatible：仍请求 `<baseUrl>/chat/completions`，原 body、流式回调、工具处理与 assistant 后处理保持现状。
- Gemini Native：主私聊及其工具/二次生成请求由 adapter 自动请求 `/v1beta/models/{model}:streamGenerateContent?alt=sse`。
- 未改 `buildChatRequestPayload`、角色卡、世界书、记忆、历史构造、数据库消息格式或回复长度/模型参数。

## Settings 请求格式 UI

- API 入口仍为 3 个，没有新增分类或第二套 Key/URL/model。
- 选项：`OpenAI 兼容` / `Gemini 原生`；缺失或非法 `apiFormat` 均显示并使用 OpenAI 兼容。
- preset 保存、编辑、切换和“使用中”匹配均包含 `apiFormat`；不根据模型名推断协议。
- Gemini Native 不猜测模型列表接口，沿用现有手动模型输入；测试连接使用 Native 请求。

## tools / signature

- Gemini `functionCall` 的原始 model parts 与 `thoughtSignature` 仅保存在同一工具循环的内存 provider state，并在 functionResponse follow-up 原样回传。
- thought / signature 不进入普通正文和 JSON 持久化。
- Native HTTP 429/400/401/500 均单次请求后抛错，不自动 retry；OpenAI 专属兼容重试不会由 Native 错误触发。

## 验证

- tests：PASS；12 个相关测试文件，108 tests passed。覆盖 OpenAI URL/body 回归、Native 文本与 SSE、中文跨 chunk、多 parts、thought 过滤、工具 follow-up/signature、429 单次请求、preset 格式保存/切换/旧配置默认值、Settings 接线、主私聊与后处理统一客户端。
- typecheck：全仓 FAIL（既有错误）；本阶段修改/新增文件无新增 TypeScript 错误。既有错误仍位于 MemoryPalaceApp、MessageItem、CompanionHome、apiCallLog、若干旧测试、vite.config 等。
- build：PASS；`pnpm run build` 成功。仅有既有 circular chunk 与 pdf.js eval 警告。

## 尚未迁移场景

Story Theater、Date/见面、GroupChat、relationshipChat、theaterGenerator、本地主动消息、独立情绪评估、Worker、AMSG、Instant Push 均未迁移。声音 API、生图 API 与 Gemini 生图模块未改。

本阶段未 commit、未 push、未 merge、未发布 Pages；已具备本地运行时测试条件。
