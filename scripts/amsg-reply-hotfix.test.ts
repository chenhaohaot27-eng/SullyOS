import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHotfix, HOTFIX, sha256 } from './build-amsg-reply-hotfix.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = mkdtempSync(resolve(tmpdir(), 'lemuria-amsg-hotfix-'));
let result: Awaited<ReturnType<typeof buildHotfix>>;
beforeAll(async () => { result = await buildHotfix({ root }); });
afterAll(() => rmSync(temp, { recursive: true, force: true }));

describe('pinned AMSG artifact derivative', () => {
  it('reproduces both checked-in outputs from the reviewed source hashes', () => {
    expect(result.bundle.equals(readFileSync(resolve(root, 'public', HOTFIX.fileName)))).toBe(true);
    expect(result.manifest).toEqual(JSON.parse(readFileSync(resolve(root, HOTFIX.provenancePath), 'utf8')));
    expect(result.manifest.release.sha256).toBe(sha256(result.bundle));
    expect(result.manifest.base.fullSourceAvailable).toBe(false);
  });

  it('changes only three modules, version and capability; all other bytes reconstruct exactly', () => {
    expect(result.manifest.replacements.map((part: { name: string }) => part.name)).toEqual([
      'utils/replyBoundary.ts', 'utils/openAiStream.ts', 'utils/characterTransport.ts',
      'bundle-version', 'reply-boundary-capability',
    ]);
    const restored: Buffer[] = [];
    let cursor = 0;
    for (const part of result.manifest.replacements) {
      restored.push(result.bundle.subarray(cursor, part.resultStart));
      restored.push(result.base.subarray(part.baseStart, part.baseStart + part.baseBytes));
      cursor = part.resultStart + part.resultBytes;
    }
    restored.push(result.bundle.subarray(cursor));
    expect(Buffer.concat(restored).equals(result.base)).toBe(true);
    expect(sha256(Buffer.concat(restored))).toBe(HOTFIX.baseSha256);
    for (const part of result.manifest.unchangedRegions) {
      expect(sha256(result.bundle.subarray(part.resultStart, part.resultStart + part.bytes))).toBe(part.sha256);
    }
    const code = result.bundle.toString('utf8');
    expect(code).toContain('var SERVER_VERSION = true ? "3.2.0-next.2" : "0.0.0-dev";');
    expect(code).toContain('var SCHEMA_VERSION = "3.2.0-lease-token";');
    expect(code).toContain('          imageAuth: "owner-token",');
    expect(code.match(/lemuriaReplyVerified: true,/g)).toHaveLength(2);
  });

  it('refuses a modified base before producing any replacement', async () => {
    const changed = Buffer.from(result.base);
    changed[changed.length - 3] ^= 1;
    const basePath = resolve(temp, 'modified-base.js');
    writeFileSync(basePath, changed);
    await expect(buildHotfix({ root, basePath })).rejects.toThrow('Base Worker SHA-256 mismatch');
  });

  it('refuses unreviewed source changes even with the correct artifact', async () => {
    const isolated = resolve(temp, 'changed-source');
    mkdirSync(resolve(isolated, 'utils'), { recursive: true });
    writeFileSync(resolve(isolated, 'utils/replyBoundary.ts'), readFileSync(resolve(root, 'utils/replyBoundary.ts'), 'utf8') + '\n// unreviewed\n');
    await expect(buildHotfix({ root: isolated, basePath: resolve(root, 'public', HOTFIX.baseFileName) }))
      .rejects.toThrow('Reviewed source changed: utils/replyBoundary.ts');
  });

  it('runs the complete Worker offline: real fetch wrapper, contract gate and config-check', () => {
    // The exact delivered bytes execute in a VM. The only import is a runtime
    // DurableObject stub. Global fetch is a fixture that cannot use the network.
    // No private helper exports or production-code rewrites are added for tests.
    const output = execFileSync(process.execPath, ['--no-warnings', '--experimental-vm-modules', '--input-type=module', '-'], {
      input: ARTIFACT_FIXTURES,
      env: { ...process.env, LEMURIA_FIXTURE_BUNDLE: resolve(root, 'public', HOTFIX.fileName) },
      encoding: 'utf8', timeout: 20_000,
    });
    const report = JSON.parse(output.trim());
    expect(report.networkCalls).toBe(0);
    expect(report.cases).toEqual([
      'config-check', 'plain-json', 'valid-frame', 'strict-invalid-frames', 'typed-thought',
      'tool-only', 'provider-error', 'done-without-eof', 'tee-cancel-without-eof',
      'finish-grace-and-usage', 'partial-usage-at-grace', 'truncated-or-error-sse',
      'mislabelled-json', 'unmarked-task', 'hook-verification',
    ]);
  }, 25_000);
});

const ARTIFACT_FIXTURES = String.raw`
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

let upstream = async () => { throw new Error('NETWORK_DISABLED'); };
let networkCalls = 0;
const context = vm.createContext({
  crypto: webcrypto, Response, Request, Headers, URL, URLSearchParams, TextEncoder, TextDecoder,
  ReadableStream, TransformStream, Blob, atob, btoa, structuredClone,
  setTimeout, clearTimeout, setInterval, clearInterval,
  console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
  fetch: (...args) => upstream(...args),
});
const module = new vm.SourceTextModule(fs.readFileSync(process.env.LEMURIA_FIXTURE_BUNDLE, 'utf8'), { context });
await module.link(async specifier => {
  assert.equal(specifier, 'cloudflare:workers');
  return new vm.SyntheticModule(['DurableObject'], function () {
    this.setExport('DurableObject', class { constructor(ctx, env) { this.ctx = ctx; this.env = env; } });
  }, { context });
});
await module.evaluate();
const cases = [];
const run = async (name, body) => { await body(); cases.push(name); };
const publicText = '她把伞递过来。“走吧，今天一起回去。”';
const rawCompletion = (content, extra = {}) => ({ choices: [{ message: { role: 'assistant', content, ...extra }, finish_reason: 'stop' }] });
const call = async (provider, marked = true) => {
  let count = 0;
  upstream = async (url, init) => {
    assert.equal(url, 'https://fixture.invalid/v1/chat/completions');
    count++;
    return provider(JSON.parse(init.body), init);
  };
  const body = { model: 'offline-fixture', stream: true, messages: [{ role: 'system', content: '角色设定', ...(marked ? { lemuriaCharacterReply: true } : {}) }, { role: 'user', content: '你好' }] };
  try {
    return await context.fetch('https://fixture.invalid/v1/chat/completions', { method: 'POST', body: JSON.stringify(body) });
  } finally { assert.equal(count, 1, 'one provider request, including failures'); }
};
const nonceOf = request => {
  assert.equal(request.messages[0].lemuriaCharacterReply, undefined);
  return request.messages[0].content.match(/<reply-([\da-f-]+)>/)[1];
};
const verified = async response => {
  const data = await response.json();
  assert.equal(data.lemuriaReplyVerified, true);
  assert.equal(data.choices[0].message.content, publicText);
  return data;
};
const deadline = async (promise, ms = 2500) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('fixture deadline')), ms); })]); }
  finally { clearTimeout(timer); }
};
const event = data => 'data: ' + JSON.stringify(data) + '\n\n';
const delta = text => event({ choices: [{ delta: { content: text } }] });
const finish = event({ choices: [{ delta: {}, finish_reason: 'stop' }] });
const done = 'data: [DONE]\n\n';
const streamResponse = (wire, { close = false, cancellationNeverResolves = false, afterStart } = {}) => {
  let controller;
  const response = new Response(new ReadableStream({
    start(c) {
      controller = c;
      const bytes = new TextEncoder().encode(wire);
      for (let i = 0; i < bytes.length; i += 3) c.enqueue(bytes.slice(i, i + 3));
      if (afterStart) afterStart(c);
      if (close) c.close();
    },
    cancel() { if (cancellationNeverResolves) return new Promise(() => {}); },
  }), { headers: { 'content-type': 'text/event-stream' } });
  return { response, controller };
};

await run('config-check', async () => {
  upstream = async () => { networkCalls++; throw new Error('NETWORK_DISABLED'); };
  const response = await module.namespace.default.fetch(new Request('https://fixture.invalid/config-check'), { AMSG_IMAGE_OWNER_ID: 'fixture-owner', INSTANT_TICK: {} }, {});
  const data = (await response.json()).data;
  assert.equal(response.status, 200);
  assert.equal(data.workerVersion, '2026-11-28');
  assert.equal(data.replyBoundaryVersion, 2);
  assert.equal(data.schemaProtocol, '3.2.0-lease-token');
  assert.equal(data.releaseChannel, 'lemuria-amsg');
  assert.equal(data.imageAuth, 'owner-token');
  assert.equal(data.instantTick, true);
});
await run('plain-json', async () => {
  const data = await verified(await call(request => {
    nonceOf(request);
    return Response.json(rawCompletion(publicText, { reasoning_content: 'private scratchpad' }));
  }));
  assert.equal(JSON.stringify(data).includes('private scratchpad'), false);
});
await run('valid-frame', async () => {
  await verified(await call(request => {
    const nonce = nonceOf(request);
    return Response.json(rawCompletion('outside draft <reply-' + nonce + '>' + publicText + '</reply-' + nonce + '>'));
  }));
});
await run('strict-invalid-frames', async () => {
  const invalid = [
    () => '<reply-wrong>' + publicText + '</reply-wrong>',
    nonce => '<reply-' + nonce + '>' + publicText,
    nonce => ('<reply-' + nonce + '>' + publicText + '</reply-' + nonce + '>').repeat(2),
    () => '<think>unfinished private text',
    () => '内部分析\nprivate scratchpad\n回复草案\nhello',
  ];
  for (const text of invalid) await assert.rejects(call(request => Response.json(rawCompletion(text(nonceOf(request))))), error => error.code === 'LLM_REPLY_BOUNDARY');
});
await run('typed-thought', async () => {
  const data = await verified(await call(() => Response.json(rawCompletion([
    { type: 'text', thought: true, text: 'private typed block' },
    { type: 'thinking', text: 'private thinking block' }, { type: 'text', text: publicText },
  ]))));
  assert.equal(JSON.stringify(data).includes('private'), false);
});
await run('tool-only', async () => {
  const response = await call(() => Response.json({ choices: [{ message: { content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }));
  const data = await response.json();
  assert.equal(data.lemuriaReplyVerified, true);
  assert.equal(data.choices[0].message.content, '');
  assert.equal(data.choices[0].message.tool_calls[0].function.name, 'lookup');
});
await run('provider-error', async () => {
  const response = await call(() => Response.json({ error: { message: 'fixture rejected' } }, { status: 400 }));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).lemuriaReplyVerified, undefined);
});
await run('done-without-eof', async () => {
  const { response } = streamResponse(delta(publicText) + finish + done, { cancellationNeverResolves: true });
  await verified(await deadline(call(() => response), 700));
});
await run('tee-cancel-without-eof', async () => {
  const { response, controller } = streamResponse(delta(publicText) + finish + done);
  const clone = response.clone().text();
  try { await verified(await deadline(call(() => response), 700)); }
  finally { controller.close(); await clone; }
});
await run('finish-grace-and-usage', async () => {
  let interval, usageTimer;
  let closed = false;
  const response = new Response(new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(delta(publicText) + finish));
      usageTimer = setTimeout(() => { if (!closed) c.enqueue(new TextEncoder().encode(event({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } }))); }, 20);
      interval = setInterval(() => { if (!closed) c.enqueue(new TextEncoder().encode(': heartbeat\n\n')); }, 50);
    },
    cancel() { closed = true; clearInterval(interval); clearTimeout(usageTimer); return new Promise(() => {}); },
  }), { headers: { 'content-type': 'text/event-stream' } });
  const started = Date.now();
  try {
    const data = await verified(await deadline(call(() => response)));
    assert.equal(data.usage.prompt_tokens, 7);
    assert.ok(Date.now() - started < 2000, 'heartbeats must not extend the finish deadline');
  } finally { clearInterval(interval); clearTimeout(usageTimer); }
});
await run('partial-usage-at-grace', async () => {
  let timer;
  const { response } = streamResponse(delta(publicText) + finish, { cancellationNeverResolves: true, afterStart(c) {
    timer = setTimeout(() => c.enqueue(new TextEncoder().encode('data: {"usage":')), 50);
  } });
  try { await verified(await deadline(call(() => response))); }
  finally { clearTimeout(timer); }
});
await run('truncated-or-error-sse', async () => {
  for (const wire of [delta(publicText), delta(publicText) + event({ error: { message: 'fixture error' } }) + done]) {
    const { response } = streamResponse(wire, { close: true });
    await assert.rejects(call(() => response), error => error.code === 'LLM_REPLY_BOUNDARY');
  }
});
await run('mislabelled-json', async () => {
  await verified(await call(() => new Response(JSON.stringify(rawCompletion(publicText)), { headers: { 'content-type': 'text/event-stream' } })));
});
await run('unmarked-task', async () => {
  const response = await call(request => {
    assert.equal(request.messages[0].content, '角色设定');
    return Response.json(rawCompletion(publicText));
  }, false);
  assert.equal((await response.json()).lemuriaReplyVerified, undefined);
});
await run('hook-verification', async () => {
  let forwarded = 0;
  const old = module.namespace.amsgHooks.onLLMOutput;
  module.namespace.amsgHooks.onLLMOutput = () => { forwarded++; return { decision: 'skip-push' }; };
  try {
    const hooks = module.namespace.buildWorkerConfig({}).hooks;
    assert.throws(() => hooks.onLLMOutput({ scratch: {}, llmResponse: {} }), error => error.code === 'LLM_REPLY_BOUNDARY');
    assert.equal(forwarded, 0);
    assert.equal(hooks.onLLMOutput({ scratch: {}, llmResponse: { lemuriaReplyVerified: true } }).decision, 'skip-push');
    assert.equal(forwarded, 1);
  } finally { module.namespace.amsgHooks.onLLMOutput = old; }
});
console.log(JSON.stringify({ cases, networkCalls }));
`;
