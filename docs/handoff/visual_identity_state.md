# Visual Identity State

角色视觉身份系统：Phase 2A/2B/2C 已完成并发布（main e28aed13）。
Phase 2D（ZIP 导入/导出）+ Phase 2E（摄影语义修正）已完成（本地 dev，未提交）。

## 系统现状（截至 Phase 2E）

- 数据底座：`CharacterProfile.visualIdentity?`（types.ts）+ `utils/visualIdentity.ts`（blobRef CRUD/校验）
- UI：`components/character/VisualIdentityPanel.tsx`（简易/精细模式，挂在 apps/Character.tsx identity 标签页，key=formData.id 按 characterId 隔离）
- 生图注入：`utils/imageGenerationService.ts` characterId → DB.getCharacter → 参考图合并（主图→临时→其他，≤5 张）+ 身份 prompt；OpenAI 跳过图保文字
- 设置页：ImageGenerationSettings 自带折叠；RelayRouter /v1↔/v1beta 自动切换（utils/imageGenerationRelayRouter.ts）

## Phase 2D：视觉身份 ZIP 导入/导出

**新增**：`utils/visualIdentityZip.ts`（jszip，仓库既有依赖）+ `utils/visualIdentityZip.test.ts`

- 包结构：`VisualIdentity.zip = manifest.json + images/<role>.<ext>`
- manifest：`{ version, appearanceSummary, fixedTraits, variableTraits, identityStrength, references[{file, role, isPrimary}] }`
- 导出 `exportVisualIdentityZip(vi)`：参考图从 blobRef resolve 后写入 images/；文件名按 role（primary_face/front/...），去重后缀；只含 visualIdentity 数据，不含聊天/记忆/Key
- 导入 `importVisualIdentityZip(blob)`：
  - 标准 ZIP：恢复主图/role/文字字段；未标主图自动提升第一张；非法 role 规范化为 other
  - 普通 ZIP（无 manifest）：提取图片（role=other、首图主图），UI 进入人工整理（面板本身支持改主图/role/删除）
  - 上限仍 5 张，超出记入 `skippedFiles` 并 toast 提示
  - 失败（缺文件/manifest 损坏/非 ZIP）：明确报错并清理本次已写入的全部 Blob，不留孤儿
  - 图片走 putImageBlob → blob_assets，不写 base64 进 localStorage
- UI：VisualIdentityPanel 精细模式新增「导入/导出视觉身份包」；导入整体替换当前角色 references（旧 Blob 同步清理）；普通 ZIP 保留现有文字字段
- JSZip 在 Node 不能直接读写 Blob：统一先转 Uint8Array/arraybuffer（浏览器同样兼容）

## Phase 2E：摄影语义与现实感修正

**新增**：`utils/photoSemantics.ts` + `utils/photoSemantics.test.ts`
**接入**：`imageGenerationService.ts` 在 `identityPrompt + 原prompt` 之后调用 `applyPhotoSemantics(prompt, { identityActive })`，只在末尾追加 `[摄影约束]`，不改写原文

- 自拍（自拍/selfie/给你拍张自拍/发张自拍）→ 前置摄像头第一视角：手机本体不出现、允许轻伸手臂/肩膀、禁止第三人称拍到举手机、禁止屏幕朝外
- 镜子自拍（镜子自拍/mirror selfie）→ 才允许手机入画 + 合理镜面构图（不施加"手机不出现"约束）
- 他拍/街拍/偷拍/candid/第三人称 → 才允许第三人称镜头完整看到角色（含手持手机）
- 默认现实摄影约束（中英双语）：natural human anatomy / realistic hands / subtle natural veins / realistic skin texture / natural ambient light / ordinary smartphone photography；避免夸张血管、塑料 CGI 皮肤、过度锐化、过度修图、商业棚拍海报感
- 明确海报/商业摄影/插画/杂志封面 → 原样返回，不强压随手拍
- 触发条件：自拍/他拍语义，或 prompt 含拍照语境（照片/生活照/photo/…），或视觉身份启用；`visualIdentity enabled=false` 时对普通照片仍可用（拍照语义触发）
- 现有 9 项 imageGenerationService 集成测试不受影响（无语义 prompt 原样透传）

## 测试与构建

- 新增 23 项测试：visualIdentityZip 12（标准包导入/字段恢复/blobRef 写入/导出再导入/普通 ZIP/超 5 张/失败清理孤儿/characterId 隔离/旧角色兼容）+ photoSemantics 11（自拍/镜子/他拍/生活照现实感/商业豁免/原文保留）
- 定向套件 11 个文件 114/114 通过（visualIdentity* 5 + zip + photoSemantics + RelayRouter + SettingsSection + giftCharacterSend + chatPhotoIntent）
- tsc：本阶段文件 0 错误（仓库预存错误未动）
- build：workers ✓ + vite ✓ built in 35.46s

## Changed Files（Phase 2D/2E，未提交）

- `utils/visualIdentityZip.ts`（新增）
- `utils/visualIdentityZip.test.ts`（新增）
- `utils/photoSemantics.ts`（新增）
- `utils/photoSemantics.test.ts`（新增）
- `utils/imageGenerationService.ts`（prompt 链接入 applyPhotoSemantics，+6 行）
- `components/character/VisualIdentityPanel.tsx`（ZIP 导入/导出按钮 + 草稿同步 effect）

## Blockers

- 无。注意：dev 工作树仍含大量无关未提交改动（food/pin-lock/music 等），发布时需按 e28aed13 流程筛选提交。

## Next

1. 发布 Phase 2D/2E（沿上次发布流程：基于 origin/main 的 worktree + 定向测试 + ff push）
2. 可选：摄影语义阈值实测调优（关键词命中率 / 约束强度）
3. 可选：标准包跨设备迁移文档（docs/）
