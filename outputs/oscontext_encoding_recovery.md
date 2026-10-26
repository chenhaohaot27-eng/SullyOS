# OSContext.tsx 编码事故恢复记录（2026-10-26）

## 事故
审计过程中一次 Windows PowerShell 5.1 `Get-Content`/`WriteAllLines` 操作把
`context/OSContext.tsx`（UTF-8 无 BOM）按 ANSI/GBK 读写，产生确定性
UTF-8→GBK mojibake（中文注释/字符串受损，ASCII 代码完好）。

## 恢复
1. 灾难发生后立即对整文件做逆变换快照（`%TEMP%/oscontext_rev_f.txt`，结构完整）。
2. 以 `git show HEAD:context/OSContext.tsx` 为中文参照、以逆变换快照为结构基准，
   用 git diff 对齐后确定性重建：HEAD 未改行直接采用 HEAD 原文，改名等未提交改动
   行采用逆变换结果，506/509 行完整恢复。
3. 仅 3 行（备份导入的未提交新代码，不存在于 HEAD）按上下文推断重建：
   `outputs/repair_oscontext_report.json` 保存了当时的原始损坏数据备查。

## 验证
- 全文 0 个 U+FFFD、0 个 GBK mojibake 特征序列；
- `npx tsc --noEmit` 对 OSContext.tsx 无任何报错；
- 行数与 HEAD+未提交改动一致；后续 vitest/tsc 回归全部通过（见测试报告）。
