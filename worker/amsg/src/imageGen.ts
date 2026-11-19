/**
 * image-gen —— 云端后台生图任务（S2）。
 *
 * 定位：玩家在 iPhone 上按下生图后即可切 App/锁屏/关 Safari，生成在自己的 amsg Worker
 * 里跑完（cron 每分钟消费队列，单次 scheduled 上下文墙钟 15 分钟），回页面按 taskId 补收。
 *
 * 设计要点（对应任务书）：
 *   - 端点全部位于 S1 口令门 + owner_pin 之后（见 index.ts 的 fetch 接线）；
 *     每个端点再核对行级 user_id === 请求 X-User-Id——持有 Token 不等于可读其他归属
 *     的数据（/owner-rebind 只换主人指针，不改变行级分区）。
 *   - 幂等：taskId 由客户端生成（UUID），INSERT OR IGNORE——重复提交只回既有任务，
 *     绝不重新触发模型调用（计费保护）。
 *   - 状态机：queued → running（租约）→ completed | failed | unknown。
 *     上游结果不明（网络中断/超时且无供应商幂等查询）→ unknown，不自动重发；
 *     明确 HTTP 错误 → failed，单次尝试，不靠重试次数掩盖上游失败。
 *   - 上游调用模板由客户端用本地同一套适配器逻辑构建（gemini-native / openai-images /
 *     gpt-images，含视觉身份参考图），凭据只注入在 Worker 侧发送的那一个请求上；
 *     Worker 校验 URL：必须 HTTPS + 公网主机（拒绝 localhost/内网字面量），redirect:'manual'
 *     （3xx 一律按失败处理，防重定向泄 Key/SSRF）。
 *   - 存储：优先 R2（env.IMAGE_BUCKET 私有桶，对象键 img/<userId>/<taskId>，无公共 URL，
 *     读取只走鉴权端点）；未绑 R2 时 D1 image_blobs 直存，上限 900KB（D1 行限），超限明确
 *     报错引导绑 R2。任务与图片 7 天过期，cron 顺路清理（含失败清理与孤立对象清理）。
 *     参考图作为加密任务载荷的一部分存取（私有+鉴权+随任务过期），超过载荷上限时
 *     明确拒绝而不是静默丢参考图。
 *   - API Key 只进加密载荷（userKey AES-GCM）与发往已验证上游的那一个请求；
 *     不进 URL、元数据、日志与推送。
 */

import { decryptPayload, deriveUserEncryptionKey } from '@rei-standard/amsg-server/cloudflare';

// ─── 常量与限制 ───────────────────────────────────────────

/** 任务/图片保留天数（completed/failed/unknown 一视同仁，到期 cron 清理）。 */
export const IMAGE_TASK_TTL_DAYS = 7;
/** 加密任务载荷（prompt + 上游模板 + 参考图）上限；受 D1 行大小约束。 */
export const IMAGE_PAYLOAD_MAX_BYTES = 900 * 1024;
/** D1 直存图片上限（未绑 R2 时的兜底存储）；R2 上限另计。 */
export const IMAGE_D1_BLOB_MAX_BYTES = 900 * 1024;
/** R2 路径的图片上限。 */
export const IMAGE_R2_MAX_BYTES = 20 * 1024 * 1024;
/** 单次上游调用超时。 */
export const IMAGE_UPSTREAM_TIMEOUT_MS = 300_000;
/** running 租约时长：超过视为执行体已死，收敛为 unknown（不重发）。 */
export const IMAGE_LEASE_MS = 12 * 60 * 1000;
/** 单次 cron 最多消费的任务数（串行，避免长图占满 15 分钟）。 */
export const IMAGE_BATCH_LIMIT = 3;

export type ImageTaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'unknown';

export interface ImageTaskRow {
  task_id: string;
  user_id: string;
  status: ImageTaskStatus;
  /** userKey 加密的上游调用模板（与库内其他敏感载荷同格式）。 */
  encrypted_payload: string;
  /** 结果元数据（不含 Key）：content_type / byte_size / storage / revised_prompt。 */
  result_meta: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  lease_until: number | null;
}

type D1Result<T> = { results?: T[] } | null;

/** 测试可注入的最小 D1 形状。 */
export interface ImageGenD1Like {
  prepare(sql: string): {
    bind(...args: unknown[]): { first(): Promise<unknown>; run(): Promise<unknown>; all(): Promise<unknown> };
    first(): Promise<unknown>;
    run(): Promise<unknown>;
    all(): Promise<unknown>;
  };
}

/** R2 binding 的最小形状（测试注入用）。 */
export interface ImageBucketLike {
  put(key: string, value: ArrayBuffer | Uint8Array | string, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<{ body: ArrayBuffer; size?: number } | null>;
  delete(key: string): Promise<unknown>;
  list(options?: { prefix?: string; limit?: number }): Promise<{ objects: { key: string }[] }>;
}

// ─── 表结构（幂等创建）────────────────────────────────────

const IMAGE_TABLES_SQL = [
  `CREATE TABLE IF NOT EXISTS image_tasks (
    task_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    encrypted_payload TEXT NOT NULL,
    result_meta TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    lease_until INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_image_tasks_status ON image_tasks(status, created_at)`,
  `CREATE TABLE IF NOT EXISTS image_blobs (
    task_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    content_type TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    data TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
];

export async function ensureImageTables(db: ImageGenD1Like): Promise<void> {
  for (const sql of IMAGE_TABLES_SQL) await db.prepare(sql).run();
}

// ─── 数据访问（薄封装，测试可整体替换）──────────────────

export interface ImageTaskStore {
  insertTaskIfAbsent(row: ImageTaskRow): Promise<boolean>;
  getTask(taskId: string): Promise<ImageTaskRow | null>;
  claimTask(taskId: string, leaseUntil: number, now: number): Promise<boolean>;
  expireStaleRunning(now: number): Promise<number>;
  completeTask(taskId: string, resultMeta: Record<string, unknown>, now: number): Promise<void>;
  failTask(taskId: string, error: string, status: 'failed' | 'unknown', now: number): Promise<void>;
  cancelTask(taskId: string, now: number): Promise<boolean>;
  listDueTasks(now: number, limit: number): Promise<Pick<ImageTaskRow, 'task_id' | 'user_id' | 'status' | 'lease_until'>[]>;
  putD1Blob(taskId: string, userId: string, contentType: string, bytes: Uint8Array, now: number): Promise<void>;
  getD1Blob(taskId: string): Promise<{ data: string; content_type: string; user_id: string } | null>;
  deleteExpired(now: number): Promise<number>;
}

export function createD1ImageStore(db: ImageGenD1Like): ImageTaskStore {
  return {
    async insertTaskIfAbsent(row) {
      const result = await db.prepare(
        'INSERT OR IGNORE INTO image_tasks (task_id, user_id, status, encrypted_payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).bind(row.task_id, row.user_id, row.status, row.encrypted_payload, row.created_at, row.updated_at).run() as { meta?: { changes?: number } };
      return (result?.meta?.changes ?? 1) > 0;
    },
    async getTask(taskId) {
      const row = await db.prepare('SELECT task_id, user_id, status, encrypted_payload, result_meta, error, created_at, updated_at, lease_until FROM image_tasks WHERE task_id = ?').bind(taskId).first() as ImageTaskRow | null;
      return row && typeof row.task_id === 'string' ? row : null;
    },
    async claimTask(taskId, leaseUntil, now) {
      const result = await db.prepare(
        "UPDATE image_tasks SET status = 'running', lease_until = ?, updated_at = ? WHERE task_id = ? AND status = 'queued'",
      ).bind(leaseUntil, now, taskId).run() as { meta?: { changes?: number } };
      return (result?.meta?.changes ?? 0) > 0;
    },
    async expireStaleRunning(now) {
      const result = await db.prepare(
        "UPDATE image_tasks SET status = 'unknown', error = ?, updated_at = ? WHERE status = 'running' AND lease_until IS NOT NULL AND lease_until < ?",
      ).bind('执行租约超时：上游结果不明（不自动重发，可手动重试）', now, now).run() as { meta?: { changes?: number } };
      return result?.meta?.changes ?? 0;
    },
    async completeTask(taskId, resultMeta, now) {
      await db.prepare(
        "UPDATE image_tasks SET status = 'completed', result_meta = ?, error = NULL, updated_at = ?, lease_until = NULL WHERE task_id = ?",
      ).bind(JSON.stringify(resultMeta), now, taskId).run();
    },
    async failTask(taskId, error, status, now) {
      await db.prepare(
        'UPDATE image_tasks SET status = ?, error = ?, updated_at = ?, lease_until = NULL WHERE task_id = ?',
      ).bind(status, error, now, taskId).run();
    },
    async cancelTask(taskId, now) {
      const result = await db.prepare(
        "UPDATE image_tasks SET status = 'failed', error = '已取消', updated_at = ?, lease_until = NULL WHERE task_id = ? AND status = 'queued'",
      ).bind(now, taskId).run() as { meta?: { changes?: number } };
      return (result?.meta?.changes ?? 0) > 0;
    },
    async listDueTasks(now, limit) {
      const result = await db.prepare(
        "SELECT task_id, user_id, status, lease_until FROM image_tasks WHERE status = 'queued' AND created_at <= ? ORDER BY created_at ASC LIMIT ?",
      ).bind(now, limit).all() as D1Result<Pick<ImageTaskRow, 'task_id' | 'user_id' | 'status' | 'lease_until'>>;
      return result?.results || [];
    },
    async putD1Blob(taskId, userId, contentType, bytes, now) {
      await db.prepare(
        'INSERT OR REPLACE INTO image_blobs (task_id, user_id, content_type, byte_size, data, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).bind(taskId, userId, contentType, bytes.byteLength, base64Encode(bytes), now).run();
    },
    async getD1Blob(taskId) {
      const row = await db.prepare('SELECT data, content_type, user_id FROM image_blobs WHERE task_id = ?').bind(taskId).first() as { data?: string; content_type?: string; user_id?: string } | null;
      return row && typeof row.data === 'string' ? { data: row.data, content_type: row.content_type || 'image/png', user_id: row.user_id || '' } : null;
    },
    async deleteExpired(now) {
      const cutoff = now - IMAGE_TASK_TTL_DAYS * 24 * 60 * 60 * 1000;
      const blobs = await db.prepare(
        "DELETE FROM image_blobs WHERE task_id IN (SELECT task_id FROM image_tasks WHERE created_at < ? AND status IN ('completed', 'failed', 'unknown') LIMIT 200)",
      ).bind(cutoff).run().catch(() => null) as { meta?: { changes?: number } } | null;
      const tasks = await db.prepare(
        "DELETE FROM image_tasks WHERE created_at < ? AND status IN ('completed', 'failed', 'unknown') LIMIT 200",
      ).bind(cutoff).run() as { meta?: { changes?: number } };
      return (tasks?.meta?.changes ?? 0) + (blobs?.meta?.changes ?? 0);
    },
  };
}

// ─── 基础工具 ─────────────────────────────────────────────

export function base64Encode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function base64Decode(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ─── 上游 URL 校验（SSRF / 凭据泄露防线）──────────────────

const PRIVATE_HOST_RE = /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|0\.0\.0\.0|\[?::1\]?|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|.+\.local|.+\.internal)$/i;

/** 只允许 HTTPS + 公网主机 + 443 端口；凭据只发往通过这道校验的地址。 */
export function validateUpstreamUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, error: '上游地址无法解析' };
  }
  if (parsed.protocol !== 'https:') return { ok: false, error: '上游地址必须是 HTTPS（云端不会向明文 HTTP 发送凭据）' };
  if (parsed.username || parsed.password) return { ok: false, error: '上游地址不允许携带用户名密码' };
  if (parsed.port && parsed.port !== '443') return { ok: false, error: '上游地址端口只允许 443' };
  if (PRIVATE_HOST_RE.test(parsed.hostname)) return { ok: false, error: '上游地址是内网/本机地址，云端后台生图只访问公网端点' };
  return { ok: true, url: parsed.toString() };
}

// ─── 上游模板与结果解析 ───────────────────────────────────

/** 客户端用本地同一套适配器逻辑构建的模板（信封解密后的形状）。 */
export interface UpstreamImageRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  bodyJson?: unknown;
  formFields?: { name: string; value: string }[];
  formFiles?: { name: string; filename: string; mimeType: string; base64: string }[];
  /** 凭据头（只在这里出现；Worker 发请求时注入，不落任何日志/元数据）。 */
  authHeaders: Record<string, string>;
}

const DATA_URI_RE = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i;

/**
 * 从三家协议的响应里抽第一张图（镜像 utils/imageGenerationService 的抽取逻辑；
 * worker bundle 不引浏览器依赖，故在此自含一份并注明同源）。
 * 返回两类：inline（base64 / data URI，直接可用）与 url（外链——由执行器按
 * 「HTTPS 公网 + 无重定向 + 图片类型 + 大小上限」的安全策略取回，不能安全取回就报错）。
 */
export type ExtractedImage =
  | { kind: 'inline'; base64: string; mimeType: string; revisedPrompt?: string }
  | { kind: 'url'; url: string; mimeType?: string; revisedPrompt?: string };

export function extractImageFromUpstreamPayload(payload: unknown): ExtractedImage | null {
  if (!payload || typeof payload !== 'object') return null;
  const root = payload as Record<string, any>;
  const items = Array.isArray(root.data) ? root.data : Array.isArray(root.images) ? root.images : [];
  for (const item of items) {
    if (typeof item === 'string') {
      const fromString = imageFromValue(item);
      if (fromString) return fromString;
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    for (const key of ['b64_json', 'base64', 'image', 'url'] as const) {
      const found = imageFromValue(item[key], item.mime_type || item.mimeType, item.revised_prompt || item.revisedPrompt);
      if (found) return found;
    }
  }
  for (const candidate of Array.isArray(root.candidates) ? root.candidates : []) {
    const parts = candidate?.content?.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      const inline = part?.inlineData || part?.inline_data;
      if (inline) {
        const found = imageFromValue(`data:${inline.mimeType || inline.mime_type || 'image/png'};base64,${inline.data}`);
        if (found) return found;
      }
    }
  }
  return imageFromValue(root.b64_json) || imageFromValue(root.base64) || imageFromValue(root.image) || imageFromValue(root.url);
}

function imageFromValue(value: unknown, mimeType = 'image/png', revisedPrompt?: string): ExtractedImage | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();
  const dataMatch = DATA_URI_RE.exec(trimmed);
  if (dataMatch) return { kind: 'inline', base64: dataMatch[2].replace(/\s/g, ''), mimeType: dataMatch[1], revisedPrompt };
  if (/^https?:\/\//i.test(trimmed)) {
    // 外链结果：不下结论，交给执行器的安全取回；非 https 在那儿也会被明确拒绝。
    return { kind: 'url', url: trimmed, mimeType: mimeType.startsWith('image/') ? mimeType : undefined, revisedPrompt };
  }
  if (trimmed.length < 8) return null;
  return { kind: 'inline', base64: trimmed.replace(/\s/g, ''), mimeType, revisedPrompt };
}

// ─── 执行器（cron 消费队列）──────────────────────────────

export interface RunImageTaskDeps {
  env: { DB: unknown; IMAGE_BUCKET?: unknown; AMSG_MASTER_KEY?: string };
  store: ImageTaskStore;
  bucket?: ImageBucketLike;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const r2ObjectKey = (userId: string, taskId: string) => `img/${userId}/${taskId}`;

/** 单任务执行：claim → 解密 → 校验 → 调上游 → 存图 → 终态。任何阶段不抛出（终态自收敛）。 */
export async function runImageTask(taskId: string, userId: string, deps: RunImageTaskDeps): Promise<void> {
  const { store, env } = deps;
  const now = deps.now ?? Date.now;
  if (!(await store.claimTask(taskId, now() + IMAGE_LEASE_MS, now()))) return;
  const task = await store.getTask(taskId);
  if (!task || task.user_id !== userId) return;
  let template: UpstreamImageRequest;
  try {
    const userKey = await deriveUserEncryptionKey(userId, env.AMSG_MASTER_KEY || '');
    // 载荷 = 客户端信封对象（与 /instant-chat 同格式：{iv, authTag, encryptedData}）。
    template = await decryptPayload(JSON.parse(task.encrypted_payload), userKey) as UpstreamImageRequest;
  } catch (error) {
    await store.failTask(taskId, `任务载荷解密失败（换过 AMSG_MASTER_KEY？）：${error instanceof Error ? error.message : String(error)}`, 'failed', now());
    return;
  }
  try {
    await executeUpstreamAndStore(taskId, userId, template, deps);
  } catch (error) {
    // 网络中断/超时/断网：上游是否已受理并计费不可知 → unknown，绝不自动重发。
    const message = error instanceof Error ? error.message : String(error);
    await store.failTask(taskId, `上游调用结果不明（${message}）：不自动重发，可回页面手动重试`, 'unknown', now());
  }
}

async function executeUpstreamAndStore(taskId: string, userId: string, template: UpstreamImageRequest, deps: RunImageTaskDeps): Promise<void> {
  const { store, env } = deps;
  const now = deps.now ?? Date.now;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const upstreamCheck = validateUpstreamUrl(template.url);
  if (!upstreamCheck.ok) {
    await store.failTask(taskId, `上游地址被拒绝：${upstreamCheck.error}`, 'failed', now());
    return;
  }
  let body: BodyInit | undefined;
  const headers: Record<string, string> = { ...(template.headers || {}), ...(template.authHeaders || {}) };
  if (template.bodyJson !== undefined) {
    body = JSON.stringify(template.bodyJson);
  } else if (template.formFields || template.formFiles) {
    const form = new FormData();
    for (const field of template.formFields || []) form.append(field.name, field.value);
    for (const file of template.formFiles || []) {
      form.append(file.name, new Blob([base64Decode(file.base64).buffer as ArrayBuffer], { type: file.mimeType }), file.filename);
    }
    body = form;
  }
  const response = await fetchImpl(upstreamCheck.url, {
    method: template.method || 'POST',
    headers,
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(IMAGE_UPSTREAM_TIMEOUT_MS),
  });
  // 重定向一律按失败处理：跟过去等于把凭据发给未校验的地址。
  if (response.status >= 300 && response.status < 400) {
    await store.failTask(taskId, `上游返回重定向（${response.status}），已拒绝跟随`, 'failed', now());
    return;
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    await store.failTask(taskId, `上游返回 HTTP ${response.status}：${detail.slice(0, 200)}`, 'failed', now());
    return;
  }
  const payload = await response.json().catch(() => null);
  const extracted = extractImageFromUpstreamPayload(payload);
  if (!extracted) {
    await store.failTask(taskId, '上游响应里没有解析得出图片（协议不兼容或空结果）', 'failed', now());
    return;
  }
  let bytes: Uint8Array;
  let mimeType: string;
  if (extracted.kind === 'url') {
    // 外链结果：服务端安全取回——HTTPS 公网地址（同上游校验）、不带任何凭据、
    // 不跟重定向、必须是图片内容类型、Content-Length 预检 + 实测大小上限。
    const urlCheck = validateUpstreamUrl(extracted.url);
    if (!urlCheck.ok) {
      await store.failTask(taskId, `上游返回的图片外链被拒绝（${urlCheck.error}）：不会取回，也不假装生成成功`, 'failed', now());
      return;
    }
    const limit = (deps.bucket || (env.IMAGE_BUCKET as unknown as ImageBucketLike | undefined)) ? IMAGE_R2_MAX_BYTES : IMAGE_D1_BLOB_MAX_BYTES;
    const imageResponse = await fetchImpl(urlCheck.url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(120_000),
    });
    if (imageResponse.status >= 300 && imageResponse.status < 400) {
      await store.failTask(taskId, `图片外链返回重定向（${imageResponse.status}），已拒绝跟随`, 'failed', now());
      return;
    }
    if (!imageResponse.ok) {
      await store.failTask(taskId, `图片外链取回失败（HTTP ${imageResponse.status}）`, 'failed', now());
      return;
    }
    const contentType = (imageResponse.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
    if (!contentType.startsWith('image/')) {
      await store.failTask(taskId, `图片外链的内容类型不是图片（${contentType || '未知'}），已拒绝`, 'failed', now());
      return;
    }
    const declaredLength = Number(imageResponse.headers.get('Content-Length') || '');
    if (Number.isFinite(declaredLength) && declaredLength > limit) {
      await store.failTask(taskId, `图片外链声明大小超过上限（${Math.round(declaredLength / 1024)}KB > ${Math.round(limit / 1024)}KB）`, 'failed', now());
      return;
    }
    const urlBytes = new Uint8Array(await imageResponse.arrayBuffer());
    if (urlBytes.byteLength === 0 || urlBytes.byteLength > limit) {
      await store.failTask(taskId, urlBytes.byteLength === 0 ? '图片外链内容为空' : `图片外链实际大小超过上限（${Math.round(urlBytes.byteLength / 1024)}KB）`, 'failed', now());
      return;
    }
    bytes = urlBytes;
    mimeType = contentType;
  } else {
    bytes = base64Decode(extracted.base64);
    mimeType = extracted.mimeType;
  }
  if (bytes.byteLength === 0) {
    await store.failTask(taskId, '上游返回的图片内容为空', 'failed', now());
    return;
  }
  const bucket = deps.bucket || (env.IMAGE_BUCKET as unknown as ImageBucketLike | undefined);
  const resultMeta: Record<string, unknown> = {
    content_type: mimeType,
    byte_size: bytes.byteLength,
    revised_prompt: extracted.revisedPrompt,
  };
  if (bucket) {
    if (bytes.byteLength > IMAGE_R2_MAX_BYTES) {
      await store.failTask(taskId, `结果图片超过 R2 上限 20MB`, 'failed', now());
      return;
    }
    await bucket.put(r2ObjectKey(userId, taskId), bytes, { httpMetadata: { contentType: mimeType } });
    resultMeta.storage = 'r2';
    resultMeta.object_key = r2ObjectKey(userId, taskId);
  } else {
    if (bytes.byteLength > IMAGE_D1_BLOB_MAX_BYTES) {
      await store.failTask(taskId, `结果图片超过 D1 直存上限 900KB：请给 Worker 绑定 R2（IMAGE_BUCKET）后重试`, 'failed', now());
      return;
    }
    await store.putD1Blob(taskId, userId, mimeType, bytes, now());
    resultMeta.storage = 'd1';
  }
  await store.completeTask(taskId, resultMeta, now());
}

/** cron 入口：租约收敛 → 消费队列 → 过期清理（D1 + R2 孤儿对象）。 */
export async function runImageGenCronPass(deps: RunImageTaskDeps): Promise<{ ran: number; expired: number }> {
  const { store } = deps;
  const now = deps.now ?? Date.now;
  let ran = 0;
  try {
    try {
      await ensureImageTables(deps.env.DB as ImageGenD1Like);
    } catch { /* 注入了内存 store / D1 暂不可用：结构由注入方负责 */ }
    await store.expireStaleRunning(now());
    for (const task of await store.listDueTasks(now(), IMAGE_BATCH_LIMIT)) {
      await runImageTask(task.task_id, task.user_id, deps);
      ran += 1;
    }
  } catch (error) {
    console.warn('[image-gen] cron 消费失败（下个周期再试）', error);
  }
  let expired = 0;
  try {
    expired = await store.deleteExpired(now());
    const bucket = deps.bucket || (deps.env.IMAGE_BUCKET as unknown as ImageBucketLike | undefined);
    if (bucket) {
      const listed = await bucket.list({ prefix: 'img/', limit: 500 });
      for (const object of listed.objects || []) {
        const taskId = object.key.split('/').pop() || '';
        const task = await store.getTask(taskId).catch(() => null);
        if (!task) await bucket.delete(object.key).catch(() => null);
      }
    }
  } catch (error) {
    console.warn('[image-gen] 过期清理失败（下个周期再试）', error);
  }
  return { ran, expired };
}

// ─── HTTP 端点（全部位于 S1 口令门 + owner_pin 之后；行级再核对 user_id）───

interface EndpointCtx {
  request: Request;
  env: { DB: unknown; IMAGE_BUCKET?: unknown; AMSG_MASTER_KEY?: string };
  json: (status: number, body: unknown, extraHeaders?: Record<string, string>) => Response;
  now?: () => number;
  store?: ImageTaskStore;
}

/** 测试注入点（同 chatPhotoIntent 的 resetChatPhotoTurnClaimsForTests 风格）：绕过 D1 构造。 */
let storeOverrideForTests: ImageTaskStore | null = null;
export function __setImageGenStoreOverrideForTests(store: ImageTaskStore | null): void {
  storeOverrideForTests = store;
}

const storeOf = (ctx: EndpointCtx): ImageTaskStore =>
  storeOverrideForTests ?? ctx.store ?? createD1ImageStore(ctx.env.DB as ImageGenD1Like);

const userIdOf = (request: Request) => request.headers.get('x-user-id')?.trim() || '';

/** POST /image-gen —— 受理（幂等）。body: { taskId, envelope }，envelope 为 userKey 加密的上游模板。 */
export async function handleImageGenSubmit(ctx: EndpointCtx): Promise<Response> {
  const { request, env, json } = ctx;
  const now = ctx.now ?? Date.now;
  const userId = userIdOf(request);
  const body = await request.json().catch(() => null) as { taskId?: unknown; envelope?: unknown } | null;
  const taskId = typeof body?.taskId === 'string' ? body.taskId.trim() : '';
  const envelope = body?.envelope;
  if (!taskId || !envelope || typeof envelope !== 'object') {
    return json(400, { success: false, error: { code: 'INVALID_SUBMIT', message: '需要 { taskId, envelope }' } });
  }
  const encryptedPayload = JSON.stringify(envelope);
  if (encryptedPayload.length > IMAGE_PAYLOAD_MAX_BYTES) {
    return json(413, {
      success: false,
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: `任务载荷（含参考图）超过上限。参考图不会被静默丢弃：请压缩参考图/减少数量后重试，或改用无参考图生成。`,
      },
    });
  }
  // 载荷必须能以请求者的 userKey 解开（格式与归属双检），再原样密存。
  try {
    const userKey = await deriveUserEncryptionKey(userId, env.AMSG_MASTER_KEY || '');
    const template = await decryptPayload(envelope as { iv: string; authTag: string; encryptedData: string }, userKey) as UpstreamImageRequest;
    const check = validateUpstreamUrl(template.url);
    if (!check.ok) return json(400, { success: false, error: { code: 'UPSTREAM_REJECTED', message: `上游地址被拒绝：${check.error}` } });
  } catch {
    return json(400, { success: false, error: { code: 'ENVELOPE_INVALID', message: '载荷解密失败：请确认 AMSG_MASTER_KEY 与本机配置一致' } });
  }
  const store = storeOf(ctx);
  // D1 路径顺带幂等建表；测试/显式注入 store 时由注入方负责结构。
  if (!storeOverrideForTests && !ctx.store) await ensureImageTables(env.DB as ImageGenD1Like);
  const inserted = await store.insertTaskIfAbsent({
    task_id: taskId,
    user_id: userId,
    status: 'queued',
    encrypted_payload: encryptedPayload,
    result_meta: null,
    error: null,
    created_at: now(),
    updated_at: now(),
    lease_until: null,
  });
  const task = await store.getTask(taskId);
  if (!task) return json(500, { success: false, error: { code: 'SUBMIT_FAILED', message: '任务登记失败' } });
  return json(inserted ? 202 : 200, {
    success: true,
    data: {
      taskId,
      status: task.status,
      created: inserted,
      note: inserted ? undefined : '任务已存在（幂等命中，未重复提交上游）',
    },
  });
}

export interface ImageTaskStatusView {
  taskId: string;
  status: ImageTaskStatus;
  error?: string;
  result?: { contentType: string; byteSize: number; revisedPrompt?: string };
  createdAt: number;
  updatedAt: number;
}

function statusView(task: ImageTaskRow): ImageTaskStatusView {
  const meta = task.result_meta ? JSON.parse(task.result_meta) as Record<string, unknown> : null;
  return {
    taskId: task.task_id,
    status: task.status,
    error: task.error || undefined,
    result: meta ? {
      contentType: typeof meta.content_type === 'string' ? meta.content_type : 'image/png',
      byteSize: typeof meta.byte_size === 'number' ? meta.byte_size : 0,
      revisedPrompt: typeof meta.revised_prompt === 'string' ? meta.revised_prompt : undefined,
    } : undefined,
    createdAt: task.created_at,
    updatedAt: task.updated_at,
  };
}

/** 行级归属核对：S1 门已验证口令与主人身份，这里再保证行 user_id 与请求一致。 */
async function loadOwnedTask(ctx: EndpointCtx, taskId: string): Promise<ImageTaskRow | null | 'forbidden'> {
  const store = storeOf(ctx);
  const task = await store.getTask(taskId);
  if (!task) return null;
  if (task.user_id !== userIdOf(ctx.request)) return 'forbidden';
  return task;
}

/** GET /image-gen/<taskId> —— 状态查询。 */
export async function handleImageGenStatus(ctx: EndpointCtx, taskId: string): Promise<Response> {
  const task = await loadOwnedTask(ctx, taskId);
  if (task === 'forbidden') return ctx.json(403, { success: false, error: { code: 'TASK_FORBIDDEN', message: '任务不属于当前归属（X-User-Id 与任务归属不一致）' } });
  if (!task) return ctx.json(404, { success: false, error: { code: 'TASK_NOT_FOUND', message: '任务不存在或已过期清理' } });
  return ctx.json(200, { success: true, data: statusView(task) });
}

/** POST /image-gen/<taskId>/cancel —— 仅 queued 可取消。 */
export async function handleImageGenCancel(ctx: EndpointCtx, taskId: string): Promise<Response> {
  const task = await loadOwnedTask(ctx, taskId);
  if (task === 'forbidden') return ctx.json(403, { success: false, error: { code: 'TASK_FORBIDDEN', message: '任务不属于当前归属' } });
  if (!task) return ctx.json(404, { success: false, error: { code: 'TASK_NOT_FOUND', message: '任务不存在' } });
  const store = storeOf(ctx);
  const cancelled = await store.cancelTask(taskId, (ctx.now ?? Date.now)());
  if (!cancelled) return ctx.json(409, { success: false, error: { code: 'NOT_CANCELLABLE', message: `任务已进入 ${task.status}，不能取消` } });
  return ctx.json(200, { success: true, data: { taskId, status: 'failed', note: '已取消' } });
}

/** GET /image-gen/<taskId>/result —— 图片字节（R2 或 D1），鉴权+归属通过才出数据。 */
export async function handleImageGenResult(ctx: EndpointCtx, taskId: string): Promise<Response> {
  const task = await loadOwnedTask(ctx, taskId);
  if (task === 'forbidden') return ctx.json(403, { success: false, error: { code: 'TASK_FORBIDDEN', message: '任务不属于当前归属' } });
  if (!task) return ctx.json(404, { success: false, error: { code: 'TASK_NOT_FOUND', message: '任务不存在或已过期清理' } });
  if (task.status !== 'completed' || !task.result_meta) {
    return ctx.json(409, { success: false, error: { code: 'NOT_COMPLETED', message: `任务状态是 ${task.status}，还没有可下载的结果` } });
  }
  const meta = JSON.parse(task.result_meta) as { content_type?: string; storage?: string; object_key?: string };
  const bucket = ctx.env.IMAGE_BUCKET as unknown as ImageBucketLike | undefined;
  if (meta.storage === 'r2' && bucket) {
    const object = await bucket.get(meta.object_key || '');
    if (!object) return ctx.json(410, { success: false, error: { code: 'RESULT_EXPIRED', message: '结果图片已被过期清理' } });
    return new Response(object.body, {
      status: 200,
      headers: { 'Content-Type': meta.content_type || 'image/png', 'Cache-Control': 'private, no-store' },
    });
  }
  const store = storeOf(ctx);
  const blob = await store.getD1Blob(taskId);
  if (!blob) return ctx.json(410, { success: false, error: { code: 'RESULT_EXPIRED', message: '结果图片已被过期清理' } });
  return new Response(base64Decode(blob.data) as unknown as BodyInit, {
    status: 200,
    headers: { 'Content-Type': blob.content_type, 'Cache-Control': 'private, no-store' },
  });
}





