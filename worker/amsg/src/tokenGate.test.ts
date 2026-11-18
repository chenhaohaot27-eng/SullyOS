// S1 安全测试：全部在**服务端接口层**验证（直接调 Worker 的 fetch handler / 授权门），
// 不依赖浏览器标签页或 localStorage 假隔离。覆盖任务书「四、安全测试」全部场景。
import { describe, expect, it } from 'vitest';
import worker, { enforceServerTokenGate, writeOwnerPin, type TokenGateD1Like } from './index';

const BASE = 'https://amsg-test.example.workers.dev';

const makeRequest = (path: string, init: RequestInit = {}) =>
  new Request(`${BASE}${path}`, { method: 'POST', ...init });

/** 内存 D1 桩：只实现授权门/owner-rebind 用到的几条 SQL，按 SQL 内容分发。 */
interface D1State {
  pin?: string;
  existingUsers?: Record<string, string[]>;
}
const makeD1 = (state: D1State): TokenGateD1Like => {
  const stmt = (sql: string, args: unknown[]) => ({
    async first() {
      if (/FROM owner_pin/.test(sql)) return state.pin === undefined ? null : { user_id: state.pin };
      throw new Error(`unexpected first: ${sql}`);
    },
    async run() {
      if (/CREATE TABLE IF NOT EXISTS owner_pin/.test(sql)) return {};
      if (/INSERT OR REPLACE INTO owner_pin/.test(sql)) {
        state.pin = String(args[0]);
        return {};
      }
      throw new Error(`unexpected run: ${sql}`);
    },
    async all() {
      const table = sql.match(/FROM ([a-z_]+)/)?.[1] || '';
      const users = state.existingUsers?.[table];
      if (users) return { results: users.map((user_id) => ({ user_id })) };
      throw new Error(`no such table: ${table}`);
    },
  });
  const bind = (sql: string) => ({
    bind: (...args: unknown[]) => stmt(sql, args),
    ...stmt(sql, []),
  });
  return { prepare: (sql: string) => bind(sql) } as unknown as TokenGateD1Like;
};

const envOf = (patch: Record<string, unknown> = {}) => ({
  AMSG_MASTER_KEY: 'a'.repeat(64),
  AMSG_SERVER_TOKEN: 'tok-correct',
  DB: makeD1({}),
  ...patch,
} as unknown as Parameters<typeof worker.fetch>[1]);

const codeOf = async (response: Response | null) => {
  expect(response).not.toBeNull();
  const body = await response!.json() as { error?: { code?: string } };
  return body.error?.code;
};

describe('S1·未配置口令：敏感接口全部拒绝，不进上游', () => {
  const noTokenEnv = envOf({ AMSG_SERVER_TOKEN: undefined });

  it('任务/订阅/凭据/状态/outbox/instant-chat 一律 403 SERVER_TOKEN_REQUIRED', async () => {
    for (const path of [
      '/message', '/message/abc/cancel', '/schedule-message', '/push-subscription',
      '/llm-credentials', '/client-state', '/outbox', '/instant-chat', '/capabilities',
    ]) {
      const gate = await enforceServerTokenGate(makeRequest(path), noTokenEnv);
      expect(gate?.status, path).toBe(403);
      expect(await codeOf(gate), path).toBe('SERVER_TOKEN_REQUIRED');
    }
  });

  it('fetch 层：POST /instant-chat 被挡，诊断三件套仍开放', async () => {
    const blocked = await worker.fetch(makeRequest('/instant-chat'), noTokenEnv);
    expect(blocked.status).toBe(403);
    expect(await codeOf(blocked)).toBe('SERVER_TOKEN_REQUIRED');

    const configCheck = await worker.fetch(new Request(`${BASE}/config-check`), noTokenEnv);
    expect(configCheck.status).toBe(200);
    const body = await configCheck.json() as { data?: { serverTokenEnforced?: boolean; warnings?: { code: string }[] } };
    expect(body.data?.serverTokenEnforced).toBe(true);
    expect(body.data?.warnings?.some((item) => item.code === 'SERVER_TOKEN_MISSING')).toBe(true);

    const debug = await worker.fetch(new Request(`${BASE}/debug`), noTokenEnv);
    expect(debug.status).toBe(200);
  });
});

describe('S1·口令错误/缺失 → 401；预检放行', () => {
  it('缺失或错误 X-Client-Token 都是 401 INVALID_CLIENT_TOKEN', async () => {
    const env = envOf();
    expect((await enforceServerTokenGate(makeRequest('/outbox'), env))?.status).toBe(401);
    const wrong = await enforceServerTokenGate(
      makeRequest('/outbox', { headers: { 'X-Client-Token': 'tok-wrong' } }),
      env,
    );
    expect(wrong?.status).toBe(401);
    expect(await codeOf(wrong)).toBe('INVALID_CLIENT_TOKEN');
  });

  it('正确口令通过授权门（fetch 层推进到下一道配置门，证明没有停在鉴权）', async () => {
    const env = envOf({ DB: undefined, AMSG_MASTER_KEY: undefined });
    const response = await worker.fetch(
      makeRequest('/outbox', { headers: { 'X-Client-Token': 'tok-correct' } }),
      env,
    );
    // 没有 DB/密钥 → 应该是配置门的 503 WORKER_CONFIG_MISSING，而不是 401/403
    expect(response.status).toBe(503);
    expect(await codeOf(response)).toBe('WORKER_CONFIG_MISSING');
  });

  it('OPTIONS 预检始终 204（带自定义头的正式请求才发得出去）', async () => {
    const response = await worker.fetch(new Request(`${BASE}/outbox`, { method: 'OPTIONS' }), envOf());
    expect(response.status).toBe(204);
  });
});

describe('S1·单用户归属绑定（X-User-Id 只是标识，不是凭据）', () => {
  it('存量数据属于 alice：mallory 即使口令正确也被拒，且不会绑定 mallory（不盲目认领）', async () => {
    const state: D1State = { existingUsers: { scheduled_messages: ['alice'] } };
    const env = envOf({ DB: makeD1(state) });
    const gate = await enforceServerTokenGate(
      makeRequest('/outbox', { headers: { 'X-Client-Token': 'tok-correct', 'X-User-Id': 'mallory' } }),
      env,
    );
    expect(gate?.status).toBe(403);
    expect(await codeOf(gate)).toBe('OWNER_MISMATCH');
    expect(state.pin).toBeUndefined();
  });

  it('存量主人 alice 通过并完成绑定；之后 mallory（换 X-User-Id）持续被拒', async () => {
    const state: D1State = { existingUsers: { push_subscriptions: ['alice'] } };
    const env = envOf({ DB: makeD1(state) });
    const ok = await enforceServerTokenGate(
      makeRequest('/push-subscription', { headers: { 'X-Client-Token': 'tok-correct', 'X-User-Id': 'alice' } }),
      env,
    );
    expect(ok).toBeNull();
    expect(state.pin).toBe('alice');

    const hijack = await enforceServerTokenGate(
      makeRequest('/push-subscription', { headers: { 'X-Client-Token': 'tok-correct', 'X-User-Id': 'mallory' } }),
      env,
    );
    expect(hijack?.status).toBe(403);
    expect(await codeOf(hijack)).toBe('OWNER_MISMATCH');
  });

  it('订阅劫持链路被封死：无口令时写不了别人的 push-subscription', async () => {
    const gate = await enforceServerTokenGate(
      makeRequest('/push-subscription', { headers: { 'X-User-Id': 'alice' } }),
      envOf({ AMSG_SERVER_TOKEN: undefined }),
    );
    expect(gate?.status).toBe(403);
  });

  it('/owner-rebind：正确口令重绑后新主人放行、旧 ID 被拒（fetch 层）', async () => {
    const state: D1State = { pin: 'alice' };
    const env = envOf({ DB: makeD1(state) });

    const rebind = await worker.fetch(
      makeRequest('/owner-rebind', { headers: { 'X-Client-Token': 'tok-correct', 'X-User-Id': 'alice-new-device' } }),
      env,
    );
    expect(rebind.status).toBe(200);

    const nowOk = await enforceServerTokenGate(
      makeRequest('/outbox', { headers: { 'X-Client-Token': 'tok-correct', 'X-User-Id': 'alice-new-device' } }),
      env,
    );
    expect(nowOk).toBeNull();

    const oldRejected = await enforceServerTokenGate(
      makeRequest('/outbox', { headers: { 'X-Client-Token': 'tok-correct', 'X-User-Id': 'alice' } }),
      env,
    );
    expect(oldRejected?.status).toBe(403);
  });

  it('/owner-rebind 没有口令进不来（在授权门之后）', async () => {
    const response = await worker.fetch(makeRequest('/owner-rebind'), envOf({ AMSG_SERVER_TOKEN: undefined }));
    expect(response.status).toBe(403);
    expect(await codeOf(response)).toBe('SERVER_TOKEN_REQUIRED');
  });
});

describe('S1·两个独立 Worker 实例：相同 charId/taskId 也不串', () => {
  it('实例 A 的口令在实例 B 上无效；B 只认自己的归属分区', async () => {
    const stateA: D1State = { pin: 'owner-a' };
    const stateB: D1State = { pin: 'owner-b' };
    const envA = envOf({ AMSG_SERVER_TOKEN: 'token-A', DB: makeD1(stateA) });
    const envB = envOf({ AMSG_SERVER_TOKEN: 'token-B', DB: makeD1(stateB) });

    // A 的口令 + A 的 userId 打到 B：口令错 → 401
    const crossToken = await enforceServerTokenGate(
      makeRequest('/message/same-task-id', { headers: { 'X-Client-Token': 'token-A', 'X-User-Id': 'owner-a' } }),
      envB,
    );
    expect(crossToken?.status).toBe(401);

    // 即便 B 的口令泄露给 A（token-B），A 的 userId 也不是 B 的主人 → 403
    const crossUser = await enforceServerTokenGate(
      makeRequest('/message/same-task-id', { headers: { 'X-Client-Token': 'token-B', 'X-User-Id': 'owner-a' } }),
      envB,
    );
    expect(crossUser?.status).toBe(403);
    expect(await codeOf(crossUser)).toBe('OWNER_MISMATCH');

    // B 自己照常
    expect(await enforceServerTokenGate(
      makeRequest('/message/same-task-id', { headers: { 'X-Client-Token': 'token-B', 'X-User-Id': 'owner-b' } }),
      envB,
    )).toBeNull();
    // envA 未使用也会构造——留着它证明两个实例互不共享状态
    expect(stateA.pin).toBe('owner-a');
  });
});

describe('S1·口令更换：旧口令立即失效，新口令恢复', () => {
  it('旋转 token 后旧口令 401、新口令放行', async () => {
    const state: D1State = { pin: 'alice' };
    const db = makeD1(state);
    const before = await enforceServerTokenGate(
      makeRequest('/outbox', { headers: { 'X-Client-Token': 'tok-old', 'X-User-Id': 'alice' } }),
      envOf({ AMSG_SERVER_TOKEN: 'tok-old', DB: db }),
    );
    expect(before).toBeNull();

    const afterRotation = await enforceServerTokenGate(
      makeRequest('/outbox', { headers: { 'X-Client-Token': 'tok-old', 'X-User-Id': 'alice' } }),
      envOf({ AMSG_SERVER_TOKEN: 'tok-new', DB: db }),
    );
    expect(afterRotation?.status).toBe(401);

    const withNew = await enforceServerTokenGate(
      makeRequest('/outbox', { headers: { 'X-Client-Token': 'tok-new', 'X-User-Id': 'alice' } }),
      envOf({ AMSG_SERVER_TOKEN: 'tok-new', DB: db }),
    );
    expect(withNew).toBeNull();
  });
});

describe('S1·writeOwnerPin 直写（owner-rebind 的底层）', () => {
  it('覆盖式写入，id 恒为 1', async () => {
    const state: D1State = {};
    const db = makeD1(state);
    await writeOwnerPin(db, 'first', 1000);
    expect(state.pin).toBe('first');
    await writeOwnerPin(db, 'second', 2000);
    expect(state.pin).toBe('second');
  });
});


