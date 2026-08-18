# Lemuria Message Time Continuity Summary

## 1. 根因

- 普通 Message 虽会在 `ContextBuilder` 中注入当前时间，但没有传入可靠的 `lastInteractionTs`，因此角色只能知道“现在”，不知道距离当前角色上次正常私聊已经过去多久。
- 原有时间间隔提示只比较当前 prompt 窗口内最后两条消息，可能被同角色的日期、通话、Story Theater 镜像或当前新发出的 user 消息污染，也不会读取 `story-theater:*` 独立线程。
- Message 请求此前没有查询上次私聊之后更晚的 Story Theater，因此旧聊天场景可能压过更新的线下主时间线。

## 2. 原 timeAwarenessEnabled 实际调用链

- `CharacterProfile.timeAwarenessEnabled` 由普通聊天的 `ContextBuilder` 和 `buildMessageHistory` 读取；前者控制当前时间信息，后者控制原有的短窗口间隔提示。
- `dateTimeAwarenessEnabled` 属于见面/Date 提示链，由 `utils/datePrompts.ts` 使用，不是普通 Message 的上次聊天时间感知开关。
- 本轮复用 `timeAwarenessEnabled`：关闭时不输出强化的间隔措辞，但仍保留 canonical event 的时间筛选和排序。

## 3. 修改文件

- `utils/continuityContext.ts`
- `utils/continuityContext.test.ts`
- `utils/messageDateSeparator.ts`
- `utils/messageDateSeparator.test.ts`
- `utils/db.ts`
- `utils/chatPrompts.ts`
- `utils/chatRequestPayload.ts`
- `utils/chatRequestPayload.test.ts`
- `hooks/useChatAI.ts`
- `apps/Chat.tsx`

未修改数据库版本、store schema、历史消息、Story Theater 数据或时间戳。

## 4. continuity context 注入位置

- `useChatAI.triggerAI` 在普通请求统一入口加载 snapshot，覆盖普通发送、重生成/换一种回复和继续回复。
- `buildChatRequestPayload` 将 continuity 作为隐藏 system context 放入 volatile system tail：位于角色核心设定之后、普通短期消息历史之后、当前 user 请求之前；不会写入或显示为 Message。
- 已关闭同一 payload 中旧的“两条消息间隔”提示，避免重复或错误时间判断。

## 5. Story Theater 如何筛选

- 仅查询 `characterIds` 包含当前角色的 Story Theater；每个相关 theater 只读取最近 12 条记录。
- 只保留时间晚于 `lastChatAt` 且不晚于 `now` 的记录，按时间升序形成 canonical events，最终最多注入最近 3 个事件。
- 优先使用在上次私聊之后生成的 archive summary；否则只规则化截取最近少量正文，不额外调用 LLM，也不复制完整剧情。
- 截取会排除后台状态、选项、内心独白等隐藏块；提示明确区分“计划”与“已经发生/抵达”。

## 6. Message 日期分隔实现

- 在 `apps/Chat.tsx` 的现有消息列表渲染中按用户本地自然日插入 separator，不修改 Message 数据和交互组件。
- 同日连续消息只显示一次；跨日重新分组；今天/昨天使用相对标签，更早显示月日和星期，跨年时附带年份。
- 消息气泡、分页、滚动、长按、回复和删除逻辑未改动。

## 7. tests / typecheck / build

- 定向测试：14/14 通过，覆盖 5 个 continuity builder case、legacy 角色缺失开关时默认启用、日期分隔和 payload 隐藏注入。
- 完整 Vitest：3452/3453 个已收集测试通过；1 个既有 `chatPrompts.firePack` 文案断言失败。另有 2 个 Worker suite 因本地 Vitest 无法解析 `cloudflare:workers` 未收集，与本轮文件无关。
- TypeScript：本轮新增/修改文件无类型错误；全仓 `tsc --noEmit` 仍被既有的 MemoryPalace、MessageItem、CompanionHome 等无关错误阻断。
- `pnpm run build`：成功；构建产物对已追踪 Worker bundle 的自动改写已还原。

## 8. Instant Push 是否还需要后续同步

- 当前由 `useChatAI.triggerAI` 发起的即时云端路径会复用同一 `fullMessages`，已携带 continuity。
- `utils/activeMsgClient.ts` 的计划任务 / fire-pack 独立构建 system prompt，尚未查询 Story Theater continuity，后续应复用同一 builder；本轮未扩大修改范围。

## 9. 手机上的复测步骤

1. 保留现有迁移数据，确认目标角色普通 Message 最后一轮约为 3 天前，且之后存在更晚的见面剧情。
2. 从 Message 给该角色发一条自然问候，确认回复不再把三天前上海即时动作当作今天仍在发生，并能承接较新的线下记录。
3. 对仅记录“次日计划飞兰州”的历史，确认角色只视其为最后已知计划，不擅自声称已经抵达。
4. 对回复执行一次重生成和继续回复，确认时间连续性一致。
5. 查看跨日历史，确认日期分隔只在自然日变化处出现，且长按、回复、删除与滚动仍正常。
