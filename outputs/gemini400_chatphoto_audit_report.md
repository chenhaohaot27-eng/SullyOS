# 故障审计与修复报告（Gemini Native 400 / 角色聊天发图退化）— 2026-10-26

分支：lemuria-rename（领先 main 6 个提交，工作区含未提交的重命名改动）。
本次修复基于当前工作区代码（包含 main 的全部代码）。

## 一、Gemini Native HTTP 400 "Requests ending with a model turn are not supported"

### 调用路径与根因
- 路径：`apps/Chat.tsx handleManualTrigger(⚡)` → `hooks/useChatAI.ts triggerAI`
  → `chatRequestPayload.buildChatRequestPayload`（fullMessages = [system, 历史, 尾部 system]）
  → `utils/chatCompletionClient.ts completeChat`（apiFormat=gemini-native）
  → `utils/geminiNativeChat.ts requestGeminiNativeChat`。
- 根因：本地聊天为「手动 ⚡ 触发」模式。用户在角色说完后**不再发言、直接再点 ⚡ 让角色继续**
  （主动续写）时，历史最后一条有效消息是 assistant；尾部 system（易变状态段、amsg2 排程块、
  plannerInstruction）全部进入 systemInstruction、不计入 contents，于是 Gemini contents
  以 model 回合结尾 → 上游 400。
- 已核查并排除的其它路径：工具续跑（tool → functionResponse，以 user 回合结尾，签名保留）、
  二轮 LLM（均以 assistant+user 结尾）、MCP 文字容错（assistant+user）、情绪评估（单 user）
  均合法；空 parts 由 `appendContent` 自然剔除。

### 修复（三层，均为最小必要）
1. `utils/geminiNativeChat.ts`：发送前末尾回合校验 `assertLegalGeminiNativeTail`——
   contents 为空 / 以 model 结尾 → 本地抛 `GeminiNativeAdapterError`（不发请求、不重复计费、
   错误信息直接指向调用方）。不做任何静默改写（不丢 assistant、不伪造历史、不底层追加"继续"）。
2. `utils/chatCompletionClient.ts`：新增 `ensureGeminiNativeTailUserTurn`（调用方级助手），
   仅当 apiFormat=gemini-native 且最后一个非 system 消息为有内容的 assistant 时，
   由调用方追加一条合法 user continuation；其它 apiFormat 原引用返回、行为零变化。
3. `hooks/useChatAI.ts`：主聊天请求 `baseReqBody.messages` 经该助手处理（仅 gemini-native
   生效），手动 ⚡ 续写不再 400；OpenAI 兼容用户零影响。工具续跑 functionResponse 路径不受影响。

## 二、角色聊天发图退化为文字"发了一张照片"

### 根因（配置同源，无分叉）
- 设置页测试与正式聊天**使用同一套持久化配置**：均经 `loadImageGenerationConfig`
  （localStorage `os_image_generation_config_v1`）+ `imageGenerationService.generateImage`。
  设置页测试成功 ⇒ 配置/服务/网络均正常。
- 退化发生在**意图解析层**：模型输出的 `[[SEND_PHOTO: {...}]]` payload 稍有格式误差
  （全角引号 / 全角冒号 / 尾逗号——中文模型高频错误）时，旧版 `parsePayload` 严格
  `JSON.parse` 失败 → 标签整段剥掉、intent=null → 无 image 消息，只剩正文里
  "发了一张照片"类文字。此前解析失败仅有一条无细节 warn，难以定位。

### 修复
- `utils/chatPhotoIntent.ts`：JSON.parse 失败后做**仅限结构字符**的第二次尝试
  （全角双引号/全角冒号→半角、删尾部逗号；合法解析成功时绝不走该路径），还原真实生图意图。
- 未放宽任何权限门控（见"产品策略限制"）。

## 三、可观测性（安全脱敏）
- `geminiNativeChat`：请求发出前记 `source/model/messages 数/contents 尾部角色/systemParts/tools 数`；
  上游拒绝时记 HTTP 状态 + 尾部角色（与本地拦截的 AdapterError 明确区分）。不含密钥/正文/base64。
- `chatPhotoIntent/applyAssistantPostProcessing`：记录标签出现数、是否解析成功、prompt 长度
  （不含 prompt 原文）；解析失败 warn 明确指出"本轮退化为纯文字"。
- `chatPhotoGeneration`：分阶段日志（config-disabled / generate / persist / 成功）。
- `context/OSContext.tsx`：修复系统日志对 Gemini Native 请求体按 OpenAI 形状打印导致的
  `model: undefined / messages(0)` 误显——现在按 Gemini 形状（contents/systemInstruction、
  模型名取自 URL）重排摘要。

## 四、测试结果
定向单测（全部通过）：
- `utils/geminiNativeChat.test.ts`：22 passed（新增 7：user 结尾放行+尾部 system 不进 contents、
  assistant 结尾本地拦截不发网络请求、model turn 错误信息、空 contents 拦截、空 parts 剔除、
  functionCall/functionResponse 续跑保签名、assertLegalGeminiNativeTail 纯函数）。
- `utils/chatCompletionClient.test.ts`：9 passed（新增 4：⚡ 续写端到端 contents 以 user 结尾、
  OpenAI 路径零变化、user/空 assistant/全 system 不追加、带 tool_calls 的续写）。
- `utils/chatPhotoIntent.test.ts`：12 passed（新增：全角引号/全角冒号/尾逗号容错、tagCount）。
- `utils/chatPhotoGeneration.test.ts`：新增 3 通过（非法标签→无假图片消息/不调服务/正文保留/
  warn 留痕；全角引号标签端到端出真图+日志脱敏；成功落库后重新读取 ready 保持）。
  ⚠️ 既有用例「不支持参考图的接口降级去掉参考图再生成」失败——经 stash 验证在 HEAD 上同样
  失败（既有问题，测试期望 chatPhotoGeneration 层重试，实现里无此逻辑），与本次改动无关，未处理。

相关回归（全部通过）：chatPrompts.firePack / chatPrompts.scheduleTag / chatRequestPayload /
toolCallCompat / chatGenEvents / chatPhotoViewer.wiring / reportedIssuesRegression.wiring
（49 passed）；imageGenerationConfig / safeApi.stream / streamUpgrade / claudeProxyCompat /
samplingParamCompat / companionStartup（37 passed）。

构建与类型：`npx vite build` 成功（1m31s）；`npx tsc --noEmit` 对本次全部修改文件
（含 OSContext.tsx）无任何报错；工作区中 MemoryPalaceApp/MessageItem/CompanionHome 等
**既有**未提交改动存在与本任务无关的类型错误（本次未触碰）。

## 五、仍存在的产品策略限制（遵循现状，未放宽）
- SEND_PHOTO 仅教给"玩家明确请求"场景（`buildChatPhotoTagGuide`），主动消息/fire_pack 路径
  不教（`!forFirePack`）；生图配置 enabled=false 时不教标签、聊天路径明确报"未启用"并给重试。
- 角色自主拍照（PROACTIVE_ACTION/BehaviorPlanner PHOTO）受 24h 冷却 + 每轮 1 个高成本动作
  预算（`gateAssistantHighCostAction`）门控，本轮已执行玩家请求型 SEND_PHOTO 时跳过自动 PHOTO。
  这些是既有防重复扣费策略，保持不变。
- Gemini Native 调用目前不进「API 调用记录」（拦截器只认 /chat/completions），本次以
  console 诊断日志补足可观测性；深度接入调用记录属后续工作。

## 六、事故记录
审计过程中一次 PowerShell 5.1 编码事故损坏了 `context/OSContext.tsx`（UTF-8 被 ANSI/GBK 读写），
已确定性恢复并全量验证（详见 `outputs/oscontext_encoding_recovery.md`）。
