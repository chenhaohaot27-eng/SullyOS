# Lemuria Feature Batch A — 交接摘要

基线：`origin/main @ 4907e9ece0b4c82aeb30eeb468e01d04e26643e7`
临时 worktree：`C:/Users/15371/AppData/Local/Temp/SullyOS-feat-a`（分支 `lemuria-feat-a`）
主工作区 dev @ 49ff376e + 用户 WIP 未动。

## A. 剧情按角色/世界观分组

- `StoryTheaterEntry.characterGroupId?: string`（types.ts）：保存时的分组**快照**。
- `components/character/CharacterGroupFilter.tsx`：
  - 从 `CharacterGroupFilterBar` 提取出通用胶囊条 `GroupFilterChips`（视觉/交互零分叉）；
  - 新增纯函数 `resolveStoryTheaterGroupKey` / `filterStoryTheatersByGroup` / `snapshotStoryCharacterGroupId`。
- `components/date/story/StoryTheater.tsx`：
  - 列表顶部「全部 / 各分组 / 未分组」筛选（没建过分组的用户整条不渲染）；
  - `saveEntry` / `persistEntryInSession` 保存时写入快照（已有快照不改写；混合/未分组/参与者缺失不写）。
- 旧剧情无快照 → 列表按当前 participants 推断（全部同组才归入）；角色换组不影响已快照剧情。

## A2. 分组共享世界书

- `CharacterGroup.worldbookIds?: string[]`：全局 `Worldbook.id` 引用，不复制正文。
- `utils/groupWorldbooks.ts`（新）：**唯一 canonical 合并点** `getEffectiveMountedWorldbooks(char)` =
  个人 `mountedWorldbooks` + 所属分组引用的全局世界书（按 id 去重，个人版本优先）。
  OSContext 启动后注入 getter snapshot（每次取最新 state）。
- 四个读取点全部改为走该合并点（无重复逻辑）：
  - `utils/context.ts` `ContextBuilder.buildCoreContext`（Chat/Meet system prompt）
  - `utils/chatRequestPayload.ts`（Chat depth 注入）
  - `utils/datePrompts.ts`（Meet depth 注入）
  - `utils/storyTheater.ts` `dedupeTheaterWorldbooks`（Story 世界书池）
- 分组被删 / 世界书不存在 → 安全忽略；0 额外 AI 调用；`deleteWorldbook` 顺手清理分组引用。
- UI：神经链接 → 角色分组管理弹窗内，每组新增「共享世界书」多选（`书 N` 按钮）；
  OSContext 新增 `updateCharacterGroup(id, updates)`。

## B. 留音海螺（Message Favorites）

- `MessageFavorite`（types.ts）+ `message_favorites` store（**DB_VERSION 76 → 77**；
  `sourceMessageId` 唯一索引 + `id = mfav-<sourceMessageId>` 双保险幂等）。
- `utils/messageFavoriteCapture.ts`（新）：文字/语音/图片分类 + 快照构造
  （图片 mediaRef=消息 content；语音 mediaRef=`voice_msg_<id>` assets key；文字截断 8000 字）。
- `ChatModals` 消息长按菜单新增「收藏到留音海螺 / 已收藏（点按取消）」，不破坏
  复制、回复、TTS、撤回等既有项；iPhone 长按走既有 MessageItem 长按管线（无系统文本选择冲突）。
- 新 App `apps/MessageFavoritesApp.tsx`（AppID `MessageFavorites`，图标 Waveform）：
  全部角色/各角色筛选 + 全部/文字/语音/图片筛选；语音可回放（assets 恢复）、图片可全屏、
  文字直显；取消收藏只删收藏记录，不动原消息。已加入 Launcher / INSTALLED_APPS / PhoneShell / safeArea。
- 收藏是快照：原消息删除后收藏仍保留可读。

## C. 相册

- C1 删除入口：详情页「永久删除这张照片？」确认 + 网格缩略图**长按删除**（同一确认框）；删除后立即消失。
- C2 角色生图自动入相册：canonical 成功落图点 = `utils/chatPhotoGeneration.ts` `runChatPhotoGeneration`
  成功路径（content 已替换 blobref 且 status='ready'）→ `utils/gallerySync.ts`（新）
  `syncAssistantPhotoToGallery`，gallery id = `chatphoto-<messageId>`（幂等；重试/重放/恢复不重复；
  失败路径 fail 提前返回不入相册）。用户手动发图路径不变。
- C3 Blob GC：`deleteGalleryImageWithGC` 先删 gallery record；blobref 仍被
  messages / message_favorites / gifts / 其他 gallery 记录引用 → 保留 blob 只删记录；
  无引用 → 删除 blob asset 真正释放空间。远程 http 图不处理。相册渲染支持 blobref（`useBlobRefUrl`）。

## D. Backup / Restore

- `CharacterGroup.worldbookIds` 随 characterGroups 走；`StoryTheaterEntry.characterGroupId` 随 storyTheaters 走。
- `FullBackupData.messageFavorites`；导出走 `getAllFromStore`，恢复走替换式 `clearAndAdd`
  （不重复收藏、不触发 AI / 生图）；旧备份无该字段 → 跳过（正常恢复为空）。

## 不做（本批次）

音乐一起听 / Food / Economy / Autonomous / Keyboard / Shopping / 角色钱包 / 新 AI 调用 / 世界书正文复制 —— 均未触碰。

## 验证

- 定向测试（9 文件 93 用例，含新增 4 文件）：`utils/storyGroupFilter.test.ts`、
  `utils/groupWorldbooks.test.ts`、`utils/messageFavorites.db.test.ts`、`utils/gallerySync.test.ts`
  + 相邻回归 `db.charGroups / db.storyTheater / storyTheater / dateWorldbook / worldbook` — 全绿。
- `tsc --noEmit` = 0 错误（本批次新错误 0）。
- `pnpm build` exit 0；`MessageFavoritesApp` 独立 chunk 8.10 kB。
- Full regression：clean-main worktree cherry-pick 后跑一遍（见发布记录）。

## 关键文件

types.ts · utils/db.ts · utils/groupWorldbooks.ts(新) · utils/gallerySync.ts(新) · utils/messageFavoriteCapture.ts(新) ·
utils/chatPhotoGeneration.ts · utils/context.ts · utils/chatRequestPayload.ts · utils/datePrompts.ts · utils/storyTheater.ts ·
components/character/CharacterGroupFilter.tsx · components/date/story/StoryTheater.tsx · components/chat/ChatModals.tsx ·
apps/Chat.tsx · apps/Gallery.tsx · apps/Character.tsx · apps/MessageFavoritesApp.tsx(新) · apps/Launcher 注册（constants.tsx / PhoneShell.tsx / safeAreaApps.ts）· context/OSContext.tsx
