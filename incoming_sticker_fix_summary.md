# Incoming Sticker Fix Summary

## Root cause

- AI 表情只用 `emoji.name === modelName` 精确匹配，模型多了空格、引号或图片描述就会失败。
- 匹配失败后被降级为 `[表情：xxx]` 文本气泡。AMSG2 还会对零气泡结果派发普通未读事件。

## Changed files

- `utils/emojiResolver.ts`, `utils/emojiResolver.test.ts`: 新增共享的精确、规范化和唯一安全子串解析。
- `utils/applyAssistantPostProcessing.ts`, `utils/applyAssistantPostProcessing.test.ts`: 普通 Message 与 AMSG2 共用 resolver，失败时警告并跳过，不再生成文本 fallback。
- `utils/assistantActionFormat.ts`, `utils/assistantActionFormat.test.ts`: 独立标签 `[表情：x]` / `[表情包: x]` 等转为 canonical intent，行内自然语言不误判。
- `utils/chatPrompts.ts`: 明确要求原样复制现有表情名称，不描述图片或自造名称。
- `context/OSContext.tsx`: 本地主动消息的旧内联后处理改用同一 resolver。
- `utils/activeMsgRuntime.ts`, `utils/activeMsgRuntime.test.ts`: 纯未解析表情不落空消息，也不产生应用内幽灵未读；有 directive 时仍正常通知。
- 用户手动发表情链路 `apps/Chat.tsx` 未修改。

## Tests

- 定向测试: 4 files, 151 tests passed。
- AMSG2 真库 flush 复测: 3 passed, 114 skipped。
- 覆盖 exact、引号/空格、唯一安全子串、歧义/不存在、独立单括号标签、文字与表情顺序、无文本 fallback 和 AMSG2 无幽灵未读。

## Build

- `pnpm run build`: success。
- 仅有既有 circular chunk 和 `pdfjs` eval warning。

## Remaining issues

- 歧义、过短泛词或库内不存在的引用会被安全跳过，不会随机替换。
- 全量 `tsc --noEmit` 仍有与本轮无关的既有错误，集中在 MemoryPalace、CompanionHome、旧测试与 Vite proxy 类型；本轮新增文件未出现在错误列表。
