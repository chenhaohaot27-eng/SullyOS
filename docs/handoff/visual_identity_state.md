# Visual Identity State

角色视觉身份系统：Phase 2A–2E 已发布（main 2704f551）。
Phase 2F（多视觉形态预设）已完成（本地 dev，未提交）。

## 系统现状（截至 Phase 2F）

- 数据：`CharacterProfile.visualIdentity?`（legacy，保留）+ **`visualIdentityPresets?: VisualIdentityPreset[]` + `activeVisualIdentityPresetId?`**（Phase 2F 新增，全部可选，零迁移兼容）
- `VisualIdentityPreset = { id, name, description?, identity: VisualIdentity, createdAt, updatedAt }`
- 生图：`imageGenerationService` characterId → `getActiveVisualIdentity(char)`（active 预设优先，否则 legacy）→ Phase 2C 注入（prompt + references）→ Phase 2E 摄影语义
- UI：`VisualIdentityPanel`（Character.tsx identity 标签页）顶部「视觉形态」库 + 下方复用的简易/精细编辑面板
- ZIP：manifest 支持 `presetName / presetDescription`（可选，旧包兼容）

## Phase 2F 要点

**新增**：`utils/visualIdentityPresets.ts`（纯 helper）+ `utils/visualIdentityPresets.test.ts`（15 项）

- helper：`getActiveVisualIdentity / getActiveVisualIdentityPreset / createVisualIdentityPreset / renameVisualIdentityPreset / resolveActivePresetId / migrateLegacyVisualIdentityToPreset / deleteVisualIdentityPreset`（结构化 `VisualIdentityHost`，CharacterProfile 天然满足）
- 迁移：legacy → 「默认形态」直接复用原 blobRef（不写新 Blob）；legacy 字段保留（回退 + 共享引用方）；重复迁移返回 null
- 删除：只清理该预设独占的 Blob；被其他 preset / legacy 引用的 blobRef 保留；删除当前预设自动切到剩余第一套，无 preset 回退 legacy/空状态
- UI：形态卡（当前形态标记 / 设为当前 / 新建空白 / 内联重命名 / 删除 / legacy→形态迁移按钮）；编辑面板写入当前 active 预设（无预设时写 legacy，旧行为）
- ZIP：导入 = 新增 preset 并设为当前（不覆盖已有形态）；名称 presetName → ZIP 文件名 → 「导入形态」兜底；导出 = 当前 active 形态（写入 presetName/presetDescription，旧 importer 仍可读核心字段）
- 每套独立 5 张上限；切换由玩家手动完成，不做剧情自动识别 / 多形态混合 / AI 判断
- 文案已改：「启用后，角色生图会自动使用当前视觉形态的参考图与外观设定。」

## 历史阶段（已发布 main 2704f551）

- 2A 数据底座（types + utils/visualIdentity + blobRef 存储）
- 2B UI 面板（简易/精细）、生图设置折叠、RelayRouter /v1↔/v1beta
- 2C 生图注入（characterId → 参考图合并 + 身份 prompt；OpenAI 跳图保文字；DB.getCharacter）
- 2D ZIP 标准包（manifest + images/，失败清理孤儿 Blob）
- 2E 摄影语义（自拍/镜子/他拍/现实感/商业豁免，`utils/photoSemantics.ts`）

## 测试与构建（Phase 2F）

- 新增 15 项：兼容回退（legacy 无 presets / activeId 失效）、迁移不复制 Blob、创建/重命名、删除非当前/当前、共享 blobRef 不误删、独占 Blob 清理、service 级切换（prompt/references 随 active 预设切换、不混入其他 preset）、legacy 行为不变、characterId 隔离、ZIP 导入新增 preset 不覆盖、presetName 导出/再导入、旧 ZIP 无形态字段不报错
- 定向套件 12 个文件 129/129 通过（visualIdentity×6 + zip + photoSemantics + RelayRouter + SettingsSection + giftCharacterSend + chatPhotoIntent）
- tsc：本阶段文件 0 错误；build：workers ✓ + vite ✓ built in 35.86s

## Changed Files（Phase 2F，未提交）

- `types.ts`：+VisualIdentityPreset 接口 + CharacterProfile 两个可选字段（注意 types.ts 在 dev 树混有其他未提交改动，发布需按 2704f551 流程做部分暂存）
- `utils/visualIdentityPresets.ts`（新增）
- `utils/visualIdentityPresets.test.ts`（新增）
- `utils/imageGenerationService.ts`：注入点改用 getActiveVisualIdentity（+2 行）
- `utils/visualIdentityZip.ts`：manifest/导入/导出支持 presetName/presetDescription
- `components/character/VisualIdentityPanel.tsx`：形态库 UI + 预设路由写入 + ZIP 新语义 + 文案修正
- `apps/Character.tsx`：面板接线（onChangePatch 整体 patch）

## Blockers

- 无。dev 工作树仍有大量无关未提交改动（food/pin-lock/music 等），发布需筛选。

## Next

1. 发布 Phase 2F（沿 2704f551 流程：origin/main worktree + 部分暂存 types.ts + 定向测试 + ff push）
2. 可选：形态卡缩略图（当前仅文字卡）
3. 可选（明确超出本阶段）：剧情关键词自动切换形态
