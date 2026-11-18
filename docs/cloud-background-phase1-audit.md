# 云端后台聊天与生图 + 多玩家严格隔离 · 第一阶段只读审计报告

基线：origin/main `0d9745a6`（含 0d9745a6 新增的 browserTaskRecovery / 群聊自主活跃）。
审计日期：2026-11-18。本阶段未修改任何代码、未部署、未上传密钥/私人数据。

标注约定：**[已验证]**＝代码通读确认；**[待实测]**＝需部署后实测；**[拟议]**＝设计建议。

---

## 1. 当前真实架构与多用户数据流 [已验证]

- **部署模式：每位玩家独立部署一个 Cloudflare Worker**（`worker/amsg/`，包名 sullyos-amsg）。
  - 核心逻辑来自 `@rei-standard/amsg-server`（2.6.0-next.22）`createSingleUserCloudflareWorker`：
    `resolveTenant` 恒返回 `tenantId: "single"`（chunk-5J73MSQ5.mjs L4988-5012）。
  - 资源：1× Worker + 1× D1（表 scheduled_messages / client_state / push_subscriptions /
    llm_credentials / message_outbox，全部按 `user_id` 分区）+ 1× Durable Object（InstantTickDO，
    即时对话在 DO alarm 里跑，墙钟 15 分钟）+ Cron `* * * * *`。
  - wrangler.toml 明示「单用户后端」，D1 database_id 为 REPLACE_WITH_YOUR_D1_ID 占位 → 每玩家自建。
- **多玩家 = N 个互不相干的租户域**（各自的 workers.dev 域名 + D1 + 密钥），**不存在所有玩家共用的服务**。
- **认证**：可选 `AMSG_SERVER_TOKEN`（共享口令，恒时比较校验 `X-Client-Token`，不配则所有端点对公网完全开放，
  /config-check 会红字警告「知道地址的人都能读写你的任务」）[已验证 L4992-4997、index.ts L2521]。
- **数据流（单聊）**：浏览器把 fire_pack（角色卡/世界书/上下文）+ LLM 凭据行用
  `deriveUserEncryptionKey(userId, masterKey)`（SHA-256 派生）加密后经 X-Payload-Encrypted 信封上传 D1；
  即时对话 POST /instant-chat 受理即 202，InstantTickDO alarm 独立 invocation 执行（预算 600s），
  结果 Web Push（VAPID）+ 服务端 message_outbox 账本（行内容按 userKey 加密）；
  客户端回页面后 drainOutbox 补收 + 60s 状态点名（amsgInstantChat）[已验证]。
- **生图**：完全在浏览器端（imageGenerationService 三适配器 gemini-native / openai-images / gpt-images，
  同步请求-响应，无 taskId/轮询）；RelayRouter 仅是 host 改写（/v1↔/v1beta），不经任何 Worker [已验证]。
- **0d9745a6 新增**：browserTaskRecovery 本地台账 + pending 照片「结果待确认」结算（仅本机恢复检测，
  非云端执行）；群聊自主活跃为前台调度 [已验证]。

## 2. 可安全复用的模块 [已验证]

| 模块 | 复用价值 |
|---|---|
| /instant-chat 包装路由（鉴权→转发→202→DO alarm 起跳） | 后台执行的受理/执行范式，可直接套用到生图任务 |
| InstantTickDO（15min 墙钟 alarm） | 长耗时云执行的宿主，避开请求 30s waitUntil |
| llm_credentials 加密凭据行 + 指纹底账 | 生图 API Key 的存储方案原样可用 |
| message_outbox 账本 + drainOutbox/ack + 60s 状态点名 | 结果补收/幂等落库/去重全套 |
| X-Payload-Encrypted 信封 + deriveUserEncryptionKey | 任何新端点的载荷保密 |
| AMSG_SERVER_TOKEN 恒时比较 + /config-check 体检 | 新端点的鉴权与配置自检模式 |
| amsgTaskKinds（metadata.amsgKind → fireKinds handler） | 新增「生图任务」kind 的扩展点 |
| wipeAmsgCloudData（清空云端数据） | 凭据撤销/数据清理入口 |

## 3. 权限隔离风险与证据 [已验证]

1. **userId 不是凭据**：所有请求只靠 `X-User-Id` 头选分区（activeMsgClient L1375），服务端不做任何
   归属证明。同一部署内改 userId 即可切换分区（读不到加密正文，但**可以**取消/覆盖该分区的任务行、
   覆盖 push_subscriptions 行、销账 outbox）。
2. **AMSG_SERVER_TOKEN 未配置 = 完全开放**：`isAuthorized` 无 token 恒 true（L4993）。
   最严重链路：攻击者知道 workerUrl 即可用受害者 userId **覆盖其推送订阅行**（表 PK=user_id），
   后续该用户的聊天回复推送到攻击者设备（Web Push 按订阅加密，订阅是攻击者的）→ **明文泄露聊天内容**。
3. **serverToken 是部署级共享密钥**：知道它 = 该部署全部 userId 的完全读写（含上述订阅劫持）。
   单用户部署下等同「知道口令即本人」，可接受；但**绝不可用于多玩家共用部署**。
4. **跨玩家**：不同部署间无共享密钥、无共享库 → 天然隔离；相同角色 ID/任务 UUID 分属不同 D1，无混用。
5. **/debug、/config-check 无鉴权**（设计使然，只回配置有无/计数，不含值/正文）[已验证 L2948-2960]；
   仍会向公网暴露「该 worker 存在及其配置姿态」。
6. **密钥/内容保密性（静态）**：任务载荷、凭据、订阅、outbox 均以 userKey AES-GCM 加密存 D1 [已验证]；
   masterKey 仅存玩家自己的 Worker env + 本机设置（localStorage）。
7. **结论**：现有模型 = 「每玩家一租户」的物理隔离 + 可选口令。满足「公开网页、无注册、独立配置」，
   但**前提是引导每位玩家必配 serverToken**，且文档必须明确「一个 Worker 只服务一个玩家」。

## 4. 后台执行可行性

- **云端聊天**：[已验证] 即时对话已实现全链路（提交→受理 202→DO alarm 执行→push+outbox→补收→幂等落库）。
  iPhone 锁屏/关 Safari 均可，回页面自动取回——这就是要的产品形态，**聊天后台已可用**。
- **生图（RelayRouter 等中转）**：
  - [已验证] 客户端三条适配器均为同步 HTTP，无异步任务协议；RelayRouter 是否提供异步 taskId 接口 [待实测]。
  - [拟议] 最小方案：新增 `amsgKind = 'image-gen'` 后台任务——受理（复用 /instant-chat 包装层模式）→
    InstantTickDO alarm 内用玩家加密凭据行调 RelayRouter → 结果：
    a) 小图（≤1MB base64）直接进 outbox 加密行；b) 超限走 R2（新增，见 §5）。
  - CPU/时长：DO alarm 墙钟 15min [已验证，代码注释]；Workers CPU 上限与中转站长尾延迟 [待实测]。
- **幂等**：[拟议] 生图任务以客户端生成的 taskId（UUID）为幂等键，worker 侧「行存在即返回原任务」，
  杜绝重复受理/重复扣费；结果按 messageId 销账去重（outbox 既有机制）。
- **失败路径**：断网/超时 → 任务行置 failed + lastError 留痕（既有 chat_fail 机制同构）；
  回页面取回失败原因 + 手动重试（沿用「结果待确认」语义，不自动重发）。

## 5. 实施步骤、云资源与成本

| 步骤 | 内容 | 新资源 |
|---|---|---|
| S1 | 强制引导配置 AMSG_SERVER_TOKEN（连接体检把「未配 token」升级为阻断级警告） | 无 |
| S2 | worker 新增 image-gen 任务 kind + DO alarm 执行 + outbox 回传（小图内联） | 无（复用 DO/D1） |
| S3 | 客户端：SEND_PHOTO 上云受理 + pending uuid 台账 + 回页取回（复用 browserTaskRecovery 语义） | 无 |
| S4 | 大图走 R2：worker 写 R2 + 签名 URL（或带 TTL 的加密路径），outbox 只存引用 | R2（可选，后置） |
| S5 | 过期清理：image 任务行/outbox 沿用既有 TTL 模式；R2 生命周期规则 7 天 | 无 |

费用 [拟议]：Workers Free（10 万 req/天）+ D1 Free（5GB）+ DO Free（10 万 req/天）对单玩家够用；
R2 免费层 10GB 存储 + 100 万 A 类/月 —— **预期新增成本 ≈ 0**；仅重度玩家可能触发 $5 Workers Paid。
不新增账号系统：凭据 = workerUrl + serverToken + masterKey 三元组（本机保存，可随时换 token 撤销）。

## 6. 必须完成的双玩家隔离测试 [拟议]

1. 玩家 A/B 各自部署（不同 D1/masterKey/token）：A 的角色/任务/凭据在 B 的一切端点均不可见、不可取消。
2. 同一部署内恶意客户端：换 X-User-Id 访问对方分区 → 任务列表/取消/订阅覆盖必须被拒（token 模式下 401）。
3. A 重置 serverToken 后，旧 token 立即失效（撤销生效）。
4. 同角色 ID（charId 相同）双玩家同时跑即时对话 → 无串扰。
5. 未配 token 的部署：验证 S1 体检红字阻断 + 订阅覆盖攻击在文档中标注为不可用配置。

## 7. 第一项建议实施的代码任务

**S1：把「未配置 AMSG_SERVER_TOKEN」从提示升级为连接阻断**（amsgDiagnostics + ActiveMsgGlobalSettingsModal），
并在设置页文案写明「一个 Worker 只能服务一个玩家」。改动小、纯前端、直接封掉 §3-2 的订阅劫持链路，
是后续所有云端后台功能的安全前提。

---
*审计范围：utils/amsgInstantChat.ts、activeMsgClient.ts、activeMsgRuntime.ts、chatPhotoGeneration.ts、
imageGenerationService.ts、imageGenerationRelayRouter.ts、browserTaskRecovery.ts、worker/amsg/*（含
@rei-standard/amsg-server 2.6.0-next.22 dist 反编译通读）、wrangler.toml。未运行任何部署或真实密钥。*
