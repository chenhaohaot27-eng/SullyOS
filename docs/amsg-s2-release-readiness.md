# S1+S2 云端后台生图 · 上线前最终资格检查报告

检查基线：`01129be2` → 本次修复 commit 见文末。分支 `feat/amsg-s2-cloud-imagegen`（含 S1 `d29374ed`、群聊自主活跃 `0d9745a6`）。**未 push、未改线上 Worker/Secret/数据。**

## 一、本次资格检查发现并修复的缺陷

**唯一实质缺陷：URL 型生图结果被误判为「解析不出图片」而失败。**
三家协议（gemini-native inline / openai b64_json / gpt-images）的 base64 与 data URI 此前已覆盖；openai-images 及部分中转站会返回**图片外链 URL**——原实现直接失败。已修复为服务端合规取回（`worker/amsg/src/imageGen.ts`）：
- 地址安全校验复用上游同款 `validateUpstreamUrl`：必须 HTTPS + 公网主机 + 443，拒绝 localhost/内网 IP/带用户名密码；**不携带任何凭据**（结果 CDN 无需鉴权）；
- `redirect: 'manual'`：外链 302 一律按失败处理，不跟重定向；
- Content-Type 必须为 `image/*`（text/html 等直接拒绝，防止把错误页当图片入库）；
- Content-Length 预检 + 实测字节双重大小上限（D1 路径 900KB / R2 路径 20MB），超限明确报错，不假装成功；
- 全部失败路径带具体原因落 task.error，客户端可见。

## 二、逐项核查结论

1. **三种协议 × 三类返回格式**：base64（openai b64_json / gpt-images）✅；data URI（gemini inlineData、`data:image/...`）✅；URL ✅（本次修复，含全套安全取回）。无法安全支持的（http/内网/重定向/非图片/超限）明确报错。
2. **D1 小图 / R2 大图**：>900KB 且未绑 R2 → 任务 failed，错误信息明确引导绑定 R2（已测）；绑定 R2 后 ≤20MB 入私有桶 `img/<userId>/<taskId>`。R2 下载仅经鉴权端点（S1 口令门 + owner_pin + 行级 `task.user_id` 三重核对，伪造 X-User-Id 即便换绑后仍 403，已测）；无公共访问链接，`Cache-Control: private, no-store`。
3. **cron 执行/并发/重复/超时**：任务领取为原子 `UPDATE ... WHERE status='queued'`（D1 单写者串行化），重复 cron/双实例不会二次执行；执行期 12 分钟租约，Worker 重启后租约到期收敛为 `unknown`（**不重发**，不二次计费）；重复提交同 taskId 幂等返回既有任务（上游仅调用一次，已测）；客户端刷新只查不提交。
4. **S1 迁移边界**：未配 Token 的旧 Worker 升级 bundle 后敏感接口 403 + config-check 红字迁移指引；**不清 D1、不换 Master Key、不自动重置用户身份**（owner_pin 首绑须「口令验证 + 存量归属核对」）。每玩家独立 Worker/D1/密钥的部署边界未改变，image-gen 全端点复用同一门禁。
5. **双用户/同名角色/相同 taskId**：双 Worker（不同口令/库）同 taskId 互不可见（401/404，已测）；同 Worker 内伪造 userId 被 owner_pin + 行级归属双重拦截（已测）；charId 只存在于加密 prompt，服务端不按其寻址——同名角色无串扰路径。
6. **群聊/单聊自主发图接入云端**：单聊 `executeChatPhotoIntent` 与群聊 `runGroupChatPhotoMessage` 均在开关开启时优先上云，关闭时原直连路径原样保留（相关 724 项回归含本地生图全套通过）。
7. **未引入**：OCEAN/ComfyUI、推送通知等新功能。

## 三、测试与构建

新增 5 项测试（URL 正常取回 / http+内网外链拒绝 / 重定向+非图片拒绝 / Content-Length 预检 / 901KB 边界 + R2 入桶 + 越权下载 403 + 主人下载字节一致）。**worker/amsg 10 文件 427 项全过**；相关回归 28 文件 **724 项全过**；tsc 新代码零错误（sceneCamera/visualIdentity 为 main 基线既有）；`pnpm run build`（vite + 5 worker bundle + private-npc guard）通过。

## 四、上线报告

### 可直接发布的能力
- S1：Worker 强制口令 + 单用户归属绑定 + /owner-rebind（已含阻断级迁移指引）。
- S2：云端后台生图全链路（幂等受理→cron 执行→R2/D1 存储→鉴权下载→回页补收）；base64/dataURI/URL 三类结果；单聊与群聊自主发图云端优先；本地直连行为不变。

### 仍需用户配置的云资源
- 必需：已有 amsg Worker（D1+Cron+口令），无新增。
- 可选：**R2 私有桶**（手动创建，不开公共访问；Worker Bindings 变量名 `IMAGE_BUCKET`）——不绑则仅支持 ≤900KB 图片，超限明确失败提示。

### 必须在真实手机和中转站实测的项目
1. iPhone Safari：生图提交后切 App/锁屏/关页 → 重开自动补收（含 7 天 TTL 外的过期提示）。
2. 真实 RelayRouter/官方端点：三种 provider 各跑一次（含参考图/视觉身份）真实生成与计费。
3. R2 绑定后 >900KB 真图下载速度与 Cron 消费延迟（≤1 分钟粒度）。
4. 旧 Worker「更新后端」自升级到 S1+S2 bundle 的中间态（config-check 引导）。

### 旧玩家的安全迁移顺序
① 设置→主动消息 2.0→「随机」生成口令 → ② Cloudflare 该 Worker Settings→Variables and Secrets 添加 `AMSG_SERVER_TOKEN`（Secret）→ ③ SullyOS 填同一串 → ④「重新连接并验证」体检变绿 → ⑤（可选）绑 R2 → ⑥ 更新后端至 S1+S2 bundle → ⑦ 设置→生图开启「云端后台生成」。全程不清数据、不换 Master Key；未完成 ①-④ 前新 bundle 会明确 403 阻断而非静默。

### 最终 commit 与部署步骤
- 本次修复 commit：见 git log（`01129be2` 之上，含 URL 取回与 5 项新测试 + 重建 bundle）。
- 部署：合并 `feat/amsg-s2-cloud-imagegen` → main → GitHub Pages Actions 自动部署前端；Worker 侧由各玩家在设置页点「更新后端」完成（无需我们触碰线上 Secret）。
