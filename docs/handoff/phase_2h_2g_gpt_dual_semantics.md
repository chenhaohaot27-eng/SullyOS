# Phase 2H + 2G: GPT 生图 Provider + 双人合照语义增强

**完成时间**: 2026-09-26  
**状态**: ✅ 实现完成，代码已修改但构建环境不完整无法完整验证

---

## 变更文件

### 核心实现
1. **types.ts** - 新增 `gpt-images` provider 类型
2. **utils/imageGenerationService.ts** - 新增 `gptImagesAdapter`，支持参考图（通过 vision API）
3. **utils/imageGenerationRelayRouter.ts** - 支持 `gpt-images` 的 RelayRouter 路径切换
4. **utils/photoSemantics.ts** - 新增 `dual-selfie` 和 `dual-photo` 场景类型与语义约束
5. **utils/photoSemantics.test.ts** - 新增双人合照语义测试用例

### UI 配置
6. **components/settings/ImageGenerationSettings.tsx** - 新增 GPT Images 选项，更新说明文案

---

## Part A: GPT 生图 Provider（Phase 2H）

### 实现要点

**新增 provider: `gpt-images`**
- 类型定义：`ImageGenerationProvider = 'gemini-native' | 'openai-images' | 'gpt-images'`
- 支持参考图：`supportsReferenceImages: true`

**双路径实现**：
1. **无参考图**：直接调用 `/images/generations` 端点（与 openai-images 相同）
2. **有参考图**：切换到 `/chat/completions` + vision，将参考图作为 `image_url` content 传入

**Visual Identity 集成**：
- 当 `characterId` 提供时，自动注入当前 active preset 的参考图
- 参考图优先级：① isPrimary 身份图 → ② 临时参考图 → ③ 其他身份图
- 参考图上限：5 张（与 Gemini Native 一致）
- OpenAI Images 不支持参考图但保留文字身份约束；GPT Images 完整支持

**设置页显示**：
```
GPT Images
DALL-E 3 · 支持参考图 + 创意合照
```

---

## Part B: 双人合照语义增强（Phase 2G）

### 新增场景类型

```typescript
export type PhotoSceneKind =
    | 'selfie'            // 单人前置自拍
    | 'mirror-selfie'     // 镜子自拍
    | 'dual-selfie'       // 双人前置自拍 ✨ NEW
    | 'dual-photo'        // 双人合照（第三人称）✨ NEW
    | 'third-person'      // 他拍/街拍
    | 'commercial'        // 商业/海报/插画
    | 'general';          // 普通照片
```

### 语义识别规则

**dual-selfie（双人自拍）**  
关键词：`双人自拍|合拍|一起自拍|情侣自拍|和我自拍|together selfie|couple selfie`

约束逻辑：
- 前置摄像头第一人称视角
- 呈现两人脸部或上半身
- 保持自拍的亲密感与近距离感
- 允许创意动作、互动、拥抱、贴脸等
- 手机本体通常不出现
- 若无法确定用户外貌，可只显示局部（手臂/肩膀）

**dual-photo（双人合照）**  
关键词：`合照|双人照|情侣照|和我.*照|我和|photo together|photo with`

约束逻辑：
- 可以是第三人称视角
- 允许创意互动构图（近景+远景、借位、拥抱、背后环抱、镜面反射、错位透视）
- 展示完整互动场景与环境
- 若无法确定用户外貌，可局部或模糊呈现

### 优先级处理

匹配顺序（避免误捕）：
1. `mirror-selfie` - 镜子自拍（最高优先级）
2. `dual-selfie` - 双人自拍
3. `dual-photo` - 双人合照
4. `selfie` - 单人自拍
5. `third-person` - 他拍
6. `commercial` - 商业海报
7. `general` - 普通照片

**关键设计**：双人语义在通用"自拍"/"照片"之前判断，防止"双人自拍"被误识别为单人 `selfie`。

### 现实感约束

所有双人场景（`dual-selfie` / `dual-photo`）均附带现实摄影约束：
- 自然的身体比例与手部结构
- 真实皮肤质感（no plastic CGI skin）
- 普通智能手机随手拍感觉
- 避免过度锐化/磨皮/商业棚拍感

商业海报/插画请求不强压现实感（行为不变）。

---

## 核心设计决策

### 1. GPT Provider 的参考图策略

**为什么走 chat/completions？**
- OpenAI `/images/generations` 端点不原生支持参考图
- Chat Completions + Vision 可以传入 `image_url` content，让模型"看到"参考图后生成
- 实际生成可能仍需依赖 DALL-E 工具调用或后端逻辑（取决于中转/官方实现）

**回退兼容**：
- 无参考图时直接走 `/images/generations`（与 openai-images 行为一致）
- 有参考图时切换到 vision 路径

### 2. 双人语义不写死玩家外貌

**设计原则**：
- 系统不假设玩家的固定视觉形象
- prompt 只指导"双人构图感"，不硬编码玩家长相
- 若模型无法推断用户外貌，允许只显示局部（手臂/肩膀）或模糊呈现

**未来扩展方向**（留作后续）：
- 用户上传固定视觉身份参考图
- 存储为 `userVisualIdentity` 字段
- 双人图时同时注入角色+用户参考图

### 3. 只追加约束，不覆盖原 prompt

**Phase 2E 原则延续**：
```
[用户原始 prompt]

[摄影约束] [场景语义约束] + [现实感约束]
```

剧情原文完整保留在开头，语义约束追加在末尾，不改写用户意图。

### 4. 特殊形态兼容（人鱼预设等）

当前实现：
- 双人/自拍语义不会压掉角色的特殊形态（尾巴/长发/非人类特征）
- Visual Identity 的 active preset 会注入对应形态的参考图
- 商业海报请求仍可豁免现实感约束

**已知限制**：
- 如果用户 prompt 明确"人类腿部"且当前是人鱼形态，可能产生冲突
- 建议用户在切换形态后明确说明场景（"在水下"/"在陆地上"）

---

## 测试覆盖

### 已编写测试用例（photoSemantics.test.ts）

**新增测试区块**：
```typescript
describe('photoSemantics — 双人合照语义 (Phase 2G)', () => {
    it('双人自拍 → 前置自拍感双人构图')
    it('中英文双人自拍关键词命中')
    it('双人合照（非自拍）→ 允许第三人称视角与创意构图')
    it('中英文双人合照关键词命中')
    it('双人语义优先级高于通用自拍/照片（避免误捕）')
})
```

**回归测试**：
- 单人自拍/镜子自拍/他拍语义不变
- 现实感约束仍对所有非商业场景生效
- 商业海报豁免逻辑不变
- 原 prompt 完整保留在开头

### 验证状态

**构建环境问题**：
- 本地缺少 `vitest` / `vite` 可执行文件
- `pnpm install` 已完成但 `node_modules/.bin/` 缺失
- 无法运行自动化测试与构建验证

**已完成人工检查**：
- ✅ TypeScript 类型定义一致
- ✅ 所有 provider 引用更新（types / service / relay router / settings UI）
- ✅ 双人语义识别逻辑与测试用例匹配
- ✅ 参考图优先级与上限控制保持清晰
- ✅ 代码无语法错误（编辑器未报错）

---

## Blockers

### 构建环境不完整

**现象**：
- `pnpm test` / `pnpm build` 报 `'vitest' 不是内部或外部命令`
- `pnpm install` 已执行但未生成 `.bin/` 可执行文件
- Windows 路径或 pnpm 版本兼容性问题（pnpm 11.22.0）

**影响**：
- 无法运行单元测试验证双人语义逻辑
- 无法执行完整构建验证 TypeScript 类型检查
- Worker 打包成功但 Vite 主构建未能执行

**建议排查**：
1. 检查 pnpm 全局安装与 workspace 配置
2. 清除 `node_modules` 后重新 `pnpm install`
3. 尝试 `npm install` 或 `yarn` 作为对照
4. 检查 Windows 长路径支持（中文路径可能有问题）

### GPT Provider 实际端点行为未测试

**现状**：
- 代码逻辑已实现：无参考图走 `/images/generations`，有参考图走 `/chat/completions`
- 未使用真实 OpenAI API Key 测试端点响应
- chat/completions 路径的图片生成可能依赖工具调用或特定模型行为

**风险**：
- 实际调用时可能需要调整 prompt / message 结构
- 图片提取逻辑（从 chat response 中找 URL）可能需要完善
- 不同中转站对 vision + 图片生成的支持情况不同

**建议**：
- 配置真实 GPT API 后在设置页点"测试生图"
- 检查响应格式是否符合 `normalizeImageGenerationResponse` 预期
- 必要时补充 GPT-specific 的响应解析逻辑

---

## 下一步建议

### 短期（修复构建环境）
1. **排查 pnpm/vitest 安装问题**，确保测试可运行
2. **运行完整测试套件**，验证双人语义无回归
3. **执行 `pnpm build`**，确认 TypeScript 类型检查通过
4. **真实 API 测试**：配置 GPT Images API Key，测试参考图生图流程

### 中期（功能完善）
1. **用户视觉身份上传**：允许用户上传自己的参考图，双人图时注入
2. **GPT Provider 响应优化**：根据真实端点行为完善图片提取逻辑
3. **特殊形态冲突检测**：当 prompt 与 active preset 形态冲突时提示用户
4. **更多双人场景**：支持"视频截图感双人互动""电影海报风格双人合照"等进阶语义

### 长期（质量与体验）
1. **生图质量评测**：对比 Gemini Native / GPT Images / OpenAI Images 在双人图、特殊形态下的表现
2. **参考图自动筛选**：根据 prompt 场景智能选择最匹配的 visual identity preset
3. **语义冲突自动修正**：检测"人鱼形态 + 在陆地跑步"等矛盾并自动调整 prompt
4. **多语言语义识别**：扩展对日语、韩语等双人合照关键词的支持

---

## 总结

**Phase 2H 完成度**：✅ GPT provider 已接入，架构整洁，参考图路径已实现  
**Phase 2G 完成度**：✅ 双人自拍/合照语义已增强，测试用例已编写，优先级清晰  
**构建验证**：⚠️ 环境问题导致无法运行自动化测试与完整构建  
**实际可用性**：⚠️ GPT provider 端点行为需真实 API 测试验证

代码逻辑完整且清晰，核心功能已实现。待构建环境修复后执行测试验证，再配置真实 API 进行端到端验证即可正式投入使用。
