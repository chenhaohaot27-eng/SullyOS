# 生图 API 多预设切换系统 — 实施报告

分支：`feat/imagegen-presets`（基于 `origin/main` @ 793ac306，隔离 worktree 开发，未触碰 `lemuria-rename` 等其他工作区）

## 修改文件

- `types.ts`：新增 `ImageGenerationAuthMode`、`ImageGenerationConfig.authMode?`、`ImageGenerationPreset`、`ImageGenerationPresetStore`、`FullBackupData.imageGenerationPresets?`
- `utils/imageGenerationPresets.ts`（新增）：预设集合存储（`os_image_generation_presets_v1`，版本化）、旧单配置无损迁移、CRUD、切换、备份导入导出、私有地址识别
- `utils/imageGenerationConfig.ts`：authMode 归一化（仅显式 `'none'` 生效，默认 `api-key`）
- `utils/imageGenerationService.ts`：无鉴权头处理、authMode 区分校验、混合内容失败提示
- `utils/imageGenerationRelayRouter.ts`：新增 `api.relayrouter.app` 域名识别（保留 `.ai`）
- `components/settings/ImageGenerationSettings.tsx`：接口预设选择器（原生 select）+ 新建/保存/重命名/删除 + 未保存修改守卫 + 鉴权模式 UI + 安全警告
- `context/OSContext.tsx`：备份导出/导入预设集合
- 测试：`utils/imageGenerationPresets.test.ts`（新增 16 例）、扩展 `imageGenerationRelayRouter.test.ts`、`imageGenerationService.test.ts`

## 预设保存与切换

- 每套预设 = `{ id, name, config(完整快照) }`，独立存储于 `os_image_generation_presets_v1`；`activeId` 永不指向不存在的预设。
- 切换通过 `activateImageGenerationPreset` → `saveImageGenerationConfig` 写入现有生效配置键并广播既有配置变更事件——聊天 SEND_PHOTO、角色主动发图、视觉身份/参考图、礼物、场景相机、设置页测试全部经由同一 `loadImageGenerationConfig()` 读取，天然同步。
- 预设间切换只恢复各自保存的原始 URL，不做 provider 相关改写；`.ai/.app` 版本路径改写仅发生在用户手动切换「接口模式」时。

## 无 Key 接口安全规则

- `authMode` 只有 `'api-key'`（默认）与 `'none'`；空 Key 不会自动降级为无鉴权。
- `'none'` 请求完全不发送 `Authorization` / `x-goog-api-key`（无 `Bearer undefined` 之类伪造值）。
- 普通云端预设空 Key：保存/启用校验与服务层校验均拒绝，不发请求。
- 公网地址选择无鉴权时显示明确安全警告（本地/私有/Tailscale 网段识别见 `isPrivateNetworkBaseUrl`）。
- HTTPS 页面访问 HTTP 本地接口失败时提示混合内容/CORS/连接安全，不误报为密钥错误。

## 旧配置迁移

首次读取预设存储且存在旧单配置时，自动无损转为「默认配置」预设并设为当前选中；旧 Key、模型、参数全部保留。清空/删除最后一个预设时移除旧配置键（恢复明确关闭状态），避免把默认值误判为待迁移旧配置。

## 测试与构建

- 定向测试 56 通过（6 个文件）；相关回归 172/173 通过。
- 既有失败（非本轮引入，origin/main 上同样失败）：`chatPhotoGeneration.test.ts`「不支持参考图的接口降级…」1 例；`tsc --noEmit` 在 MemoryPalaceApp/MessageItem/CompanionHome/sceneCameraService.test/visualIdentityIntegration.test 等处存在既有错误（本轮改动文件 0 新增错误）。
- `pnpm run build` 成功，私有 NPC 泄漏检查通过。

## 待用户实机验证

1. iPhone Safari / 安卓浏览器窄屏下的预设下拉与按钮布局无溢出。
2. 朋友的 ComfyUI（OpenAI-compatible `/images/generations`）实际生图与模型刷新。
3. RelayRouter `api.relayrouter.app` 真实调用。
4. 本地/Tailscale 无鉴权接口实际连通（HTTPS 页面 + HTTP 内网需代理）。
