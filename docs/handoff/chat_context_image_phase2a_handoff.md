# Lemuria 聊天情境真实生图 Phase 2A 交接

## 状态

- 目标：修复「玩家明确要求角色拍照，角色只回 Emoji/文字卡片」。打通：聊天上下文 → 图片意图 → `imageGenerationService` → 真实图片消息 → 持久化与显示。
- 范围：仅玩家明确要求（拍给我看看/发张照片/自拍/拍环境/拍某物）。角色随机主动发图、礼物 App、外卖、参考图管理 UI 均未做，但协议不阻碍后续扩展。

## 协议（复用 `[[...]]` 结构化动作词汇表，无新解析器）

- 模型单独一行输出：`[[SEND_PHOTO: {"prompt":"视觉画面描述","caption":"随图一句话","includeCharacter":false,"style":"风格"}]]`
- 注入：`utils/chatPrompts.ts` buildSystemPromptParts「可用动作」一节；仅 `!forFirePack && loadImageGenerationConfig().enabled` 时教（`utils/chatPhotoIntent.ts`）
- 拦截：`utils/applyAssistantPostProcessing.ts` Step 1.5（任何渲染前剥掉，意图控制内容绝不进气泡/prompt）；Step 7（正文渲染后执行闭环）
- 严格校验：JSON.parse 失败/缺 prompt → 标签剥掉不执行；prompt≤1200、caption≤200、style≤400；一轮只认第一个合法标签

## 落库与渲染

- `utils/chatPhotoGeneration.ts`：claim（同角色+同 prompt 90s TTL 一轮一次，防流式重放/StrictMode/重复扣费）→ pending 消息（type='image', content='', metadata.chatPhoto）→ `generateImage`（唯一入口，见 Phase 1 handoff）→ Blob 进 `blob_assets`（putImageBlob）→ content=`blobref:<id>` + status='ready'。刷新/导出/备份复用 useBlobRefUrl + resolveBlobRefsDeep，无需新 store
- `components/chat/MessageItem.tsx` ChatPhotoBubble：pending「正在拍照…」/ ready 图片+caption / failed 或 pending>150s 显示原因+手动重试（`retryChatPhotoMessage`，只按点击，无自动重试、不伪造图片）
- 生图未启用 → failed +「生图 API 未启用，请先在『设置 → 生图』中开启」；REFERENCE_NOT_SUPPORTED 自动降级去掉参考图再试一次
- 参考图：`includeCharacter=true` 才收集（当前用 char.avatar 兜底，兼容接口 `collectCharacterReferenceImages`）；false 一律不传
- 历史 prompt：`buildMessageHistory` 把照片消息渲染成「你发给了对方一张真实照片：caption」，blobref 令牌绝不进 API
- 凭据：metadata 只存 prompt/caption/style/includeCharacter/reason；reason 写库前对 apiKey 二次脱敏

## 测试与边界

- `utils/chatPhotoIntent.test.ts`（解析/不触发/不显示/claim/门控）、`utils/chatPhotoGeneration.test.ts`（成功/一次调用/失败重试/未启用/参考图/Key 不泄露/管线集成），全部 mock 生图服务
- 已知边界：`pnpm exec tsc --noEmit` 在 dev HEAD 上有既存错误（MemoryPalaceApp/CompanionHome/ThinkingChain pointerTypeRef 等，非本阶段引入）；群聊不注入拍照指南

## Phase 2A.1：聊天图片预览与保存（2026-05 追加）

- `components/chat/ChatPhotoViewer.tsx`：全屏深色预览（createPortal → document.body，脱离聊天滚动/transform 容器）。关闭 = 右上角按钮 / 点击背景 / 桌面 Escape；env(safe-area-inset-*) 四边适配 iPhone 刘海/Home 条。预览图为真实 `<img>` + `-webkit-touch-callout: default`，不拦截 contextmenu、不 preventDefault——长按直接唤起 iOS 原生「存储到照片」菜单。
- `utils/chatPhotoViewer.ts`：保存/分享辅助。优先 Web Share 文件分享（navigator.share + canShare({files}) 严格 feature detection，iPhone 分享面板可选「存储图像」）；不可用时 a.download 下载兜底；iOS 类环境 a.download 无效 → window.open 原图 + 提示长按保存。文件名 `photo_<caption>_<时间戳>.<ext>`、MIME 从 Blob 推导（非 image/* 兜底 PNG）。自建 object URL 一律按时 revoke（下载 1s / 打开原图 60s），绝不 revoke 气泡 useBlobRefUrl 管的显示 URL。
- `components/chat/MessageItem.tsx` ChatPhotoBubble：ready 图片加 `cursor-zoom-in` + onClick 打开预览；预览只接收既有 content（blobref/data URL）与显示 URL，不复制图片、不写库，刷新后照常可用。
- Share File 在预览打开后异步备好（getBlobForRef / dataUrlToBlob，只读）、备好才启用按钮，保证 navigator.share 落在用户点击事件内；失败/取消给 3.5s 简短内嵌提示，不崩。
- 不新增持久化副本、不写角色/模型记忆、不新增图片分析、不改生图协议与 API 请求。
- 测试：`utils/chatPhotoViewer.test.ts`（jsdom：文件名/MIME、share File 优先、AbortError=cancelled、下载兜底含 URL 回收、iOS open 原图优先复用调用方 URL 不新建不回收、60s 兜底回收、空文件短报错）；`utils/chatPhotoViewer.wiring.test.ts`（源码级：点击打开、三种关闭、touch-callout、不拦截长按、安全区、按钮就绪门槛、预览/辅助模块不写库）。原 chatPhotoIntent/chatPhotoGeneration 测试无回归。

