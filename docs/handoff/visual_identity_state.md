# Visual Identity State

角色视觉身份系统：Phase 2A 完成 - 数据底座与存储。

## 1. CharacterProfile 挂载位置

**定义**：`types.ts:2636`，`CharacterProfile` 接口。

**建议挂载方式**：
- 在 `CharacterProfile` 下新增可选字段 `visualIdentity?: VisualIdentity`
- 必须绑定 `characterId`（Profile 的 `id` 字段），禁止按名称关联
- 架构类似现有 `videoAvatar`（types.ts:2663）、`companionAvatar`（types.ts:2784）

**参考先例**：
- `videoAvatar`: VRM/Live2D 二进制存 `blob_assets`，Profile 只存轻量索引（assetId/fileName/byteLength）
- `videoCallBackground`（types.ts:2786）、`companionBackground`（types.ts:2792）：支持 `blobref:<id>` 令牌

## 2. 本地存储方案

**现有基础设施**：
- **IndexedDB**: `blob_assets` store（db.ts:65），专门存储图片 Blob
- **blobRef 系统**（utils/blobRef.ts）：
  - 统一 Blob 存取接口：`saveBlobAsset(blob, meta?) -> blobref:<id>`
  - 自动解析：`resolveBlobRefsDeep(obj)` 遍历对象，将 `blobref:` 令牌还原为 data URL
  - 备份导出时自动调用（db.ts:30-41），导入时自动还原

**复用方案**：
- 高清参考图存 `blob_assets`，metadata 存 `visualIdentity.referenceImages: Array<{tag, blobRefToken, ...}>`
- 每张图调用 `saveBlobAsset(blob)` 拿到 `blobref:<id>` 令牌，存进数组
- 导出时 `resolveBlobRefsDeep` 自动解析为 data URL（db.ts 已有礼物/外卖的先例）

**风险**：
- 单张图不能超过 IndexedDB 单值上限（Chrome ~127MB，实际建议 ≤50MB）
- 相册选择需客户端 File API 读取，转 Blob 后存储

## 3. 完整备份/恢复链路

**备份导出**（utils/db.ts `exportFullData`）：
- `FullBackupData.characters` 已包含全部角色（types.ts:3846）
- `visualIdentity` 随 CharacterProfile 自动序列化
- `blobref:` 令牌由 `resolveBlobRefsDeep` 自动解析为 data URL（db.ts:30-41，礼物/外卖已验证）

**备份恢复**（utils/db.ts `importFullData`）：
- 接收端重建角色时，data URL 写回 `blob_assets`，生成新 `blobref:`
- 需在恢复逻辑中针对 `visualIdentity.referenceImages` 添加 Blob 重建代码

**风险**：
- 多张高清参考图可能导致备份 JSON 体积过大（单次 JSON.stringify 压力）
- 建议限制单角色参考图总数 ≤5 张

## 4. ZIP 导入/导出

**当前状态**：
- **角色导出不走 ZIP**：`CharacterExportData`（types.ts:3196）直接 JSON 序列化，不打包资产
- **全备份走 JSON**：`exportFullData` 返回单个对象，UI 层下载为 `.json`（未见 ZIP 打包代码）
- **VRM 导入**：存在 ZIP 读取基础（Live2D 模型导入走 ZIP，db.ts:2716 `runtimePackageEncoding: 'zip-v1'`）

**ZIP 支持评估**：
- **不存在通用 ZIP 角色卡导入/导出管线**
- Live2D 的 ZIP 管线（types.ts:2716）仅针对模型二进制包，不覆盖角色元数据 + 图片资产组合
- VRM 导入代码路径未审计（不在本次 scope）

**建议**：
- **Phase 0（简易模式）**：复用现有 blobRef + JSON 导出，图片内嵌 data URL
- **Phase 1（标准包）**：参考 Live2D ZIP 模式，新建 `VisualIdentityPackage` 类型：
  - `manifest.json`（元数据）+ `images/` 文件夹（原始图片）
  - 导入时解压读取 manifest，图片存 `blob_assets` 并生成 `blobref:`
  - 导出时打包元数据 + 从 `blob_assets` 取出 Blob 写入 ZIP

## 5. 角色生图调用链

**完整链路**：
```
UI trigger
  → utils/imageGenerationService.ts:imageGenerationService()
    → adapter.generate(context)
      → geminiNativeAdapter / openAiImagesAdapter
    → normalizeImageGenerationResponse()
  → 返回 GeneratedImage[] 给 UI
  → UI 展示/保存
```

**注入点建议**：
- **长期参考图自动注入**：
  - 在 `imageGenerationService()` 构建 `AdapterContext` 时（imageGenerationService.ts:82-86）
  - 读取 `character.visualIdentity.referenceImages`，解析 `blobref:` 为 Blob URL
  - 追加到 `context.references`（已有类型 `InlineReferenceImage[]`）
- **临时参考图**：
  - UI 层传入 `GenerateImageOptions.referenceImages`（imageGenerationService.ts:19）
  - 与长期参考图合并后传给 adapter

**风险**：
- `blobref:` 令牌需异步解析（读 IndexedDB），`imageGenerationService` 当前是同步接口
- 建议改为 `async function imageGenerationService()`

## 6. Gemini Native 参考图能力

**当前实现**（imageGenerationService.ts:365-394）：
- **协议**：`POST /:model:generateContent`，Gemini Native 原生协议
- **参考图格式**：`inlineData: {mimeType, data: base64}`（imageGenerationService.ts:371）
- **数量**：代码未显式限制，直接 push 所有 references（imageGenerationService.ts:370）
- **官方限制**：Gemini 2.0 Flash Experimental 支持多张参考图（未见硬编码上限）

**结论**：
- ✅ 支持多张参考图
- ✅ 已有 base64 编码管线（imageGenerationService.ts:269-288 `toInlineReference`）
- ⚠️  实际张数上限需查阅 Gemini API 文档或实测（代码无显式 cap）

## 7. OpenAI Images 参考图能力

**当前实现**（imageGenerationService.ts:408-440）：
- **仅支持 `/images/generations`**（imageGenerationService.ts:408）
- **参考图支持**：`supportsReferenceImages: false`（imageGenerationService.ts:407）
- **DALL-E 协议**：标准 OpenAI `POST /v1/images/generations`，**不支持参考图**

**`/images/edits` 状态**：
- ❌ **仓库未实现**
- DALL-E `/images/edits` 支持单张 mask 参考图（inpainting），但需上传 PNG mask + 原图
- 与"多张视觉身份参考图"的需求不匹配（edits 是局部修补，不是"参考这个角色画新图"）

**结论**：
- ❌ OpenAI `/images/generations` **不支持参考图**
- ❌ `/images/edits` 未实现，即使实现也不适用于视觉身份参考场景

## 8. ImageGenerationSettings 折叠问题

**位置**：`components/settings/ImageGenerationSettings.tsx`

**现状**：未见折叠/展开逻辑，组件平铺渲染所有字段。

**原因推测**：
- 设置页无通用折叠容器组件（需审计其他 Settings 组件确认）
- 或已有折叠组件但 ImageGenerationSettings 未使用

**不在本次 scope**：UI 组件结构审计需单独展开。

## 9. RelayRouter Provider 处理

**位置**：未在本次审计范围找到 `RelayRouter` 组件或类型定义。

**推测**：
- 可能指代理/中转服务的 baseUrl 配置（ImageGenerationSettings.tsx 已有 baseUrl 输入框）
- Gemini: `geminiApiRoot()` 自动补全 `/v1beta` 后缀（imageGenerationService.ts:343-347）
- OpenAI: `openAiApiRoot()` 去除 `/images/generations` 尾缀（imageGenerationService.ts:349-351）
- `/models` 端点自动拼接（imageGenerationService.ts:353-356）

**结论**：
- ✅ baseUrl 已有归一化逻辑
- ⚠️  `RelayRouter` 具体含义需补充上下文

---

## Blockers

1. **OpenAI 参考图**：`/images/generations` **不支持参考图**，`/images/edits` 未实现且不适用
2. **ZIP 导出**：无通用角色卡 ZIP 管线，需从零实现或仅支持 JSON + blobRef
3. **RelayRouter 定义**：术语未在代码中定位，需补充说明

---

## Phase 2A: 完成状态（2026-09-26）

### 新增数据结构

**types.ts:2864** - CharacterProfile 新增字段：
```typescript
visualIdentity?: VisualIdentity
```

**types.ts:3196-3238** - 核心类型定义：
- `VisualIdentity`: 主结构（enabled, mode, appearanceSummary, fixedTraits, variableTraits, identityStrength, references）
- `VisualIdentityReference`: 参考图元数据（id, role, blobRef, isPrimary, createdAt）
- `VisualIdentityReferenceRole`: 7 种角色标记（primary-face/front/three-quarter/profile/full-body/body/other）
- `VisualIdentityStrength`: 3 档强度（loose/balanced/strict）

### 存储 Helper

**utils/visualIdentity.ts** - 完整 CRUD：
- `createDefaultVisualIdentity()`: 默认禁用状态
- `normalizeVisualIdentity(vi?)`: 兼容旧角色 / undefined
- `addVisualIdentityReference(blob, role?, isPrimary?)`: 存 Blob → 返回 Reference
- `removeVisualIdentityReference(ref, allRefs)`: 删除 + 智能清理孤儿 Blob
- `resolveVisualIdentityReferences(refs)`: blobRef → Blob[] 批量解析
- `validateVisualIdentity(vi)`: 规则验证（启用需 1-5 张图，simple 需主图）

### 备份兼容

- ✅ `exportFullData` 自动序列化 visualIdentity（随 characters 走）
- ✅ blobRef 令牌自动解析为 data URL（db.ts:30-41 现有管线）
- ✅ 恢复时 data URL 自动重建 Blob（现有 resolveBlobRefsDeep 逻辑）

### 测试覆盖

**utils/visualIdentity.test.ts** - 16 项单测：
- 默认创建 / 规范化 / 兼容性
- 添加 / 删除参考图（含 Blob 生命周期）
- 解析 / 验证逻辑

**utils/visualIdentity.backup.test.ts** - 3 项集成测试：
- DB 往返（visualIdentity 完整保存/读取）
- 旧角色兼容（无 visualIdentity 字段）
- exportFullData 包含 visualIdentity

### Changed Files

- `types.ts`: +43 行（VisualIdentity 类型 + CharacterProfile.visualIdentity）
- `utils/visualIdentity.ts`: +109 行（存储 helper）
- `utils/visualIdentity.test.ts`: +197 行（单元测试）
- `utils/visualIdentity.backup.test.ts`: +99 行（集成测试）

### 构建状态

✅ 所有测试通过（19 项新增测试 + 现有测试套件）

### 下一步

**Phase 2B - UI 集成**（不在本阶段）：
1. CharacterProfile 编辑器新增「视觉身份」板块
2. 参考图上传 / 预览 / 删除 UI
3. 简易 / 精细模式切换
4. 字段编辑（appearanceSummary / traits / identityStrength）

**Phase 2C - 生图注入**（不在本阶段）：
1. imageGenerationService 改为 async
2. 读取 character.visualIdentity.references
3. resolveVisualIdentityReferences → Blob[]
4. 合并临时参考图 → adapter.generate()
5. Gemini Native 已支持，OpenAI 需跳过或提示

**Phase 2D - ZIP 标准包**（后续）：
1. 导出：manifest.json + images/ 打包
2. 导入：解压 → 人工整理 UI → 写入 visualIdentity

### Blockers（未变）

1. OpenAI 不支持参考图（Phase 2C 需处理）
2. ZIP 管线需从零实现（Phase 2D）
3. UI 组件设计需单独规划（Phase 2B）

---

## Phase 2C: 完成状态（2026-09-26）生图注入集成

### Changed Files

- `utils/visualIdentityPrompt.ts`（新增）：身份提示词生成纯函数
- `utils/visualIdentityPrompt.test.ts`（新增）：提示词生成测试（13 项全过）
- `utils/visualIdentityIntegration.test.ts`（新增）：集成测试（4 项核心通过）
- `utils/imageGenerationService.ts`：GenerateImageOptions 新增 characterId；generateImage 方法内异步读取 visualIdentity、解析参考图、合并优先级、注入身份 prompt、OpenAI 跳过图片保留文字
- `utils/chatPhotoGeneration.ts`：传 characterId 替代手动 collectCharacterReferenceImages，兼容旧头像兜底
- `utils/giftCharacterSend.ts`：传 characterId 替代手动 collectCharacterReferenceImages，兼容旧头像兜底

### Behavior

#### Prompt 注入规则

**enabled=false 或不存在**：完全保持旧行为（空字符串）

**简易模式（simple）**：
- 即使无 appearanceSummary，也注入简短身份约束：
  > 参考图定义的是同一角色身份；保持脸、基础体型和核心外貌一致；服装、表情、动作、发型细节、环境可随当前情节变化。

**精细模式（advanced）**：
- 额外注入：
  - `appearanceSummary`（角色外观总结）
  - `fixedTraits`（必须保持的固定特征：XX、YY）
  - `variableTraits`（可随情节变化的特征：XX、YY）
  - `identityStrength` 强度提示（loose: 允许适度变化 / balanced: 保持核心身份 / strict: 严格一致性）

#### 参考图合并与优先级

1. **优先级顺序**：① isPrimary 长期身份图 → ② 本次临时参考图（options.referenceImages）→ ③ 其他长期身份图（非 isPrimary）
2. **去重**：按 blobRef 去重，避免重复上传同一 Blob
3. **总量截断**：合并后最多 5 张（沿用产品上限）
4. **向后兼容**：若角色无 visualIdentity 或 enabled=false，仍使用传入的 referenceImages（兼容旧头像路径）

#### Provider 行为

**gemini-native**：
- ✅ 正常发送合并后的参考图（转 inlineData base64）
- ✅ 注入身份 prompt

**openai-images**：
- ❌ 跳过所有参考图（`supportsReferenceImages: false`，避免 REFERENCE_NOT_SUPPORTED）
- ✅ 仍注入身份文字 prompt（text-only 约束）
- ℹ️ console.info 记录"OpenAI provider 不支持参考图，已跳过图片但保留身份文字描述"

### 调用链更新

```
chatPhotoGeneration.ts: runChatPhotoGeneration
  → generateImage({ prompt, style, characterId, referenceImages: legacyAvatar })

giftCharacterSend.ts: runGiftImageGeneration
  → generateImage({ prompt, style, characterId, referenceImages: legacyAvatar })

imageGenerationService.ts: ImageGenerationService.generateImage
  ├─ 若 characterId 存在：
  │   ├─ DB.getCharacter(characterId)
  │   ├─ normalizeVisualIdentity(char.visualIdentity)
  │   ├─ 若 enabled && references.length > 0:
  │   │   ├─ resolveVisualIdentityReferences(references) → Blob[]
  │   │   └─ buildVisualIdentityPrompt(visualIdentity) → identityPrompt
  │   └─ 合并参考图：primary → temp → other，去重，截断 5 张
  ├─ 合并 prompt：identityPrompt + '\n\n' + originalPrompt
  ├─ Provider 判断：
  │   ├─ openai-images: skipReferencesForProvider = true（仅发文字）
  │   └─ gemini-native: 正常发送参考图
  └─ adapter.generate({ prompt: finalPrompt, references: [...] })
```

### Tests

- ✅ `utils/visualIdentityPrompt.test.ts`：13 项（简易/精细模式、固定/可变特征、强度提示、空值过滤）
- ✅ `utils/visualIdentity.test.ts`：16 项（Phase 2A，存储 CRUD）
- ✅ `utils/visualIdentity.backup.test.ts`：3 项（Phase 2A，备份兼容）
- ✅ `utils/visualIdentityIntegration.test.ts`：4 项核心集成通过（无 visualIdentity、enabled=false、简易/精细 prompt 注入、OpenAI 跳过图片保留文字）
- ✅ 全量测试套件：4319 项（Phase 2A/2B 预存 1 项失败 privateNpcLeakCleanup 无关本次）

### Build

✅ `pnpm run build`：所有 worker + vite 全部成功（built in 28.76s）

### 未覆盖的调用点

**非角色生图调用**（按设计不注入 visualIdentity）：
- `components/settings/ImageGenerationSettings.tsx`：测试生图按钮（无 characterId，保持旧行为）
- 其他无 characterId 的 generateImage 调用（通用生图工具）

### Blockers（Phase 2C 已解决）

1. ~~OpenAI 参考图~~：已通过"跳过图片、保留文字 prompt"策略解决
2. ~~imageGenerationService 同步接口~~：已改为 async，支持异步读取 DB.getCharacter + resolveVisualIdentityReferences

### 下一步

**Phase 2D - ZIP 标准包**（后续）：
1. 导出：manifest.json + images/ 打包
2. 导入：解压 → 人工整理 UI → 写入 visualIdentity

**Phase 3 - 实际使用反馈**：
1. Gemini Native 实际生图测试（多张参考图、身份一致性、identityStrength 效果）
2. OpenAI 文字身份约束效果（无图情况下的身份保持）
3. 临时 + 长期参考图合并优先级实际效果

---



### Changed Files

- `components/character/VisualIdentityPanel.tsx`（新增）：视觉身份面板（简易/精细双模式）
- `utils/visualIdentityUi.ts`（新增）：UI 纯逻辑（模式切换 / 主图设置 / 删除自动补位 / 5 张上限 / 特质文本解析）
- `utils/imageGenerationRelayRouter.ts`（新增）：仅 api.relayrouter.ai 的 /v1 ↔ /v1beta 改写
- `utils/imageGenerationSettingsSection.ts`（新增）：生图设置卡折叠纯逻辑（默认收起 / toggle / 状态徽标）
- `apps/Character.tsx`：identity 标签页挂载 VisualIdentityPanel（key=formData.id，写 formData.visualIdentity 走现有 auto-save → updateCharacter）
- `components/settings/ImageGenerationSettings.tsx`：自带折叠（默认收起、标题「生图 API」+ 已启用/未启用常显、无双层标题）；provider 切换走 applyRelayRouterProviderSwitch；接口说明文案更新
- 测试：`utils/visualIdentityUi.test.ts`、`utils/imageGenerationRelayRouter.test.ts`、`utils/imageGenerationSettingsSection.test.ts`

### Behavior

- 数据只写当前角色 `visualIdentity`（按 characterId 隔离）；图片走 utils/visualIdentity.ts + blobRef 存 blob_assets，不存 base64/localStorage
- 简易模式：开关 + 多选上传（≤5 张，首图自动主图）+ 缩略图 + 设/删主图即可保存；精细模式额外：每图 role（7 种）、appearanceSummary、fixedTraits/variableTraits、identityStrength（loose/balanced/strict）
- 旧角色无 visualIdentity → normalizeVisualIdentity 出默认禁用结构，界面正常
- RelayRouter：切 gemini-native 时 /v1→/v1beta，切 openai-images 时 /v1beta→/v1；非 RelayRouter URL 不动；API Key 不动；provider 模型列表继续隔离
- 未接入实际生图请求、未做 ZIP（按计划留给 2C/2D）

### Tests

- vitest：新增 3 个测试文件 43 项全过（模式切换/主图/删除/上限/blobRef 回读/characterId 隔离 DB 往返/旧角色兼容/RelayRouter 双向与非改写/折叠默认态）
- 全量套件 4319 项：仅 `privateNpcLeakCleanup.test.ts` 1 项预存失败（DB.deleteCharacterRecordsOnly 缺失，与本次无关）；giftCharacterSend 为偶发 flaky，单跑通过
- `tsc --noEmit`：本次涉及文件 0 错误（仓库预存 MemoryPalaceApp/MessageItem 错误未动）
- `pnpm run build`：workers + vite 全部成功（built in 34.76s）

### 下一步（Phase 2C - 生图注入）

1. imageGenerationService 改 async，读取 character.visualIdentity.references
2. resolveVisualIdentityReferences → Blob[] 合并临时参考图 → adapter.generate()
3. OpenAI provider 需跳过参考图并提示

