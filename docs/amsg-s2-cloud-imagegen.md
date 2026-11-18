# S2：云端中转站生图任务与结果恢复

基线：`d29374ed`（S1 安全基础）；分支 `feat/amsg-s2-cloud-imagegen`（含 `0d9745a6` 群聊自主活跃/主动发图/本地任务恢复全部成果）。状态：**代码与测试完成，未 push、未部署、未动线上密钥/数据**。

## 完成能力（全部「代码已验证」级，自动化测试见下；真实中转站联调属「待实测」）

1. **云端生图闭环**：客户端生成稳定 taskId（UUID）→ `POST /image-gen`（userKey 加密信封，202 受理）→ 浏览器即可切 App/锁屏/关 Safari → Worker cron 每分钟消费（queued→running 租约→completed/failed/unknown）→ 回页面按 taskId 查询+下载 → 写入既有 blobref 存储 → 原消息 pending→ready（+相册，按 messageId 幂等）。
2. **三协议兼容**：上游请求模板由客户端用与本地 `generateImage` **同一套**适配器逻辑构建（gemini-native / openai-images / gpt-images，含官方 gpt-image 尺寸映射与 multipart 参考图）；接口预设零改动。
3. **视觉身份与参考图**：`buildCloudImageGenTemplate` 复用 generateImage 的参考图合并序列（①isPrimary ②临时 ③其他，5 张截断 + 身份文字约束 + photoSemantics）；参考图加密存于任务载荷（私有+鉴权+随任务 7 天过期），**超 900KB 载荷上限明确 413 拒绝、绝不静默丢参考图**；openai-images 无参考图支持时与本地同口径（跳图片留文字；用户显式传参考图则报错）。
4. **存储**：R2 私有桶优先（`env.IMAGE_BUCKET`，键 `img/<userId>/<taskId>`，无公共 URL、不可枚举、下载仅鉴权端点、Cache-Control: private,no-store）；未绑 R2 时 D1 `image_blobs` 直存（≤900KB）。任务/图片 7 天 TTL；cron 每轮做失败/过期/孤儿对象清理。图片绝不进 Web Push 载荷或任务日志。
5. **幂等与计费保护**：taskId 原子登记（INSERT OR IGNORE），重复提交只回既有任务（测试断言上游仅调 1 次）；调用上游前持久化 running 状态与租约；断网/超时 → `unknown`（不自动重发，15 分钟未收敛则客户端标「结果待确认」+手动重试）；明确 HTTP 错误 → `failed`（单次尝试）；重复补收只产生一条消息与一份相册记录。
6. **多玩家隔离（复用并强化 S1）**：所有 image-gen 端点位于口令门+owner_pin 之后，另做行级 `task.user_id === X-User-Id` 核对——**/owner-rebind 换绑后旧 userId 的任务仍不可被新 userId 读取/下载（TASK_FORBIDDEN，已测）**，即持有共享 Token ≠ 跨归属资源所有权。SSRF/凭据防线：仅 HTTPS+公网+443、拒绝 localhost/内网/带凭据 URL、redirect:'manual'（3xx 按失败，已测）。API Key 只存在于加密载荷与发往已验证端点的单次请求。旧 Worker（未过 S1 迁移）没有 image-gen 能力标志，前端不会开启云端路径。
7. **前端接入**：设置 → 生图新增「云端后台生成」开关（能力探测：已连接 + Worker 报告 imageGen + 已配口令才可开；否则置灰并说明原因）；开启时聊天与群聊自主发图统一经 `executeChatPhotoIntent`/`runGroupChatPhotoMessage` 优先上云；关闭时行为与现在完全一致。Chat/GroupChat 挂载恢复先补收云任务再做本地 stale 结算（本地 150s 判定不再误伤云任务）。前台 10s 轮询让页面开着也能自动收图。

## 修改文件

`worker/amsg/src/imageGen.ts`（新，~590 行）、`index.ts`（路由/cron/config-check 能力标志 imageGen+imageStorage）、`utils/cloudImageGen.ts`（新，客户端编排/恢复/轮询）、`utils/imageGenerationService.ts`（导出 buildCloudImageGenRequestTemplate/buildCloudImageGenTemplate）、`utils/activeMsgClient.ts`（submit/query/download/cancel/fetchWorkerConfigCheck）、`utils/chatPhotoGeneration.ts`（云端分支+云任务豁免本地 stale）、`apps/Chat.tsx`、`apps/GroupChat.tsx`（恢复接线）、`components/settings/CloudImageGenToggle.tsx`（新）+`ImageGenerationSettings.tsx`、`worker/amsg/worker.bundle.js`（重建产物）；测试 `imageGen.test.ts`（11）、`cloudImageGen.test.ts`（7）。

## 测试结果

- **模拟中转站端到端（服务端接口层，非浏览器标签页模拟）**：受理→cron→completed→鉴权下载（字节/Content-Type/no-store）；幂等重提交不触发第二次上游调用；500→failed；断网→unknown 不重发；无口令 403/错口令 401；伪造 userId → OWNER_MISMATCH/TASK_FORBIDDEN（含换绑后行级拦截）；双 Worker 相同 taskId 互不可见；http/localhost/内网/非 443/302 全拒；cancel 仅 queued；租约超时收敛 unknown；7 天 TTL 清理；载荷超限 413 不静默丢参考图。**worker/amsg 33 文件 422 项全过**。
- **客户端**：提交挂账/失败落原因；completed→blobref→ready 幂等（重复补收 skip）；failed/unknown 窗口收敛；批量恢复只碰云任务；三协议模板形状；无参考图 provider 明确抛错。**相关回归 33 文件 698 项全过**（含单聊拍照、群聊、即时对话、生图配置/预设）。
- tsc：新代码零错误（sceneCamera/visualIdentity 测试类型错误为 main 基线既有）。`pnpm run build`（vite + 5 worker bundle + guard）通过。
- **待实测**：真实 RelayRouter/官方端点联调、真实 iPhone Safari 锁屏/关页恢复（需用户测试凭据，本阶段未读取任何真实 Key）。

## 所需云资源与成本

- 必需（已有）：Worker + D1 + Cron + S1 口令。
- **可选新增：R2 私有桶**（推荐，大图）——部署步骤（手动，不自动创建）：Cloudflare 面板 → R2 → Create bucket（私有，不开公共访问）→ Worker Settings → Bindings → R2 bucket，变量名 `IMAGE_BUCKET` → 重连即可（config-check 将报 `imageStorage:'r2'`）。成本：R2 免费层 10GB 存储 + 100 万 A 类/1000 万 B 类请求/月——**单玩家 7 天 TTL 下预估新增成本 ≈ 0**；仅重度使用可能触及 $5/月级。
- 不绑 R2 也可用：D1 直存 ≤900KB 图片（2K JPEG 常在阈值内），超限任务明确失败并提示绑 R2。

## 未实现部分（如实说明）

- 结果完成的 Web Push 通知（当前靠回页面补收 + 前台轮询；推送通道可作 S3 增强）。
- URL 型图片结果的二次取回（中转站返回外链时当前按「解析不出图片」失败；主流 b64_json/gemini inline 已覆盖）。
- OCEAN/ComfyUI 本地生图（按要求不纳入）。
- 真实云端联调与真机后台恢复实测（需用户凭据/设备）。

## 部署前置条件（下一阶段执行，不在本分支）

1. 合并 S1+S2 至 main 并部署 Pages；2. 用户在「主动消息 2.0」里点「更新后端」升级 Worker bundle（自带 S1 强制口令 + S2 image-gen；未配口令的旧部署会先被 S1 挡住并给迁移指引）；3. 可选绑定 R2（IMAGE_BUCKET）；4. 设置 → 生图开启「云端后台生成」。
