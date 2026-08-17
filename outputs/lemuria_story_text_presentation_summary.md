# Lemuria 剧情文字呈现改造摘要

1. 修改文件
   - `components/date/story/StoryTheaterSession.tsx`
   - `components/date/story/StoryTheaterTheme.tsx`
   - `components/date/story/ImmersiveStoryText.tsx`
   - `utils/storyTextPresentation.ts`
   - `utils/storyTextPresentation.test.ts`

2. 开关位置
   - 「见面 → 剧情剧场」右上角「剧情外观」面板内新增「文字呈现」分段开关：`原文 / 沉浸分层`。
   - 新环境默认选择「沉浸分层」；「原文」保留原有 `<p>` 正文渲染。

3. localStorage key
   - `lemuria_story_text_presentation_v1`
   - 仅保存全局显示偏好，不写入 StoryTheaterEntry 或 IndexedDB。

4. 实际解析方式
   - `~~...~~` → thought：隐藏标记，灰紫/弱化、轻微斜体、删除线。
   - `**...**` → strong：隐藏标记，正文半粗体。
   - `*...*` → atmosphere：隐藏标记，muted 色、斜体；解析顺序保证不拆分 strong。
   - `「...」` → dialogue：保留中文引号，主题 accent 色、半粗体。
   - 同段混合标记、多个 segment、中文标点、原始换行和空段按原顺序保留；未闭合标记原样显示。

5. 删除线
   - 完整保留。thought 使用真正的 CSS `line-through`，只隐藏 `~~` 标记字符，不修改原始正文。

6. typecheck
   - 成功：`pnpm exec tsc --noEmit`，退出码 0。

7. build
   - 成功：`pnpm run build`，6099 个模块完成构建，退出码 0。
   - 已有警告：chunk 循环依赖提示、`pdfjs-dist` 的 eval 提示；与本次改动无关。
   - 测试：新增 tokenizer 4/4 通过；现有 Story Theater 43/43 通过。

8. 已知问题
   - 未发现代码、类型或构建问题。
   - 真实 iPhone Safari 的触控与多主题视觉仍需设备手工验收。

9. 推荐 iPhone 检查点
   - 长篇旧剧情打开、翻页和滚动是否流畅，无横向滚动。
   - 混合段落中的台词、内心删除线、强调、氛围和旁白是否只作用于各自片段。
   - 浅色、深色、素雅、花里胡哨四种组合下文字对比度是否舒适。
   - 长按编辑/删除、换一种写法和 choices 点击是否仍正常。
   - 切换「原文 / 沉浸分层」后刷新页面，偏好是否保持且正文原始数据不变。
