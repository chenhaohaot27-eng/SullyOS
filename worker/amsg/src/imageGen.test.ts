// S2 云端后台生图：服务端接口层端到端测试（模拟中转站 + 内存任务库，全程走 worker.fetch
// 完整链路：S1 口令门 → owner_pin → 行级归属 → 幂等 → cron 执行 → 结果下载 → 清理）。
import { describe, expect, it, vi, afterEach } from 'vitest';
import worker from './index';
import { deriveUserEncryptionKey } from '@rei-standard/amsg-server/cloudflare';
import {
  runImageGenCronPass,
  __setImageGenStoreOverrideForTests,
  IMAGE_TASK_TTL_DAYS,
  type ImageGenD1Like,
  type ImageTaskStore,
  type ImageTaskRow,
} from './imageGen';

const BASE = 'https://amsg-test.example.workers.dev';
const MASTER_KEY = 'a'.repeat(64);
const TOKEN = 'tok-correct';
const USER = 'alice';

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// ─── 内存任务库（实现 ImageTaskStore 接口，绕过 SQL）──────────

function makeMemStore(): ImageTaskStore & { tasks: Map<string, ImageTaskRow>; blobs: Map<string, { content_type: string; data: string; user_id: string }> } {
  const tasks = new Map<string, ImageTaskRow>();
  const blobs = new Map<string, { content_type: string; data: string; user_id: string }>();
  return {
    tasks, blobs,
    async insertTaskIfAbsent(row) { if (tasks.has(row.task_id)) return false; tasks.set(row.task_id, { ...row }); return true; },
    async getTask(taskId) { return tasks.get(taskId) ? { ...tasks.get(taskId)! } : null; },
    async claimTask(taskId, leaseUntil, now) {
      const task = tasks.get(taskId);
      if (!task || task.status !== 'queued') return false;
      task.status = 'running'; task.lease_until = leaseUntil; task.updated_at = now;
      return true;
    },
    async expireStaleRunning(now) {
      let changes = 0;
      for (const task of tasks.values()) {
        if (task.status === 'running' && task.lease_until != null && task.lease_until < now) { task.status = 'unknown'; task.updated_at = now; changes += 1; }
      }
      return changes;
    },
    async completeTask(taskId, resultMeta, now) {
      const task = tasks.get(taskId);
      if (task) { task.status = 'completed'; task.result_meta = JSON.stringify(resultMeta); task.error = null; task.updated_at = now; task.lease_until = null; }
    },
    async failTask(taskId, error, status, now) {
      const task = tasks.get(taskId);
      if (task) { task.status = status; task.error = error; task.updated_at = now; task.lease_until = null; }
    },
    async cancelTask(taskId, now) {
      const task = tasks.get(taskId);
      if (!task || task.status !== 'queued') return false;
      task.status = 'failed'; task.error = '已取消'; task.updated_at = now;
      return true;
    },
    async listDueTasks(now, limit) {
      return [...tasks.values()]
        .filter(task => task.status === 'queued' && task.created_at <= now)
        .sort((a, b) => a.created_at - b.created_at)
        .slice(0, limit)
        .map(task => ({ task_id: task.task_id, user_id: task.user_id, status: task.status, lease_until: task.lease_until }));
    },
    async putD1Blob(taskId, userId, contentType, bytes, now) {
      blobs.set(taskId, { content_type: contentType, user_id: userId, data: bytesToBase64(new Uint8Array(bytes)) });
    },
    async getD1Blob(taskId) {
      const blob = blobs.get(taskId);
      return blob ? { ...blob } : null;
    },
    async deleteExpired(now) {
      const cutoff = now - IMAGE_TASK_TTL_DAYS * 24 * 60 * 60 * 1000;
      let changes = 0;
      for (const [id, task] of tasks) {
        if (task.created_at < cutoff && ['completed', 'failed', 'unknown'].includes(task.status)) { tasks.delete(id); blobs.delete(id); changes += 1; }
      }
      return changes;
    },
  };
}

// ─── owner_pin 用的最小 D1 桩（S1 测试同款）────────────────

function makePinD1(state: { pin?: string }): ImageGenD1Like {
  const stmt = (sql: string, args: unknown[]) => ({
    async first() {
      if (/FROM owner_pin/.test(sql)) return state.pin === undefined ? null : { user_id: state.pin };
      throw new Error(`unexpected first: ${sql}`);
    },
    async run() {
      if (/CREATE TABLE IF NOT EXISTS owner_pin/.test(sql)) return {};
      if (/INSERT OR REPLACE INTO owner_pin/.test(sql)) { state.pin = String(args[0]); return {}; }
      throw new Error(`unexpected run: ${sql}`);
    },
    async all() { throw new Error(`unexpected all: ${sql}`); },
  });
  const bind = (sql: string) => ({ bind: (...a: unknown[]) => stmt(sql, a), ...stmt(sql, []) });
  return { prepare: (sql: string) => bind(sql) } as ImageGenD1Like;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

// ─── 信封加密（与客户端 ReiClient._encrypt 同格式：AES-GCM 12B iv + 拆 tag）───

async function makeEnvelope(payload: unknown, userId = USER, masterKey = MASTER_KEY): Promise<{ iv: string; authTag: string; encryptedData: string }> {
  const keyHex = await deriveUserEncryptionKey(userId, masterKey);
  const key = await crypto.subtle.importKey('raw', hexToBytes(keyHex).buffer as ArrayBuffer, { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(payload))));
  return {
    iv: bytesToBase64(iv),
    authTag: bytesToBase64(cipher.slice(cipher.length - 16)),
    encryptedData: bytesToBase64(cipher.slice(0, cipher.length - 16)),
  };
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

/** 模拟中转站：OpenAI b64_json 协议返回一张小 PNG。 */
const mockRelayOk = vi.fn(async () => new Response(
  JSON.stringify({ data: [{ b64_json: bytesToBase64(PNG_BYTES) }] }),
  { status: 200, headers: { 'Content-Type': 'application/json' } },
));

const makeEnv = (patch: Record<string, unknown> = {}) => ({
  AMSG_MASTER_KEY: MASTER_KEY,
  AMSG_SERVER_TOKEN: TOKEN,
  DB: makePinD1({}),
  ...patch,
} as unknown as Parameters<typeof worker.fetch>[1]);

// 测试桩环境与真实 Env 类型有出入，统一走 any 化的 fetch 句柄（index.test.ts 同做法）。
const fetchWorker = (worker as unknown as { fetch: (req: Request, env: unknown, ctx: unknown) => Promise<Response> }).fetch.bind(worker);

const call = (path: string, init: RequestInit = {}, env = makeEnv()) =>
  fetchWorker(new Request(`${BASE}/${path.replace(/^\//, '')}`, {
    ...init,
    headers: { 'X-Client-Token': TOKEN, 'X-User-Id': USER, ...(init.headers || {}) },
  }), env, { waitUntil: () => {} });

const submit = (taskId: string, envelope: unknown, init: RequestInit = {}, env = makeEnv()) =>
  call('image-gen', { method: 'POST', body: JSON.stringify({ taskId, envelope }), ...init }, env);

const upstreamTemplate = (url = 'https://relay.example/v1/images/generations') => ({
  url, method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  bodyJson: { model: 'img-model', prompt: 'a cat', n: 1, response_format: 'b64_json' },
  authHeaders: { Authorization: 'Bearer sk-secret' },
});

afterEach(() => {
  __setImageGenStoreOverrideForTests(null);
  vi.unstubAllGlobals();
  mockRelayOk.mockClear();
});

describe('S2·端到端：提交 → cron 执行 → 状态 → 下载（模拟中转站）', () => {
  it('受理 202 → cron 消费 → completed → 结果字节可下载且带归属校验', async () => {
    const store = makeMemStore();
    __setImageGenStoreOverrideForTests(store);
    const envelope = await makeEnvelope(upstreamTemplate());

    const accepted = await submit('task-e2e', envelope);
    expect(accepted.status).toBe(202);
    expect((await accepted.json()).data.status).toBe('queued');

    const result = await runImageGenCronPass({
      env: { DB: {} as unknown, AMSG_MASTER_KEY: MASTER_KEY },
      store,
      fetchImpl: mockRelayOk as unknown as typeof fetch,
    });
    expect(result.ran).toBe(1);
    expect(store.tasks.get('task-e2e')?.status).toBe('completed');
    expect(mockRelayOk).toHaveBeenCalledTimes(1);
    // 凭据只发往已校验的上游，且带 Authorization
    const upstreamCall = mockRelayOk.mock.calls[0] as unknown as unknown[];
    const headersSent = (upstreamCall[1] as { headers?: Record<string, string> }).headers;
    const authSent = String((headersSent as Record<string, string> | undefined)?.Authorization || '');
    expect(authSent).toContain('Bearer sk-secret');

    const status = await call('image-gen/task-e2e');
    const statusBody = await status.json();
    expect(statusBody.data.status).toBe('completed');
    expect(statusBody.data.result.byteSize).toBe(PNG_BYTES.byteLength);

    const download = await call('image-gen/task-e2e/result');
    expect(download.status).toBe(200);
    expect(download.headers.get('Content-Type')).toBe('image/png');
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(PNG_BYTES);
    expect(download.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('重复提交同 taskId：幂等命中，不重新触发上游（计费保护）', async () => {
    const store = makeMemStore();
    __setImageGenStoreOverrideForTests(store);
    const envelope = await makeEnvelope(upstreamTemplate());
    await submit('task-idem', envelope);
    await runImageGenCronPass({ env: { DB: {} as unknown, AMSG_MASTER_KEY: MASTER_KEY }, store, fetchImpl: mockRelayOk as unknown as typeof fetch });

    const again = await submit('task-idem', envelope);
    expect(again.status).toBe(200);
    const body = await again.json();
    expect(body.data.created).toBe(false);
    expect(body.data.status).toBe('completed');
    expect(mockRelayOk).toHaveBeenCalledTimes(1);
  });

  it('上游明确 500 → failed 且带原因（不自动重试）', async () => {
    const store = makeMemStore();
    __setImageGenStoreOverrideForTests(store);
    const relay500 = vi.fn(async () => new Response('boom', { status: 500 }));
    await submit('task-fail', await makeEnvelope(upstreamTemplate()));
    await runImageGenCronPass({ env: { DB: {} as unknown, AMSG_MASTER_KEY: MASTER_KEY }, store, fetchImpl: relay500 as unknown as typeof fetch });
    const task = store.tasks.get('task-fail');
    expect(task?.status).toBe('failed');
    expect(task?.error).toContain('HTTP 500');
  });

  it('断网/超时 → unknown（上游结果不明，绝不自动重发）', async () => {
    const store = makeMemStore();
    __setImageGenStoreOverrideForTests(store);
    const relayDown = vi.fn(async () => { throw new TypeError('network down'); });
    await submit('task-unknown', await makeEnvelope(upstreamTemplate()));
    await runImageGenCronPass({ env: { DB: {} as unknown, AMSG_MASTER_KEY: MASTER_KEY }, store, fetchImpl: relayDown as unknown as typeof fetch });
    const task = store.tasks.get('task-unknown');
    expect(task?.status).toBe('unknown');
    expect(task?.error).toContain('不自动重发');
  });
});

describe('S2·安全隔离（全链路：S1 门 + owner_pin + 行级归属）', () => {
  it('无口令/错口令：image-gen 全家 403/401', async () => {
    const store = makeMemStore();
    __setImageGenStoreOverrideForTests(store);
    const envelope = await makeEnvelope(upstreamTemplate());
    const noToken = await fetchWorker(new Request(`${BASE}/image-gen`, { method: 'POST', body: JSON.stringify({ taskId: 'x', envelope }) }), makeEnv({ AMSG_SERVER_TOKEN: undefined }), { waitUntil: () => {} });
    expect(noToken.status).toBe(403);
    const wrongToken = await call('image-gen', { method: 'POST', body: JSON.stringify({ taskId: 'x', envelope }), headers: { 'X-Client-Token': 'wrong' } });
    expect(wrongToken.status).toBe(401);
  });

  it('伪造 userId 查不到/下不了别人的任务：OWNER_MISMATCH / TASK_FORBIDDEN（即使口令正确）', async () => {
    const store = makeMemStore();
    __setImageGenStoreOverrideForTests(store);
    await submit('task-alice', await makeEnvelope(upstreamTemplate()));

    // mallory 持正确口令（部署内共享）+ 伪造 X-User-Id：owner_pin 挡在门前
    const pinState = { pin: USER };
    const envMallory = makeEnv({ DB: makePinD1(pinState) });
    const forgedStatus = await call('image-gen/task-alice', { headers: { 'X-User-Id': 'mallory' } }, envMallory);
    expect(forgedStatus.status).toBe(403);
    expect((await forgedStatus.json()).error.code).toBe('OWNER_MISMATCH');

    // 即便 pin 被换绑（合法换设备），行级归属仍然拦住：旧 userId 的任务不给新 userId
    pinState.pin = 'mallory';
    const rowLevel = await call('image-gen/task-alice', { headers: { 'X-User-Id': 'mallory' } }, envMallory);
    expect(rowLevel.status).toBe(403);
    expect((await rowLevel.json()).error.code).toBe('TASK_FORBIDDEN');
    const rowLevelDownload = await call('image-gen/task-alice/result', { headers: { 'X-User-Id': 'mallory' } }, envMallory);
    expect(rowLevelDownload.status).toBe(403);
  });

  it('两个独立 Worker（不同口令/不同库）：相同 taskId 互不可见', async () => {
    const storeA = makeMemStore();
    const storeB = makeMemStore();
    __setImageGenStoreOverrideForTests(storeA);
    const envA = makeEnv({ AMSG_SERVER_TOKEN: 'token-A' });
    const envB = makeEnv({ AMSG_SERVER_TOKEN: 'token-B' });
    const submitA = await call('image-gen', {
      method: 'POST',
      headers: { 'X-Client-Token': 'token-A', 'X-User-Id': 'owner-a' },
      body: JSON.stringify({ taskId: 'same-id', envelope: await makeEnvelope(upstreamTemplate(), 'owner-a') }),
    }, envA);
    expect(submitA.status).toBe(202);

    const cross = await call('image-gen/same-id', { headers: { 'X-Client-Token': 'token-A', 'X-User-Id': 'owner-a' } }, envB);
    expect(cross.status).toBe(401);
    __setImageGenStoreOverrideForTests(storeB);
    const notFound = await call('image-gen/same-id', { headers: { 'X-Client-Token': 'token-B', 'X-User-Id': 'owner-b' } }, envB);
    expect(notFound.status).toBe(404);
    expect(storeA.tasks.size).toBe(1);
    expect(storeB.tasks.size).toBe(0);
  });

  it('SSRF/凭据防线：http、内网地址、非 443 端口、重定向一律拒绝', async () => {
    const store = makeMemStore();
    __setImageGenStoreOverrideForTests(store);
    for (const badUrl of ['http://relay.example/v1/images', 'https://localhost/v1/images', 'https://192.168.1.5/v1/images', 'https://relay.example:8443/v1/images']) {
      const rejected = await submit(`task-url-${Math.random()}`, await makeEnvelope(upstreamTemplate(badUrl)));
      expect(rejected.status, badUrl).toBe(400);
      expect((await rejected.json()).error.code).toBe('UPSTREAM_REJECTED');
    }
    const redirectRelay = vi.fn(async () => new Response(null, { status: 302, headers: { Location: 'https://evil.example/steal' } }));
    await submit('task-redirect', await makeEnvelope(upstreamTemplate()));
    await runImageGenCronPass({ env: { DB: {} as unknown, AMSG_MASTER_KEY: MASTER_KEY }, store, fetchImpl: redirectRelay as unknown as typeof fetch });
    expect(store.tasks.get('task-redirect')?.status).toBe('failed');
    expect(store.tasks.get('task-redirect')?.error).toContain('重定向');
  });
});

describe('S2·状态、取消与清理', () => {
  it('cancel 仅 queued 可取消；running 之后 409', async () => {
    const store = makeMemStore();
    __setImageGenStoreOverrideForTests(store);
    await submit('task-cancel', await makeEnvelope(upstreamTemplate()));
    const cancelled = await call('image-gen/task-cancel/cancel', { method: 'POST' });
    expect(cancelled.status).toBe(200);
    expect(store.tasks.get('task-cancel')?.status).toBe('failed');

    await submit('task-running', await makeEnvelope(upstreamTemplate()));
    await store.claimTask('task-running', Date.now() + 60_000, Date.now());
    const late = await call('image-gen/task-running/cancel', { method: 'POST' });
    expect(late.status).toBe(409);
  });

  it('running 租约超时收敛为 unknown；过期任务与图片按 TTL 清理', async () => {
    const store = makeMemStore();
    __setImageGenStoreOverrideForTests(store);
    await submit('task-stale', await makeEnvelope(upstreamTemplate()));
    await store.claimTask('task-stale', Date.now() - 1000, Date.now() - 1000);
    await runImageGenCronPass({ env: { DB: {} as unknown, AMSG_MASTER_KEY: MASTER_KEY }, store, fetchImpl: mockRelayOk as unknown as typeof fetch });
    expect(store.tasks.get('task-stale')?.status).toBe('unknown');

    store.tasks.get('task-stale')!.created_at = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const pass = await runImageGenCronPass({ env: { DB: {} as unknown, AMSG_MASTER_KEY: MASTER_KEY }, store, fetchImpl: mockRelayOk as unknown as typeof fetch });
    expect(pass.expired).toBeGreaterThan(0);
    expect(store.tasks.has('task-stale')).toBe(false);
  });

  it('载荷（含参考图）超上限：明确 413 拒绝，不静默丢参考图', async () => {
    const store = makeMemStore();
    __setImageGenStoreOverrideForTests(store);
    const bigTemplate = { ...upstreamTemplate(), formFiles: [{ name: 'image', filename: 'ref.png', mimeType: 'image/png', base64: 'A'.repeat(950 * 1024) }] };
    const rejected = await submit('task-big', await makeEnvelope(bigTemplate));
    expect(rejected.status).toBe(413);
    const body = await rejected.json();
    expect(body.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(body.error.message).toContain('静默丢弃');
  });
});




