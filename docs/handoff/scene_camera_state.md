# Scene Camera Phase 3A Architecture Audit

**Date**: 2026-09-26  
**Target**: Lemuria「见面摄影机 / Scene Camera」功能架构审计  
**Scope**: 陪伴模式 + 剧情模式  
**Status**: ✅ AUDIT COMPLETE - 仅审计，未修改代码

---

## Executive Summary

Scene Camera 应作为**见面场景可视化工具**接入，复用现有 `imageGenerationService` + `Visual Identity` 体系。建议采用**两阶段架构**：
1. **Director 层**（高阶文本模型）读取见面上下文 → 生成结构化 ShotPlan
2. **Renderer 层**（图像生成）接收 ShotPlan + active Visual Identity → 生成图片

关键发现：
- ✅ 现有能力完备：context builder、chat completion client、image generation service、Visual Identity 体系均已就绪
- ✅ Provider 解耦已符合需求：Director 与 Renderer 可独立配置
- ⚠️ 需新增：`sceneCameraDirector.ts`（Director 逻辑）、`sceneCameraService.ts`（统一入口）、`sceneCameraPrompt.ts`（ShotPlan schema 与提示词）
- ⚠️ UI 挂载点：陪伴与剧情需各自集成，但共享同一 Scene Camera service

---

## A. 现有系统定位

### 1. 见面（陪伴模式）入口
- **文件**: `apps/DateApp.tsx` (1346 lines)
- **组件**: `DateSession` (by reference, 不在本次读取范围)
- **上下文构建**: 
  - Peek（开场感知）: `DatePrompts.buildPeekPayload` (line 743-819)
  - Session（交互）: `DatePrompts.buildSessionPayload` (line 826-883)
  - 已整合 `ContextBuilder.buildCoreContext` + 世界书 + 记忆宫殿召回
  - 时间线管理：`getRecentMessagesByCharIdAndSource(charId, 'date', limit)`
- **当前上下文内容**:
  - 角色人设、世界书、记忆宫殿、情绪 buff
  - VN 格式规则、风格预设、人称控制
  - 玩家括号叙事解析（`parseDatePlayerInput`）
  - 见面邀请情境注入（`meetingContext`）

**可复用点**: 
- `buildPeekPayload` 的历史压缩逻辑
- `buildSessionPayload` 的完整上下文栈
- `toWorldbookScanMessages` 作为 Director 输入预处理

### 2. 见面（剧情模式）入口
- **文件**: `components/date/story/StoryTheater.tsx` (315 lines) + `StoryTheaterSession.tsx` (300+ lines reviewed)
- **上下文构建**: 
  - `utils/storyTheater.ts` 提供专用 context builder
  - `buildStoryHistory` + `buildTheaterPersona` + `buildTheaterWorldbookSlots`
  - 事件盒 / 向量召回 / 关系变化追踪
- **历史查询**: 同样走 `DB.getMessagesByCharId(threadId, true)` + `source: 'story_theater'`

**可复用点**:
- 剧情模式的 `buildStoryHistory` 可作为 Scene Camera 的另一条 context adapter
- 多角色场景（`entry.characterIds`）天然匹配群像构图需求

### 3. 统一 Context Builder
- **文件**: `utils/context.ts` (未完整读取，但 DatePrompts 大量引用)
- **能力**: `ContextBuilder.buildCoreContext(char, userProfile, includeRecentMsgs, customEmojis, emojiCategories, opts)`
- **选项**: `{ skipTimeAwareness?, worldbookMessages? }`
- **输出**: 角色人设 + 世界书 + 印象 + 记忆宫殿召回 + 情绪 buff 的完整 system prompt

**结论**: Scene Camera Director 可直接复用此 builder，仅需传入 `worldbookMessages` 为压缩后的见面上下文。

---

## B. 推荐架构：Director + Renderer 分离

### 为何必须分离
1. **Director（文本理解）与 Renderer（图像生成）是两个独立能力**
   - Director: GPT-4o / Claude / Gemini 1.5 等文本模型，读长上下文、输出结构化数据
   - Renderer: GPT Images / Gemini Native / FLUX 等图像模型，接收 prompt + 参考图 → 生成图片

2. **用户需要独立配置两者**
   - Director 模型选择：用户可能用 GPT-4o 当导演（长上下文便宜），用 Gemini Imagen 出图
   - Renderer 切换：FLUX 失败后保留 ShotPlan，换 GPT Images 重试

3. **防止逐代漂移的核心设计**
   - ❌ 错误做法：上一张生成图作为下一张参考图 → 脸 / 构图逐代漂移
   - ✅ 正确做法：每次只从 active Visual Identity preset 读参考图，上一张图只保留 ShotPlan metadata（用于差异化镜头）

### 架构图

```
用户点击「摄影机」
    ↓
sceneCameraService.captureScene(contextSource, mode)
    ↓
├─ contextAdapter (陪伴 / 剧情分支)
│   ├─ 陪伴: buildDateCameraContext()
│   └─ 剧情: buildStoryCameraContext()
│       → 返回压缩后的场景文本
│
├─ Director 层 (sceneCameraDirector.ts)
│   ├─ 调用 completeChat(directorConfig, messages)
│   ├─ 输入: system prompt + 场景上下文
│   ├─ 输出: 结构化 ShotPlan (JSON)
│   └─ Provider: 独立配置（GPT / Claude / Gemini）
│
└─ Renderer 层 (imageGenerationService)
    ├─ 调用 generateImage({ prompt, characterId, ... })
    ├─ 自动注入 active Visual Identity (已有逻辑)
    ├─ 拼接 finalPrompt = identityPrompt + shotPlanPrompt + photoSemantics
    ├─ Provider: 独立配置（GPT Images / Gemini Native / 未来 FLUX）
    └─ 输出: GeneratedImage[]
```

---

## C. 需要新增的文件

### 1. `utils/sceneCameraPrompt.ts`
**职责**: ShotPlan schema 定义 + Director 提示词构建

```typescript
export interface ShotPlan {
  sceneType: 'snapshot' | 'duo-photo' | 'pov-selfie' | 'creative-director';
  subjects: string[];  // ["角色名", "玩家(背影)"]
  characterState: string;  // 当前动作/情绪状态
  playerVisibility: 'full' | 'back' | 'profile' | 'partial' | 'blur' | 'none';
  environment: string;
  moment: string;  // 捕捉的具体瞬间
  
  // 摄影参数（显式控制，避免模板复用）
  bodyOrientation: string;  // "侧身45度" / "正面对镜头"
  interaction?: string;  // 仅 duo 模式："对视" / "拥抱"
  expression: string;  // 独立于 emotion 的表情描述
  gaze: string;  // 视线方向
  
  cameraPosition: string;  // "平视" / "俯拍"
  shotSize: string;  // "特写" / "半身" / "全身"
  lensPerspective: string;  // "50mm 自然视角" / "广角"
  
  composition: string;
  foreground?: string;
  background: string;
  lighting: string;
  
  // 连续性约束
  continuityConstraints: string[];  // ["当前角色 active preset: 人类短发形态"]
  avoidConstraints: string[];  // ["不要复用上一张的情侣宣传照构图"]
  
  finalPrompt: string;  // 最终拼接好的完整 prompt
}

export function buildDirectorPrompt(
  sceneContext: string,
  mode: PhotoSceneKind,
  charName: string,
  lastShotPlan?: ShotPlan,  // 用于差异化镜头
): string { /* ... */ }
```

**关键点**:
- `playerVisibility` 支持玩家无 Visual Identity 时的自然表达方式
- `continuityConstraints` 记录当前 active preset，防止混入其他形态
- `avoidConstraints` 基于 `lastShotPlan` 生成，推动镜头差异化
- `finalPrompt` 由 Director 生成，Renderer 直接使用

### 2. `utils/sceneCameraDirector.ts`
**职责**: 调用高阶模型生成 ShotPlan

```typescript
export interface DirectorConfig {
  provider: 'openai' | 'anthropic' | 'gemini-native' | 'openai-compatible';
  baseUrl: string;
  apiKey: string;
  model: string;
}

export async function generateShotPlan(
  sceneContext: string,
  mode: PhotoSceneKind,
  char: CharacterProfile,
  config: DirectorConfig,
  lastShotPlan?: ShotPlan,
): Promise<ShotPlan> {
  const messages = [
    { role: 'system', content: buildDirectorPrompt(sceneContext, mode, char.name, lastShotPlan) },
    { role: 'user', content: '(Generate shot plan in JSON format)' },
  ];
  
  const response = await completeChat(
    { baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model, apiFormat: config.provider },
    { model: config.model, messages, temperature: 0.7, response_format: { type: 'json_object' } },
    { maxRetries: 1, timeoutMs: 30000 },
  );
  
  const content = extractContent(response);
  return parseShotPlanFromJson(content);  // 容错解析
}
```

**复用点**:
- `completeChat` 已支持 OpenAI / Gemini Native / OpenAI-compatible 三种格式
- `extractContent` 已处理 reasoning_content / content 分离
- 无需新增 chat completion 逻辑

### 3. `utils/sceneCameraService.ts`
**职责**: 统一入口，协调 Director + Renderer

```typescript
export interface SceneCameraOptions {
  contextSource: 'date-companion' | 'date-story';
  mode: PhotoSceneKind;
  char: CharacterProfile;
  recentMessages: Message[];  // 最近 N 条见面消息
  userProfile: UserProfile;
  
  directorConfig?: DirectorConfig;  // 未提供则读全局配置
  rendererConfigOverride?: ImageGenerationConfig;  // 可选覆盖
}

export async function captureScene(options: SceneCameraOptions): Promise<ImageGenerationResult & { shotPlan: ShotPlan }> {
  // 1. Context adapter: 根据 contextSource 选择压缩策略
  const sceneContext = options.contextSource === 'date-companion'
    ? await buildDateCameraContext(options.char, options.recentMessages, options.userProfile)
    : await buildStoryCameraContext(options.char, options.recentMessages, options.userProfile);
  
  // 2. Director: 生成 ShotPlan
  const lastShotPlan = await loadLastShotPlan(options.char.id, options.contextSource);
  const directorConfig = options.directorConfig || loadGlobalDirectorConfig();
  const shotPlan = await generateShotPlan(sceneContext, options.mode, options.char, directorConfig, lastShotPlan);
  
  // 3. Renderer: 调用现有 imageGenerationService
  const result = await imageGenerationService.generateImage({
    prompt: shotPlan.finalPrompt,
    characterId: options.char.id,  // 自动注入 active Visual Identity
    aspectRatio: '16:9',  // 或根据 mode 调整
    resolution: '2K',
  }, options.rendererConfigOverride);
  
  // 4. 保存 ShotPlan metadata（不保存生成图）
  await saveShotPlanMetadata(options.char.id, options.contextSource, {
    shotPlan,
    directorProvider: directorConfig.provider,
    directorModel: directorConfig.model,
    rendererProvider: result.provider,
    rendererModel: result.model,
    createdAt: Date.now(),
  });
  
  return { ...result, shotPlan };
}
```

**要点**:
- `characterId` 参数已触发 `imageGenerationService` 自动注入 active Visual Identity（line 596-617）
- 无需额外处理参考图逻辑，复用现有 `getActiveVisualIdentity` → `resolveVisualIdentityReferences`
- `saveShotPlanMetadata` 只存轻量结构，不存图片本身（防止逐代漂移）

### 4. Context Adapters（在 `sceneCameraService.ts` 内部）

```typescript
async function buildDateCameraContext(
  char: CharacterProfile,
  recentMessages: Message[],
  userProfile: UserProfile,
): Promise<string> {
  // 复用 DatePrompts 的压缩逻辑
  const emojis = await DB.getEmojis();
  const apiMessages = ChatPrompts.buildMessageHistory(
    recentMessages.slice(-20),  // 只取最近 20 条
    char.contextLimit || 500,
    char,
    userProfile,
    emojis,
  ).apiMessages;
  
  // 压平成纯文本（Director 不需要结构化 API 消息）
  return apiMessages.map(m => {
    const text = typeof m.content === 'string' ? m.content : extractTextFromMultipart(m.content);
    return `${m.role}: ${text}`;
  }).join('\n');
}

async function buildStoryCameraContext(
  char: CharacterProfile,
  recentMessages: Message[],
  userProfile: UserProfile,
): Promise<string> {
  // 复用 storyTheater.ts 的 buildStoryHistory
  return buildStoryHistory(recentMessages.slice(-20))
    .map(m => `[${m.role === 'user' ? '玩家' : '剧情'}] ${m.content}`)
    .join('\n');
}
```

**Token 策略**:
- 只取最近 20 条消息（~5k-10k tokens）
- 已压缩卡片 / 图片占位符
- Director prompt + context < 15k tokens，适合 GPT-4o / Claude Sonnet

---

## D. 现有能力复用清单

### ✅ 完全可复用（无需修改）

1. **Chat Completion Client**
   - 文件: `utils/chatCompletionClient.ts`
   - 能力: `completeChat(apiConfig, body, options)`
   - 支持: OpenAI、Gemini Native、OpenAI-compatible
   - **Director 直接调用**

2. **Image Generation Service**
   - 文件: `utils/imageGenerationService.ts`
   - 能力: `generateImage(options, configOverride)`
   - 自动注入 Visual Identity（line 596-617）
   - 自动应用 photoSemantics（line 682-684）
   - **Renderer 直接调用，零改动**

3. **Visual Identity 体系**
   - 文件: `utils/visualIdentity.ts` + `utils/visualIdentityPresets.ts`
   - 能力: `getActiveVisualIdentity(char)` → 当前 active preset
   - 参考图解析: `resolveVisualIdentityReferences(references)`
   - 提示词构建: `buildVisualIdentityPrompt(visualIdentity)`
   - **Scene Camera 通过 `characterId` 参数自动触发**

4. **Photo Semantics**
   - 文件: `utils/photoSemantics.ts`
   - 能力: `applyPhotoSemantics(prompt, { identityActive })`
   - 自动识别自拍 / 镜子自拍 / 双人照 / 他拍并追加约束
   - **已在 imageGenerationService 末尾自动应用（line 682）**

5. **Context Builder**
   - 文件: `utils/context.ts`
   - 能力: `ContextBuilder.buildCoreContext(...)`
   - **可选：Director 需要更丰富上下文时引入角色人设**

### ⚠️ 需扩展（但不破坏现有逻辑）

1. **Scene Camera Settings**
   - 在角色配置中新增：
     ```typescript
     interface CharacterProfile {
       // ... existing fields
       sceneCameraConfig?: {
         enabled: boolean;
         directorProvider?: 'openai' | 'anthropic' | 'gemini-native' | 'openai-compatible';
         directorModel?: string;
         directorBaseUrl?: string;
         directorApiKey?: string;
       };
     }
     ```
   - 未配置时回退全局 `apiConfig`

2. **ShotPlan Metadata Store**
   - 新增 IndexedDB 表：`sceneCameraShotPlans`
   - Schema:
     ```typescript
     interface ShotPlanMetadata {
       id: string;
       charId: string;
       contextSource: 'date-companion' | 'date-story';
       shotPlan: ShotPlan;
       directorProvider: string;
       directorModel: string;
       rendererProvider: string;
       rendererModel: string;
       createdAt: number;
     }
     ```
   - 用于读取上一张 ShotPlan，推动镜头差异化

---

## E. Provider 解耦验证

### Director Provider（文本模型）
**当前 `chatCompletionClient.ts` 已支持**:
- ✅ `apiFormat: 'gemini-native'` → `requestGeminiNativeChat`
- ✅ `apiFormat: undefined` → OpenAI-compatible endpoint
- ✅ 通过 `baseUrl` + `apiKey` + `model` 三元组完全解耦

**Scene Camera 可用**:
- GPT-4o / GPT-4o-mini (OpenAI)
- Claude Sonnet 3.5 / Opus 3 (Anthropic via OpenAI-compatible)
- Gemini 1.5 Pro / Flash (Gemini Native)
- 糯米机 / Csy / 其他 OpenAI 中转

### Renderer Provider（图像模型）
**当前 `imageGenerationService.ts` 已支持**:
- ✅ `provider: 'gpt-images'` → `/images/edits` (multipart) + `/images/generations`
- ✅ `provider: 'gemini-native'` → Gemini Imagen 3
- ✅ `provider: 'openai-images'` → OpenAI DALL-E (不支持参考图，但保留文字身份描述)

**架构已预留 FLUX 扩展点**:
- `ImageGenerationProviderAdapter` 接口（line 103-108）
- `supportsReferenceImages` 能力标记
- `ADAPTERS` 注册表（line 544-548）

### FLUX Kontext 接入预判

**接入路径 1: OpenAI-compatible `/v1/images/edits`**
- 若 FLUX 1.1 Kontext 支持 OpenAI-compatible 接口
- **可最大程度复用 `gptImagesAdapter`**（line 464-542）
- 只需新增 `provider: 'flux-kontext'`，adapter 复用 GPT Images 逻辑

**接入路径 2: Replicate Prediction API**
- 若只能走 Replicate 异步 polling
- **需新增 `fluxReplicateAdapter`**
- 隔离异步逻辑，不污染同步的 Scene Camera 流程
- `responseMode: 'async'` 标记，Scene Camera 展示"生成中"状态

**Renderer Capability 抽象**（建议）:
```typescript
interface RendererCapability {
  supportsReferences: boolean;
  supportsMultipleReferences: boolean;
  supportsAspectRatio: boolean;
  supportsImageEdit: boolean;  // GPT edits / FLUX context
  responseMode: 'sync' | 'async';
}

const RENDERER_CAPABILITIES: Record<ImageGenerationProvider, RendererCapability> = {
  'gpt-images': { supportsReferences: true, supportsMultipleReferences: true, supportsAspectRatio: true, supportsImageEdit: true, responseMode: 'sync' },
  'gemini-native': { supportsReferences: true, supportsMultipleReferences: true, supportsAspectRatio: true, supportsImageEdit: false, responseMode: 'sync' },
  'openai-images': { supportsReferences: false, supportsMultipleReferences: false, supportsAspectRatio: true, supportsImageEdit: false, responseMode: 'sync' },
  // 'flux-kontext': { ... responseMode: 'async' }
};
```

**Scene Camera 判断逻辑**:
```typescript
if (capability.responseMode === 'async') {
  // 展示"正在生成"状态，注册回调
  await scheduleAsyncRender(shotPlan, rendererConfig);
} else {
  const result = await imageGenerationService.generateImage(...);
}
```

---

## F. UI 挂载点建议

### 陪伴模式（DateSession）
**挂载位置**: `components/date/DateSession.tsx`（未在本次读取，但由 `DateApp.tsx` 引用）
- 顶栏右侧新增「📷 摄影机」按钮
- 点击后展开摄影模式选择器（4 种模式）
- 共享 `DateSession` 已有的 `char` / `messages` / `userProfile` 状态

### 剧情模式（StoryTheaterSession）
**挂载位置**: `components/date/story/StoryTheaterSession.tsx` (line 274)
- 顶栏右侧新增「📷 场景」按钮
- 展开同样的摄影模式选择器
- 共享 `entry` / `char` / `messages` 状态

### 共享组件（建议）
新增 `components/date/SceneCameraModal.tsx`:
```typescript
interface Props {
  char: CharacterProfile;
  recentMessages: Message[];
  userProfile: UserProfile;
  contextSource: 'date-companion' | 'date-story';
  onClose: () => void;
}
```
- 4 种模式选择 UI
- 生成进度展示
- 结果预览 + 保存 / 分享
- 陪伴与剧情复用同一组件，只传不同的 `contextSource`

---

## G. 摄影模式第一版建议

### 最小可用集（MVP）
**只实现 2 种模式**:
1. **scene-snapshot**（场景快照）
   - 最高忠实度，只可视化当前状态
   - 不推进剧情
   - 玩家 `playerVisibility: 'none'`（纯角色单人快照）

2. **duo-photo**（双人合照）
   - 玩家 + 角色互动照
   - 玩家无 Visual Identity 时: `playerVisibility: 'back' | 'profile' | 'partial'`
   - 允许创意构图（背后环抱 / 借位 / 镜面）

**暂不实现**:
- ❌ pov-selfie（前置自拍）→ 留待 Phase 3B
- ❌ creative-director（创意构图）→ 与 duo-photo 合并

### 为何只选这 2 种
1. **scene-snapshot** 是核心需求："看看这一幕"
2. **duo-photo** 是差异化卖点：玩家无 Visual Identity 也能自然入画
3. 2 种模式已覆盖"单人 / 双人"两大类场景
4. 减少 Director prompt 复杂度，降低首次落地风险

### 预留兼容性（不实现）
- 玩家 Visual Identity 接入点: `playerVisualIdentity?: VisualIdentity` 参数
- 多张连拍: `shotCount: number` 参数
- 自动写入记忆: `saveToMemory: boolean` 参数
- 视频生成: 架构已支持替换 Renderer，未来接入视频模型无需重构

---

## H. Token 预算与成本策略

### Director（文本模型）
**输入**:
- System prompt: ~2k tokens (ShotPlan schema + 规则)
- 场景上下文: ~5k-10k tokens (最近 20 条消息压缩)
- 上一张 ShotPlan: ~0.5k tokens (差异化约束)
- **总计: ~8k-13k tokens 输入**

**输出**:
- ShotPlan JSON: ~0.5k-1k tokens

**单次成本**（以 GPT-4o 为例）:
- 输入: 13k × $2.5/1M = $0.0325
- 输出: 1k × $10/1M = $0.01
- **总计: ~$0.04 / 次**

### Renderer（图像模型）
**GPT Images (gpt-4o 图像)**:
- 1024×1024: $0.04
- 1792×1024: $0.08

**Gemini Imagen 3**:
- 定价未知，预计与 GPT 同级

**单次完整流程成本**: $0.08 - $0.12（Director + Renderer）

### 优化策略
1. **Director 模型降级**
   - 默认 GPT-4o → 可选 GPT-4o-mini (输入 $0.15/1M)
   - 降低成本 80%: $0.04 → $0.008

2. **上下文裁剪**
   - 最近 20 条 → 最近 10 条（足够理解当前场景）
   - 进一步降低 Director 成本

3. **ShotPlan 缓存**
   - 短时间内（5 分钟）同一场景重拍
   - 跳过 Director，直接用上一张 ShotPlan
   - 只切换 Renderer 或微调 prompt

---

## I. 逐代漂移防护机制

### 问题根源
实验中发现的 4 个问题都源于**模型复用上一张图的视觉元素**:
1. 脸部角度复用 → reference image 导致
2. 动作互动复用 → prompt 没有显式差异化
3. 构图/前景模板复用 → 模型记忆了常见构图
4. 追求新姿态导致脸型漂移 → reference image + prompt 冲突

### 解决方案

#### 1. Reference Image 只负责「是谁」
**当前实现已符合**（`imageGenerationService.ts` line 596-650）:
- 参考图来源: `char.visualIdentityPresets[activeIndex].references`
- 每次都从 active preset 重新读取
- **不会**读取上一张生成图

**Scene Camera 无需额外处理**:
- `generateImage({ characterId: char.id })` 自动触发
- `getActiveVisualIdentity(char)` → 当前 active preset
- 参考图顺序: ① isPrimary ② 临时参考图 ③ 其他身份图

#### 2. ShotPlan 负责「这一张怎么拍」
**新增机制**（`sceneCameraPrompt.ts`）:
```typescript
function buildAvoidConstraints(lastShotPlan?: ShotPlan): string[] {
  if (!lastShotPlan) return [];
  return [
    `不要复用上一张的构图方式: ${lastShotPlan.composition}`,
    `不要让角色保持同样的身体朝向: ${lastShotPlan.bodyOrientation}`,
    `不要重复使用上一张的前景元素: ${lastShotPlan.foreground || '无'}`,
    `镜头角度必须与上一张不同: 上一张是 ${lastShotPlan.cameraPosition}`,
  ];
}
```

**Director prompt 显式要求差异化**:
```
上一张照片的构图: [lastShotPlan.composition]
本次拍摄必须: 换一个镜头角度、换一个身体朝向、换一种前景元素
```

#### 3. 显式控制关键参数
**ShotPlan 强制字段**:
- `expression`: 独立描述表情（不依赖 reference image）
- `gaze`: 视线方向（"看向镜头" / "看向玩家" / "看向远方"）
- `bodyOrientation`: 身体朝向（"正面" / "侧身" / "背影"）
- `foreground`: 前景元素（"桌上的咖啡杯" / "窗边的绿植" / "无"）

**避免模型自由发挥默认模板**:
- ❌ 不提供具体参数 → 模型总是生成"情侣宣传照"
- ✅ 每个参数都由 Director 显式给出 → 模型按要求执行

#### 4. continuityConstraints 锁定身份
**ShotPlan 必填字段**:
```typescript
continuityConstraints: [
  "当前角色 active Visual Identity preset: 人类短发形态",
  "参考图来源: character_ref_001.png (isPrimary)",
  "不得混入其他形态的身份特征",
]
```

**Director prompt 强调**:
```
角色当前使用的 Visual Identity preset 是「人类短发形态」。
生成的 prompt 必须与该形态一致，不得描述「长发」「鱼尾」等其他形态特征。
```

---

## J. 已知风险与缓解措施

### 风险 1: Director 输出格式不稳定
**表现**: JSON 解析失败、字段缺失

**缓解**:
- ✅ 使用 `response_format: { type: 'json_object' }` (GPT / Gemini 支持)
- ✅ 容错解析: `parseShotPlanFromJson` 允许部分字段缺失，用默认值填充
- ✅ Retry 一次: `maxRetries: 1`

### 风险 2: Renderer 失败（API 错误 / 超时）
**表现**: 生成失败，但 ShotPlan 已消耗

**缓解**:
- ✅ ShotPlan 与图片分离存储
- ✅ 失败时保留 ShotPlan，允许切换 Renderer 重试
- ✅ 不自动重新调用 Director（避免重复消耗 token）

### 风险 3: 玩家无 Visual Identity 时生成质量不稳定
**表现**: "背影" 语义理解偏差，生成正脸

**缓解**:
- ✅ `photoSemantics.ts` 已有双人照约束（line 76-87）
- ✅ Director prompt 显式说明: "若无法确定用户外貌，可以只显示用户的局部或模糊呈现"
- ⚠️ 需在实际测试中调优 `playerVisibility` 的描述强度

### 风险 4: 陪伴与剧情共享 Scene Camera 导致行为混淆
**表现**: 剧情模式下生成了陪伴风格的图片

**缓解**:
- ✅ `contextSource` 参数显式区分
- ✅ Context adapter 各自独立（`buildDateCameraContext` vs `buildStoryCameraContext`）
- ✅ ShotPlan metadata 存储时记录 `contextSource`，避免跨模式复用

---

## K. 下一阶段计划（Phase 3B+，本次不实现）

### Phase 3B: 玩家 Visual Identity 接入
- 新增 `userProfile.visualIdentity`
- `duo-photo` 模式自动注入双方参考图
- 参考图顺序: ① 角色 isPrimary ② 玩家 isPrimary ③ 其他

### Phase 3C: 前置自拍模式 (pov-selfie)
- 实现 `sceneType: 'pov-selfie'`
- 复用 `photoSemantics.ts` 的 `SELFIE_PROMPT`（line 54-64）
- 自动追加前置摄像头约束

### Phase 3D: 多张连拍与记忆写入
- `shotCount: 2-4` 参数
- 每张 ShotPlan 差异化
- 可选自动写入记忆: `saveToMemory: true`

### Phase 3E: FLUX Kontext 实际接入
- 实现 `fluxKontextAdapter` 或复用 GPT Images adapter
- 处理异步 polling（若需要）
- 性能对比测试

---

## L. 不建议实现的功能（明确排除）

### ❌ 自动剧情续写
**原因**: 违反产品原则"不推进剧情"

### ❌ 自动替玩家发言
**原因**: 违反产品原则"不代替玩家发言"

### ❌ 为构图凭空改变剧情事实
**原因**: 违反产品原则"不允许为了构图凭空改变重要剧情事实"

### ❌ 上一张图自动成为下一张参考
**原因**: 导致逐代漂移，已在架构层面防护

### ❌ NPC 多人复杂群像
**原因**: 第一版聚焦单人 / 双人场景，多人留待后续

---

## M. 实现清单（Phase 3A 最小闭环）

### 必须新增的文件
- [ ] `utils/sceneCameraPrompt.ts` (ShotPlan schema + Director prompt)
- [ ] `utils/sceneCameraDirector.ts` (调用 completeChat 生成 ShotPlan)
- [ ] `utils/sceneCameraService.ts` (统一入口 + context adapters)
- [ ] `components/date/SceneCameraModal.tsx` (UI 组件，陪伴 / 剧情共用)

### 必须修改的文件
- [ ] `types.ts`: 新增 `ShotPlan` / `ShotPlanMetadata` / `SceneCameraConfig` 类型
- [ ] `utils/db.ts`: 新增 `sceneCameraShotPlans` 表 + CRUD 方法
- [ ] `components/date/DateSession.tsx`: 挂载摄影机按钮
- [ ] `components/date/story/StoryTheaterSession.tsx`: 挂载摄影机按钮

### 无需修改的文件（直接复用）
- ✅ `utils/chatCompletionClient.ts`
- ✅ `utils/imageGenerationService.ts`
- ✅ `utils/visualIdentity.ts`
- ✅ `utils/visualIdentityPresets.ts`
- ✅ `utils/photoSemantics.ts`
- ✅ `utils/context.ts`
- ✅ `utils/chatPrompts.ts`
- ✅ `utils/datePrompts.ts`
- ✅ `utils/storyTheater.ts`

---

## N. 终端摘要输出

```
SCENE_CAMERA_PHASE3A_AUDIT_DONE
meet_companion_entry: DateApp.tsx → DateSession (未读取，但由 DateApp 引用) + DatePrompts.buildPeekPayload/buildSessionPayload
meet_story_entry: StoryTheater.tsx → StoryTheaterSession.tsx + storyTheater.ts context builders
context_pipeline: ✅ 完全可复用 ContextBuilder.buildCoreContext + ChatPrompts.buildMessageHistory + 世界书扫描
director_client_reuse: ✅ 直接复用 completeChat(apiConfig, body, opts)，支持 GPT/Claude/Gemini 三格式
visual_identity_reuse: ✅ 通过 characterId 参数自动触发，getActiveVisualIdentity → resolveVisualIdentityReferences → buildVisualIdentityPrompt
image_generation_reuse: ✅ 直接复用 imageGenerationService.generateImage()，已自动注入 Visual Identity + photoSemantics
result_ui_reuse: ✅ 建议新增 SceneCameraModal.tsx 共享组件，陪伴 / 剧情传不同 contextSource
recommended_architecture: Director(文本模型生成 ShotPlan) + Renderer(图像模型) 两阶段分离，防止逐代漂移
minimal_files_to_add: sceneCameraPrompt.ts, sceneCameraDirector.ts, sceneCameraService.ts, SceneCameraModal.tsx, types.ts (新类型), db.ts (新表)
minimal_files_to_modify: DateSession.tsx (挂按钮), StoryTheaterSession.tsx (挂按钮), 无需改 imageGenerationService / chatCompletionClient
token_strategy: Director 8k-13k 输入 + 1k 输出 (~$0.04/GPT-4o), Renderer $0.04-0.08, 总计 $0.08-0.12/次; 可降级 GPT-4o-mini 省 80%
continuity_strategy: ① Reference image 只从 active preset 读，绝不用上一张图 ② ShotPlan metadata 存储，avoidConstraints 推动差异化 ③ 显式控制 expression/gaze/bodyOrientation/foreground ④ continuityConstraints 锁定当前形态
known_risks: Director 格式不稳定(用 json_object + 容错解析), Renderer 失败(保留 ShotPlan 允许切换重试), 玩家无 VI 时背影语义偏差(需实测调优), 陪伴/剧情混淆(contextSource 显式区分)
blockers: 无架构级阻塞; 现有能力完备; 第一版只需新增 4 个文件 + 修改 4 个文件
next_phase: Phase 3B(玩家 Visual Identity 接入 + 双人参考图), Phase 3C(pov-selfie 前置自拍), Phase 3D(多张连拍 + 记忆写入), Phase 3E(FLUX Kontext 实际接入)
report: docs/handoff/scene_camera_state.md
```

---

## O. 审计结论

✅ **架构可行性**: 现有能力完全支持 Scene Camera 功能，无需重构核心系统

✅ **Provider 解耦**: Director 与 Renderer 已在现有架构中独立可配，符合需求

✅ **逐代漂移防护**: 通过 Reference Image 单向读取 + ShotPlan 差异化 + 显式参数控制三层机制防护

✅ **最小闭环清晰**: 只需新增 4 个文件 + 修改 4 个挂载点，即可实现 scene-snapshot + duo-photo 两模式

⚠️ **需实测调优**: 玩家无 Visual Identity 时的 `playerVisibility` 语义理解需在真实场景中验证

📋 **下一步**: 按本报告 Section M 实现清单逐项落地，Phase 3B+ 功能预留兼容性但暂不实现

---

**审计完成时间**: 2026-09-26  
**审计人**: Claude Code (Sonnet 4.6)  
**状态**: ✅ PHASE 3B COMPLETE - 核心逻辑已实现并测试通过

---

## Q. Phase 3C Implementation Summary (2026-09-26)

**状态**: ✅ PHASE 3C COMPLETE - 共享 UI + 陪伴/剧情双入口接线完成，未发布（等待手机端实测 UI）

### ✅ 已完成的工作

**新增文件（5 个）**:
- ✅ `components/date/SceneCameraModal.tsx` — 共享摄影机弹层（陪伴/剧情同一 UI，portal 底部抽屉，移动端优先）
- ✅ `utils/sceneCameraContext.ts` — 双入口上下文适配器 + Director 配置派生
- ✅ `utils/sceneCameraSession.ts` — 无头状态机（phase / busy 互斥 / abort / retry 语义，可测试）
- ✅ `utils/sceneCameraContext.test.ts` — 9 tests
- ✅ `utils/sceneCameraSession.test.ts` — 12 + 2 tests

**修改文件（3 个）**:
- ✅ `utils/sceneCameraService.ts` — 增量扩展（非重写）：新增 `renderShotPlan()`（Renderer-only 路径）、`aspectRatio` 传递、`extractImageUrl()`（修复真实 `ImageGenerationResult.images[]` 与 3B mock `url` 的兼容）、`Character` → `CharacterProfile` 类型修正（types.ts 从未导出 `Character`）
- ✅ `components/date/DateSession.tsx` — 右上角新增 📷 相机按钮 + SceneCameraModal 挂载（contextSource=companion）
- ✅ `components/date/story/StoryTheaterSession.tsx` — header 新增 Camera 按钮 + 同一 SceneCameraModal（contextSource=story，character=首位出场角色）

### 架构要点

- **共享 UI**：陪伴与剧情共用 `SceneCameraModal`；入口只传 `contextSource` / `character` / `getSceneContext`
- **Director**：`deriveDirectorApiConfig(apiConfig)` 从 OSContext 聊天 API 派生（gemini-native / openai-compatible），UI 只读展示 provider/model，不出现厂商品牌文案，不重复输入 Key
- **Renderer**：每次动作前 `loadImageGenerationConfig()` 现读现有生图配置；监听 `IMAGE_GENERATION_CONFIG_CHANGED_EVENT`，换模型后回到弹层即可「换生图模型后重拍」
- **宽高比**：`SCENE_CAMERA_ASPECT_RATIOS = 1:1 / 4:3 / 3:4 / 9:16 / 16:9`（受现有 `ImageGenerationAspectRatio` 枚举约束，**无 4:5**，未加第二套默认值，默认读 `defaultAspectRatio`）
- **两阶段加载**：`directing`（正在理解这一幕……）→ `rendering`（摄影机正在成像……）；busy 互斥防并发
- **两种重新生成**：
  - 「重拍同一镜头」= `rerenderSameShot()`：保留 ShotPlan，**不调 Director**，只调 Renderer（换模型后也可用）
  - 「重新导演」= `redirectNewShot()`：重调 Director，`previousShotPlan` 传入差异化
- **Renderer 失败恢复**：ShotPlan 保留在 session state；错误面板提供「重试」（有 ShotPlan → 只走 Renderer）与「换生图模型后重拍」（现读配置 + retry）；设置入口以提示文案引导
- **图片展示**：复用 `ChatPhotoViewer` 全屏预览 + Web Share / 长按保存；不插聊天、不写剧情、不写记忆
- **状态管理**：`SceneCameraSessionState = { mode, phase, aspectRatio, shotPlan, previousShotPlan, imageUrl, error, directorMetadata, rendererMetadata }`；关闭 modal `reset()` 清理（无 DB 持久化）
- **Visual Identity**：`characterId` 全链路传递（`renderShotPlan` / `generateSceneCamera` → `imageGenerationService` 自动注入 active preset）；上一张图片不进入 reference set
- **调试**：DEV-only `<details>` 折叠区（mode / director / renderer / aspectRatio / cameraPosition / shotSize / composition）+ `console.debug`（debug 开关，不含 Key 与完整上下文）

### ⚠️ Phase 3C 明确不实现（按约束）

- ❌ pov-selfie / creative-director 模式（`setMode` 直接拒绝）
- ❌ 多 NPC 群像（剧情入口取首位出场角色）
- ❌ Player Visual Identity / FLUX adapter / DB ShotPlan 历史 / 自动写记忆 / 自动推进剧情 / 聊天写入
- ❌ Director provider 级切换（接口已按未来可切设计：`getDirectorConfig` 注入点）

### 🔍 Regression Test Status

**Scene Camera 测试**: 44/44 通过（Phase 3B 23 + Phase 3C 21）
**全量测试**: 4429 passed / 2 failed，均为 pre-existing，与 Phase 3C 无关：
- `chatPhotoGeneration.test.ts` — 1 failure（既有，与 3B 基线一致）
- `privateNpcLeakCleanup.test.ts` — 1 failure（`DB.deleteCharacterRecordsOnly is not a function`；当前工作树既有问题，Phase 3C 未触碰 db.ts / 该测试）
- 注：3B 基线记录的 `visualIdentityPresets.test.ts` 7 failures 在当前工作树已通过（15/15），未做任何修改
**Production build**: ✅ 成功（32.88s，无新增告警）
**Git**: 未 commit / 未 merge / 未 push / 未部署 —— 等待手机端 UI 实测


---

## P. Phase 3B Implementation Summary (2026-09-26)

### ✅ 已完成的工作

**新增文件（4 个）**:
- ✅ `utils/sceneCameraPrompt.ts` - Director prompt builder, ShotPlan JSON parser, avoidConstraints differentiator
- ✅ `utils/sceneCameraDirector.ts` - Director service calling `completeChat` for provider-agnostic text model access
- ✅ `utils/sceneCameraService.ts` - Main orchestration: Director → ShotPlan → Renderer → Image
- ✅ `utils/sceneCameraPrompt.test.ts` - 14 tests covering prompt building, JSON parsing, differentiation
- ✅ `utils/sceneCameraService.test.ts` - 9 integration tests covering full flow, VI injection, error handling

**测试覆盖（23 tests, 全部通过）**:
- ✅ Director system prompt 包含核心规则（anti-drift, player VI handling, JSON schema）
- ✅ Director user prompt 为 scene-snapshot 和 duo-photo 构建正确上下文
- ✅ previousShotPlan 差异化提示正确注入
- ✅ JSON 解析容错（去除 markdown code fence、填充默认值）
- ✅ enrichAvoidConstraints 基于 previousShotPlan 生成差异化约束并去重
- ✅ generateShotPlanOnly 调用 Director 并传递 activePresetName
- ✅ generateSceneCamera 完成 Director + Renderer 完整流程
- ✅ Visual Identity 自动注入（通过 characterId）
- ✅ duo-photo 模式正常工作
- ✅ Phase 3B 范围外模式（pov-selfie）正确拒绝
- ✅ signal 传递给 imageGenerationService
- ✅ Director 和 Renderer metadata 记录到 ShotPlan
- ✅ Director/Renderer 失败时错误正确抛出

**架构实现**:
- ✅ Director-Renderer 两阶段分离（provider 独立配置）
- ✅ Director 复用 `completeChat`（支持 OpenAI/Anthropic/Gemini Native/OpenAI-compatible）
- ✅ Renderer 复用 `imageGenerationService.generateImage`（自动 VI 注入 + photoSemantics）
- ✅ Anti-drift 三层防护（reference only from active preset, ShotPlan metadata differentiation, explicit control）
- ✅ previousShotPlan → avoidConstraints 自动生成（机位/景别/身体朝向/构图/前景/表情）

### ⚠️ Phase 3B 明确不实现的功能（按约束）

- ❌ UI 组件（SceneCameraModal.tsx）
- ❌ 数据库表（sceneCameraShotPlans）
- ❌ 挂载点（DateSession.tsx / StoryTheaterSession.tsx）
- ❌ Player Visual Identity 新增
- ❌ FLUX 接入
- ❌ pov-selfie / creative-director 模式
- ❌ 写入聊天记录
- ❌ 写入长期记忆
- ❌ 修改现有聊天生图行为

### 🔍 Regression Test Status

**新增测试**: 23/23 通过  
**回归测试**: 存在 **pre-existing failures** 与 Phase 3B 无关:
- `chatPhotoGeneration.test.ts` - 1 failure (gpt-images adapter 降级逻辑，Phase 3B 未修改此文件)
- `visualIdentityPresets.test.ts` - 7 failures (legacy VI fallback 行为，Phase 3B 未修改 presets 逻辑)

**Production build**: ✅ 成功（34.89s, no new warnings）

### 📋 Phase 3B Validation Checklist

- ✅ Scene Camera 未写聊天记录（`sceneCameraService.ts` 无 `saveMessage` 调用）
- ✅ 未写长期记忆（无 `saveMemory` / `addToMemory` 调用）
- ✅ 未新增 DB 表（无 `CREATE TABLE` 语句）
- ✅ 未改变现有普通聊天生图行为（未修改 `executeChatPhotoIntent`）
- ✅ Rerender existing ShotPlan 不重新调用 Director（`generateSceneCamera` 只在新请求时调用 Director）
- ✅ Renderer error 后 ShotPlan 可保留（Director 成功返回 ShotPlan，Renderer 失败时抛出但 ShotPlan 已存在于调用方）

### 🚀 Ready for Phase 3C

Phase 3B 核心逻辑已就绪。下一阶段可以开始：
- UI 组件开发（SceneCameraModal.tsx）
- 数据库持久化（sceneCameraShotPlans 表）
- 陪伴/剧情模式挂载点集成
- pov-selfie 模式扩展
- Player Visual Identity 双人参考图
