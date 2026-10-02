# Lemuria 全局生图 → 礼物系统交接

## 状态

- Phase 1 实现 commit：`00c9d46f`
- 门禁修复 commit：`07d9b3a8`
- 部署状态：`DEPLOYED`。Phase 1 已合并至 main commit `12dc57b9`；GitHub Pages run `33084713348`（run #11）于 2026-08-27 成功。生图/备份专项 51/51、待部署干净 main 全量测试 288 files / 3765 tests 与生产 build 均通过。真实 API 仍未调用。
- 真实 API：未测试；必须由用户在部署后的设置页用自己的 Key 手动点击“测试生图”。自动测试全部使用 mock。
- 本阶段只提供全局生图基础设施；没有实现礼物 App、角色主动发图、自拍触发或外卖。

## 精确路径

- 设置入口：[apps/Settings.tsx](../../apps/Settings.tsx)，独立组件：[components/settings/ImageGenerationSettings.tsx](../../components/settings/ImageGenerationSettings.tsx)
- 公共类型：[types.ts](../../types.ts)：`ImageGenerationConfig`、provider/resolution/aspect-ratio 类型；备份字段 `FullBackupData.imageGenerationConfig`
- 本机配置：[utils/imageGenerationConfig.ts](../../utils/imageGenerationConfig.ts)，key 为 `os_image_generation_config_v1`
- 统一服务与 adapters：[utils/imageGenerationService.ts](../../utils/imageGenerationService.ts)
- 备份接线：[context/OSContext.tsx](../../context/OSContext.tsx)；localStorage→IndexedDB 防驱逐镜像：[utils/lsMirror.ts](../../utils/lsMirror.ts)
- 测试：[utils/imageGenerationConfig.test.ts](../../utils/imageGenerationConfig.test.ts)、[utils/imageGenerationService.test.ts](../../utils/imageGenerationService.test.ts)、[utils/lsMirror.test.ts](../../utils/lsMirror.test.ts)

## 唯一调用方式

React/App 不得直接 `fetch` 第三方生图接口，只调用统一服务：

```ts
import { generateImage, listAvailableModels } from '../../utils/imageGenerationService';
import { loadImageGenerationConfig } from '../../utils/imageGenerationConfig';

const models = await listAvailableModels(loadImageGenerationConfig()); // UI 不得自行 fetch /models

const result = await generateImage({
  prompt: '一只放在深蓝丝绒盒中的银色海浪胸针',
  referenceImages: [avatarDataUri, costumeHttpUrl], // 可选，最多 5 张
  resolution: '2K',                                // 可省略，读取全局默认
  aspectRatio: '1:1',                              // 可省略，读取全局默认
  style: 'product photography, soft rim light',
  signal: abortController.signal,
});

const first = result.images[0]; // { source, url, mimeType, revisedPrompt? }
```

`referenceImages` 每项可为 URL、裸 base64、data URI，或 `{ data?, url?, mimeType?, name? }`。未来角色参考图按稳定顺序传 3–5 张；不要在 prompt 中塞 base64，也不要让 UI 自己转换 provider payload。配置关闭、参考图禁用、超过 5 张都会在请求前失败。

## Provider 契约

| provider | 请求 | 图片响应 | 参考图 |
|---|---|---|---|
| `gemini-native` | `POST {base}/v1beta/models/{model}:generateContent`；Key 放 `x-goog-api-key`；`contents[].parts` + `generationConfig.responseModalities/imageConfig` | `candidates[].content.parts[].inlineData` / `inline_data`，也兼容 `fileData` URL | 支持；URL/blob 先读取为 inline base64，最多 5 张 |
| `openai-images` | `POST {base}/images/generations`；Bearer；JSON 含 `model/prompt/n/size/response_format` | `data[].url`、`b64_json`、`base64`、data URI | adapter 明确不支持并抛 `REFERENCE_NOT_SUPPORTED`；不得静默丢图 |

模型刷新也只走统一 service/provider adapter：Gemini Native 与 OpenAI Images 分别沿用各自认证，调用规范化 API root 的 `GET /models`。结果统一为 `id/displayName/provider/supportedMethods/imageCapability/protocolCompatibility`；Gemini 的 `models/` 前缀会被清理。空列表、无 `/models` 或刷新失败时必须保留手动模型 ID 回退。

服务统一处理超时、外部取消、401/403、空图片响应、网络/供应商错误；结果拒绝 `blob:` 地址。错误和日志不会包含完整 Key，也不返回原始敏感响应。设置页测试预览把结果转为临时 object URL，替换或卸载时会 `revokeObjectURL`。

## 持久化、备份和凭据

- 配置仅写当前设备的 localStorage 独立 key，并由现有 `assets/ls_mirror_v1` 镜像进 IndexedDB；PWA 重启可恢复，不需要 DB 升级。旧用户或损坏/缺字段配置会安全归一化到关闭状态与默认值。
- 与项目现有主 API/识图凭据策略一致：`text_only` 和 `full` 手动备份会原样包含生图配置（包括 Key），`media_only` 不包含；旧备份没有 `imageGenerationConfig` 时导入是 no-op。用户主动使用 WebDAV/GitHub 备份时，备份文件可能离开设备，礼物系统不得另做隐式上传。
- 永久图片先将 `GeneratedImage` 下载/转换成 `Blob`，再用 [utils/blobRef.ts](../../utils/blobRef.ts) 的 `putImageBlob()` 保存到 IndexedDB `blob_assets`，业务记录只存 `blobref:<id>`。渲染复用 `useBlobRefUrl()`；备份导出已有 `resolveBlobRefsDeep()` 管线。禁止持久化测试 object URL 或任何 `blob:` URL。
- 清除生图配置只删除生图 key，不修改主 API、识图 API、聊天或其他 IndexedDB 数据。

## 礼物系统应复用的领域能力

- 角色：`CharacterProfile`（[types.ts](../../types.ts)）与 `OSContext.characters/updateCharacter`；不要另建角色副本。
- 记忆：角色旧记忆为 `CharacterProfile.memories/refinedMemories/impression`；记忆宫殿使用 [utils/memoryPalace/index.ts](../../utils/memoryPalace/index.ts) 导出的检索/处理能力与 `MemoryNodeDB` 等现有库。写礼物记忆前先读 [docs/memory-system-overview.md](../memory-system-overview.md)，不要直接拼 `memoryPalaceInjection`（它是运行时字段）。
- 情绪：复用 `CharacterProfile.activeBuffs`、`buffInjection`、`emotionConfig` 以及现有情绪应用链；不要从礼物记录另造第二套情绪状态。
- 好感：仓库没有单一“全局好感”。查手机关系用 `PhoneContact.affinity`（-100..100）和 [utils/relationshipChat.ts](../../utils/relationshipChat.ts) 的 `clampAffinity/upsertContact`；家园角色间关系用 `WorldProfile.relationships: WorldRelationship[]`（0..100）。礼物功能必须先明确自己属于哪一关系域，禁止同时改两边。
- Living World：[utils/livingWorld/store.ts](../../utils/livingWorld/store.ts) 已提供 `get/ensure/saveLivingWorldState`、`get/saveAgentState`、`appendWorldEvent`、`listWorldEvents`；世界快照 adapter 在 [utils/livingWorld/adapters/worldHome.ts](../../utils/livingWorld/adapters/worldHome.ts)。礼物发生后可追加带 `refs` 的事件，不要绕过 append-only event ledger。

## `giftRecords` / `mediaAssets` 建议落点

- 在 [utils/db.ts](../../utils/db.ts) 的下一 DB 版本新增 `gift_records`（按 `id`，建议索引 `charId/createdAt/status`）和 `generated_media_assets`（轻量元数据，二进制仍进既有 `blob_assets`）store；升级只 `createStore`，旧库向前兼容。
- 类型放 [types.ts](../../types.ts)，DB CRUD 放 [utils/db.ts](../../utils/db.ts)，并在 `DB.getFullData/importFullData` 与 `FullBackupData` 明确接入。不要复用现有 `FullBackupData.mediaAssets` 名称：该字段已经表示角色头像/立绘/房间背景的备份聚合，不是通用媒体表。
- 建议 `giftRecords.mediaAssetId` 指向媒体元数据，媒体元数据保存 `blobRef/mimeType/width/height/provider/model/promptDigest/createdAt`；不要保存 Key、完整敏感请求或临时 URL。删除需先做引用检查，沿用 blobRef “宁留孤儿、不破图”的安全策略。

## 禁止重复实现/绕过

- 不得复制 provider fetch、配置 key、base64 解析、超时/取消或错误映射；只能扩展 adapter 或统一 service。
- 不得把生图配置塞进 `apiConfig.visionApi`，也不得用主/识图模型替代生图模型。
- 不得把图片大字符串常驻 React state/角色对象，或把 object URL 写数据库。
- 不得在礼物 App 内实现角色主动发图、自拍或外卖；这些是后续独立阶段。

## 验证命令与限制

```powershell
pnpm exec vitest run utils/imageGenerationConfig.test.ts utils/imageGenerationService.test.ts utils/lsMirror.test.ts utils/backupFormat.test.ts utils/backupRoundtrip.test.ts --reporter=dot
pnpm exec tsc --noEmit --pretty false
pnpm run build
```

门禁基线对照（Phase 1 父 commit `591e4673`）：同一条 `utils/chatPrompts.firePack.test.ts` 用例也因提示词文案已变为“你刚刚结束了语音通话”而失败，证明不是 Phase 1 回归；断言已改为验证稳定的模式切换标记。两个 worker suite 在 D: 工作区因 `vitest.config.ts` 使用 URL `.pathname` 生成跨盘符不可解析路径而未收集，而同一基线在 C: 临时 worktree 可收集并通过；配置现使用 Node `fileURLToPath()`，不涉及业务代码。

- OpenAI-compatible Images 的尺寸支持取决于供应商；adapter 发送按分辨率/比例计算的 `size`，不支持时供应商会返回标准化 `PROVIDER` 错误。
- Gemini Native 参考图 URL 受源站 CORS/鉴权限制。
- 当前没有 OpenAI-compatible Chat Image adapter；现有两种协议已覆盖当前架构，若未来供应商只能通过 chat 返回图片，应新增 adapter，不能在组件中分支。
