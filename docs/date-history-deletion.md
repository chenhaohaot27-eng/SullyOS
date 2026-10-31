# 见面记录管理与关联记忆删除

基于 main `0de1d92fc9472fff42c8d5c9c280ccc524ce6296` 开发。仅处理目标角色、非群聊、`metadata.source=date` 的消息；正式发布不运行任何用户数据删除。

## 使用

见面 → 陪伴 → 见面记录：按次/按日期下可删除单组；「多选管理」会先读取完整历史，再选择多组删除。单条消息菜单与会话内删除调用同一服务。原有导出、排序、命名、编辑、收藏保留，收藏是独立快照，不随消息删除。

确认框列出完整消息数、节点删除/重建数、来源不明项。删除后结果留在页面并写入删除日志；「重试删除同步」处理远程失败，不重复删除本地消息。

## 覆盖与边界

- 新提取节点记录 `sourceMessageIds`：模型逐条引用必须属于真实输入；缺失/非法引用标为 `sourceScope=batch`，不得伪装精确溯源。
- 单来源/全部来源删除：删除节点、本地向量、关联链接；BM25 重置。远程只按已确认节点 ID 且带角色过滤删除。
- 多来源节点：从仍存在的文本/语音原始消息机械重建（保留原话，不调用模型猜测）。材料缺失/不适合文本重建时保留原记忆并报告失败。
- EventBox：依全部 live + archived 成员重建总结，保留未删除节点。成员缺失时整个本地删除事务中止。事件盒标题/标签重置，避免旧摘要残留。空盒不再指向旧总结。
- 神经链接：新自动归档带逐节点条目，可以删除/重建对应 bullet。与旧归档混合时单独保留 `legacySummary`。
- 衍生认知节点：可靠的 `sourceId` 链可删除/重建；新衍生节点继承消息来源。
- 旧版无来源节点、旧神经归档、认知门牌、消化日志：保留并列出核查提示。不按日期或文本相似度推断。第三方遗留 `legacyCsy.sourceMessageIds` 未证实与当前数据库 ID 对齐，不能作为自动删除证据。
- 远程独有且本地没有来源映射的向量无法自动确认；不会声称已清除。远程 HTTP 失败留待重试，检索端过滤已删除 ID 与旧总结内容。
- 重建节点的旧向量撤销、`embedded=false`；BM25 可立即使用安全重建文本，向量由后续记忆向量化流程补齐。
- 主动消息：从数据库最新记忆/历史生成快照；明确检查拒绝/跳过响应。离线、拒绝、失败均不报告全部成功。已发送到供应商或已在云端执行的请求无法撤回；未确认同步时旧云端快照仍可能存在。

## 数据一致性

本地消息、节点、向量、链接、事件盒、归档与删除日志在一个 IndexedDB 事务内提交。确认后消息集合变化则要求重新确认。删除开场后，仅对已有开场锚点的场次迁移边界，保留跨午夜场次和旧版自然日期分组。

提取、消化、压缩、向量写入、归档、恢复及云端门牌结果采用共享任务锁；删除采用排他锁，忙时显式拒绝。支持 Web Locks 的浏览器可跨标签页隔离；不支持时退化为当前页面锁，数据库来源/删除日志仍阻止已知已删来源回写。异步远程写入也持锁。跨标签页通知刷新内存记忆、BM25 与召回回执。

数据库升级至 v80，新增 `date_deletion_ledger`。普通存储写入会核对持久删除日志，旧副本不能恢复已删除节点/归档；见面进度有来源消息 ID，旧快照仅在可确认关联时清理，其余提示人工核查。

完整/纯文字备份携带删除日志。恢复前合并删除标记并检查冲突，旧备份若会恢复已删内容则在任何业务数据写入前停止，保持现有数据。日志不随普通备份清库而丢失。全新设备仅有删除前旧备份时无法获知后续删除；应迁移删除后备份。向量二进制备份保留删除修订号。

## 验证（2026-10-31）

- 27 个相关测试文件、240 项测试通过。包含删除范围、跨日期场次、旧数据、逐条来源、事件盒重建、节点/角色隔离、晚到写入、锁、确认后变更、远程失败/重试、备份恢复、4500×1024 向量完整往返。
- 实际外连已被测试运输层阻断（fetch + Node socket），API 请求由测试模拟；未调用用户的真实记忆服务。
- `tsc --noEmit`：原 main 有 78 条错误诊断；对比本次无新增。全库类型检查不能标为完全通过。
- `GITHUB_PAGES=true pnpm run build` 和私有 NPC 泄漏检查通过。
- 完整联网测试尝试被自动审批拦截：既有测试会访问未核实外部 Worker。已停止，改用隔离外连的相关回归。另发现的 5 个既有测试失败均在原 main 复现（lifeRecords、chatPhotoGeneration、amsgStateSync.gaps、foodBackup、playerWallet），未修改无关逻辑。
- 无用户 iPhone 实机验证；远程服务真实网络故障仍应以应用内同步报告为准。

## 修改文件
- `apps/DateApp.tsx`
- `components/date/DateSession.tsx`
- `context/OSContext.tsx`
- `docs/date-history-deletion.md`
- `types.ts`
- `utils/activeMsgClient.ts`
- `utils/backupFormat.ts`
- `utils/dateDeletionLedger.ts`
- `utils/dateHistoryDeletion.test.ts`
- `utils/dateHistoryDeletion.ts`
- `utils/db.ts`
- `utils/memoryMutationGate.ts`
- `utils/memoryPalace/autoArchive.ts`
- `utils/memoryPalace/db.ts`
- `utils/memoryPalace/digestion.ts`
- `utils/memoryPalace/eventBoxCompression.ts`
- `utils/memoryPalace/extraction.ts`
- `utils/memoryPalace/hybridSearch.ts`
- `utils/memoryPalace/messageProvenance.test.ts`
- `utils/memoryPalace/migration.ts`
- `utils/memoryPalace/pipeline.ts`
- `utils/memoryPalace/roomPlateCloud.test.ts`
- `utils/memoryPalace/roomPlateCloud.ts`
- `utils/memoryPalace/roomPlates.ts`
- `utils/memoryPalace/supabaseVector.ts`
- `utils/memoryPalace/types.ts`
- `utils/memoryPalace/vectorStore.ts`
