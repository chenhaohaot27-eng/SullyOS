# S1：主动消息 2.0 Worker 鉴权加固与单用户部署隔离

基线：origin/main `0d9745a6`；分支 `feat/amsg-s1-token-enforcement`。状态：**代码与测试已完成，未 push、未部署、未改动任何线上密钥**。
背景与威胁模型见 `docs/cloud-background-phase1-audit.md` §3（订阅劫持/改 userId 越权/未配口令全开放）。

## 修改文件

| 文件 | 内容 |
|---|---|
| `worker/amsg/src/index.ts` | ① `enforceServerTokenGate` 统一授权门：未配 AMSG_SERVER_TOKEN → 敏感端点一律 403 `SERVER_TOKEN_REQUIRED`（不进上游）；口令缺失/错误 → 401 `INVALID_CLIENT_TOKEN`（HMAC 恒时比较）。② 单用户归属绑定：`owner_pin` 表（D1，幂等建表）记住主人 user_id；首次绑定必须「口令通过 + 存量数据归属核对」，绝不盲绑第一个请求者；绑定后改 X-User-Id → 403 `OWNER_MISMATCH`。③ `POST /owner-rebind`（需正确口令，跳过 pin 检查）：合法换绑通道，只重绑指针、不动任何数据。④ `/config-check` 新增 `serverTokenEnforced: true` 能力标志；`SERVER_TOKEN_MISSING` 警告文案升级为阻断级+迁移步骤。诊断三件套（config-check/debug/self-update）保持开放（只读、无敏感值；self-update 自带共享密钥+CF_API_TOKEN）。 |
| `utils/amsgDiagnostics.ts` | 体检新增「访问口令」行：`SERVER_TOKEN_MISSING` → 红（bad），否则绿。 |
| `components/settings/ActiveMsgGlobalSettingsModal.tsx` | 口令输入改为「必填」文案 + 老部署迁移指引（随机生成 → Cloudflare 配 Secret → 两端一致 → 重新连接）。一键部署本就自动生成口令（cfProvision），无需改。 |
| `worker/amsg/src/tokenGate.test.ts`（新） | 服务端接口层安全测试（13 项，见下）。 |
| `worker/amsg/src/index.test.ts` | 既有入口测试夹具补口令（行为断言不变，验证「过门之后」各层照旧）。 |
| `worker/amsg/worker.bundle.js` | 重新构建的部署产物（public/ 副本为 gitignore 构建产物）。 |

## 已验证的安全修复（全部在服务端接口层直测，非浏览器标签页模拟）

1. 未配口令：任务/订阅/凭据/状态/outbox/instant-chat/capabilities 全部 403 `SERVER_TOKEN_REQUIRED`，不进上游。
2. 口令缺失/错误 → 401；正确口令放行并推进到下一层（fetch 级验证到达配置门 503）。
3. 改 X-User-Id 无法越权：存量属 alice 时 mallory（即使口令正确）被 403 `OWNER_MISMATCH` 且不绑定；换绑只能走带口令的 `/owner-rebind`。
4. 订阅劫持链路封死：无口令/错口令写不了 `/push-subscription`。
5. 双实例隔离：A 的口令在 B 上 401；即便 B 口令泄露，A 的 userId 也 403；相同 charId/taskId 不串（各自独立 D1/pin）。
6. 口令旋转：换 token 后旧口令立即 401，新口令恢复。
7. OPTIONS 预检照常 204；/config-check、/debug 在无口令时仍可用（迁移诊断靠它们）。

测试结果：`worker/amsg` 全部 **429/429 通过**（含新增 13 项）；客户端 amsg 系列 8 文件 **316/316 通过**；tsc 无新错误；`pnpm run build`（vite + 5 worker bundle + guard）通过。全量套件与 main 基线一致（activeMsgClient.test.ts 21 项超时为基线既有环境问题，已在干净基线工作树复现）。

## 既有部署迁移步骤（不破坏任何数据）

1. SullyOS 设置页「主动消息 2.0」→ 访问口令 → 点「随机」生成（或自填强口令）。
2. Cloudflare 该 Worker → Settings → Variables and Secrets → 添加 `AMSG_SERVER_TOKEN`（类型 Secret），值与上一步完全一致。
3. 回设置页点「重新连接并验证」→ 体检「访问口令」变绿即完成。**不换 AMSG_MASTER_KEY、不清 D1、任务/订阅/历史全部保留。**
4. 换设备/重装导致用户 ID 变化时：`POST <workerUrl>/owner-rebind`（带 X-Client-Token 与新 X-User-Id）重新绑定。

## 对已部署玩家的影响

- **已配口令的玩家（含一键部署）**：升级 Worker bundle 后行为不变（多一层归属绑定，首次绑定时其自身 userId 与存量一致，自动通过）。
- **未配口令的老部署**：升级 bundle 后敏感接口 403，主动消息/即时对话暂停（**不是静默失败**——config-check 红字 + 明确错误码 + 迁移步骤，按上面三步恢复）。这是修复「任何人可读写/劫持推送」漏洞的必然代价。
- **不升级 bundle 的老 Worker**：维持旧的可选行为（风险仍在），直到用户自更新。

## 云端生图（下一阶段）安全前置条件

✅ 已具备：强制口令 + 恒时比较、单用户归属绑定与换绑通道、加密凭据行存储模式、outbox 幂等回传、阻断级配置体检。
⏳ 待 S2 落地：`image-gen` 任务 kind、DO alarm 内调中转站、taskId 幂等键、结果 TTL 清理（见审计报告 §4/§5）。
