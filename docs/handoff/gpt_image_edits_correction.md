# GPT Image Edits Endpoint Correction

**完成时间**: 2026-09-26  
**状态**: ✅ 代码已修正，测试通过，构建成功；⚠️ RelayRouter 端点能力需人工验证

---

## GPT_IMAGE_EDITS_VALIDATION_DONE

### Endpoint Probe

**Target**: `https://api.relayrouter.ai/v1/images/edits`  
**Status**: SKIPPED (no API key in RELAYROUTER_API_KEY env var)  
**Probe Script**: `scripts/probe-gpt-edits.mjs`

**使用方法**（人工验证时）：
```bash
export RELAYROUTER_API_KEY=your-key
node scripts/probe-gpt-edits.mjs
```

**Probe 会检查**：
- HTTP status (200/404/405/etc)
- 是否接受 multipart/form-data
- image[] 字段是否支持
- 返回结构 (data[].b64_json / data[].url)
- 明确报告 endpoint 是否存在

---

### Request Format

**无参考图**（保持不变）：
```
POST /v1/images/generations
Content-Type: application/json
Authorization: Bearer {apiKey}

{
  "model": "dall-e-3",
  "prompt": "...",
  "n": 1,
  "size": "1024x1024",
  "response_format": "b64_json"
}
```

**有参考图**（已修正）：
```
POST /v1/images/edits
Content-Type: multipart/form-data; boundary=auto-generated
Authorization: Bearer {apiKey}

--boundary
Content-Disposition: form-data; name="model"

dall-e-3
--boundary
Content-Disposition: form-data; name="prompt"

enhance this
--boundary
Content-Disposition: form-data; name="image"; filename="reference_0.png"
Content-Type: image/png

[binary image data]
--boundary
Content-Disposition: form-data; name="image"; filename="reference_1.png"
Content-Type: image/jpeg

[binary image data]
--boundary--
```

**关键改动**：
- ❌ 不再使用 `/chat/completions` + vision
- ❌ 不再用 JSON body 传 base64 image_url
- ✅ 改用 `/images/edits` 标准端点
- ✅ 使用 multipart/form-data
- ✅ 参考图作为 Blob 上传（多张图用多个 `image` 字段）
- ✅ FormData 自动设置 boundary，不手动指定 Content-Type

---

### Response Format

**期望返回**（与 /images/generations 一致）：
```json
{
  "data": [
    {
      "b64_json": "iVBORw0KGgoAAAANSUhEUgAA...",
      // 或
      "url": "https://cdn.example/generated.png"
    }
  ]
}
```

**规范化逻辑**：
- 复用现有 `normalizeImageGenerationResponse`
- 支持 `data[].b64_json` → data-uri
- 支持 `data[].url` → url source
- 兼容 Gemini / OpenAI / RelayRouter 多种返回格式

---

### Changed Files

```
M  utils/imageGenerationService.ts      (gptImagesAdapter: /images/edits + FormData)
M  utils/imageGenerationConfig.ts       (PROVIDERS: add gpt-images)
+  utils/imageGenerationService.test.ts (4 new GPT tests)
+  scripts/probe-gpt-edits.mjs          (endpoint probe script)
M  utils/photoSemantics.ts              (syntax fix: people's → people)
```

**核心修改**：
- `gptImagesAdapter.generate()`: 有参考图时切换到 `/images/edits` + multipart
- 参考图从 base64 转换为 Blob，append 到 FormData
- 多张参考图：多次 `formData.append('image', blob)`
- 验证逻辑：openai-images 只在用户直接提供参考图时拒绝，视觉身份参考图跳过

---

### Tests

**Test Suites**: 2 passed (photoSemantics + imageGenerationService)  
**Total Tests**: 32 passed  

**新增 GPT Images 测试**：
1. ✅ 无参考图 → `/images/generations` (JSON body)
2. ✅ 有参考图 → `/images/edits` (FormData body)
3. ✅ 多张参考图 → 多个 `image` 字段
4. ✅ FormData 自动设置 Content-Type boundary

**回归测试**：
- ✅ Gemini Native 无回归
- ✅ OpenAI Images 拒绝用户参考图
- ✅ OpenAI Images 跳过视觉身份参考图（保留文字描述）
- ✅ photoSemantics 16 tests 全部通过

---

### Build

**Status**: ✅ SUCCESS  
**Duration**: 33.53s  
**Modules**: 6168 transformed  
**Output**: dist/ (all chunks generated)

无 TypeScript 错误，无构建警告（除 circular chunks 已知问题）。

---

### Blockers

**⚠️ BLOCKER: RelayRouter /images/edits 端点能力未验证**

**风险分析**：

1. **端点可能不存在**
   - `/images/edits` 是 OpenAI 官方端点
   - RelayRouter 可能未实现此端点（返回 404/405）
   - 若不支持：**无法使用 GPT Images + 参考图功能**

2. **multipart/form-data 支持未知**
   - 某些中转站只支持 JSON body
   - 若 RelayRouter 不接受 multipart：**请求会失败**

3. **image[] 字段规范未确认**
   - OpenAI 官方使用 `image` 字段（单数）+ 多次 append
   - 某些实现可能要求 `images[]`（复数）或其他命名

**验证方法**（需人工执行）：

```bash
# 1. 设置 RelayRouter API Key
export RELAYROUTER_API_KEY=your-key

# 2. 运行探测脚本
node scripts/probe-gpt-edits.mjs

# 3. 查看输出
# - ✅ HTTP 200 = endpoint 支持
# - ❌ HTTP 404/405 = endpoint 不支持 → BLOCKER
# - ❌ HTTP 400 + "unsupported" = 不支持 multipart → BLOCKER
```

**若 BLOCKER 确认**：
- 代码保持当前状态（不发布）
- 更新文档：GPT Images + 参考图仅支持 OpenAI 官方端点
- RelayRouter 用户只能使用 GPT Images 无参考图模式
- 或改用 Gemini Native（支持参考图）

---

### Ready to Publish

**❌ NO - BLOCKED**

**阻塞原因**：
1. RelayRouter `/images/edits` 端点能力未验证
2. 若端点不存在，功能无法使用
3. 需真实 API 测试确认后才能发布

**发布前必须完成**：
1. ✅ 配置 RelayRouter API Key
2. ✅ 运行 `node scripts/probe-gpt-edits.mjs`
3. ✅ 确认 HTTP 200 + 正确返回格式
4. ✅ 若 404/405：更新文档说明限制，或实现降级方案

**若端点不支持**（404/405）：
- 选项 A：不发布 GPT Images + 参考图功能（代码保留但文档说明不可用）
- 选项 B：实现降级：GPT Images 只支持无参考图模式
- 选项 C：引导用户使用 Gemini Native（已验证支持参考图）

**预计耗时**：5-10 分钟端点验证 + 0-30 分钟文档更新（若需要）

---

## 技术细节

### FormData 构造逻辑

```typescript
const formData = new FormData();
formData.append('model', config.model);
formData.append('prompt', finalPrompt);
formData.append('n', '1');
formData.append('size', '2048x2048');
formData.append('response_format', 'b64_json');

// 参考图：base64 → Blob → FormData
for (let i = 0; i < references.length; i++) {
    const reference = references[i];
    const blob = new Blob(
        [Uint8Array.from(atob(reference.base64), c => c.charCodeAt(0))],
        { type: reference.mimeType }
    );
    formData.append('image', blob, `reference_${i}.png`);
}

// Fetch 自动设置 Content-Type: multipart/form-data; boundary=...
fetch(editsEndpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData
});
```

### 参考图验证逻辑

**场景 1**：用户直接提供参考图 + openai-images provider
```typescript
// options.referenceImages = [...]
// config.provider = 'openai-images'
// → throw REFERENCE_NOT_SUPPORTED
```

**场景 2**：视觉身份参考图 + openai-images provider
```typescript
// characterId 提供，有 visual identity references
// options.referenceImages = undefined
// config.provider = 'openai-images'
// → skipReferencesForProvider = true
// → 跳过图片，保留文字身份描述
```

**场景 3**：任何参考图 + gpt-images provider
```typescript
// config.provider = 'gpt-images'
// adapter.supportsReferenceImages = true
// → 正常发送到 /images/edits
```

---

## 下一步

### 立即执行（人工）
1. 配置 `RELAYROUTER_API_KEY` 环境变量
2. 运行 `node scripts/probe-gpt-edits.mjs`
3. 记录结果（HTTP status + response structure）

### 根据探测结果

**若 HTTP 200 + 正确返回**：
- ✅ 更新文档：GPT Images 支持参考图
- ✅ 可以发布 Phase 2H + 2G
- ✅ 在设置页添加说明：GPT Images 需要支持 /images/edits 的端点

**若 HTTP 404/405**：
- ❌ 不发布 GPT Images + 参考图功能
- 📝 更新文档：
  - GPT Images 仅支持无参考图模式
  - 需要参考图请使用 Gemini Native
  - RelayRouter 当前不支持 /images/edits 端点
- 🔧 代码保持不变（已实现，只是端点不可用）

**若 HTTP 400 + multipart 不支持**：
- 📝 更新文档：同 404 情况
- 💡 考虑：是否可以转换为其他格式（可能性低）

---

## 总结

**实现完整度**: ✅ 100% (代码逻辑完整)  
**测试覆盖**: ✅ 32/32 passed  
**构建状态**: ✅ SUCCESS  
**端点验证**: ⚠️ SKIPPED (need API key)  
**可发布性**: ❌ BLOCKED on endpoint probe

代码已按 OpenAI 官方 `/images/edits` 标准实现，multipart/form-data 格式正确，测试完整。唯一阻塞项是 RelayRouter 端点能力未验证，需人工测试后决定发布策略。
