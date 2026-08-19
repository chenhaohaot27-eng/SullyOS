import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (relativePath: string) => readFileSync(
  fileURLToPath(new URL(relativePath, import.meta.url)),
  'utf8',
);

describe('iOS Home Screen App Shell update wiring', () => {
  it('registration bypasses Safari SW HTTP cache and checks again when the app resumes', () => {
    const source = read('./keepAlive.ts');
    expect(source).toContain("updateViaCache: 'none'");
    expect(source).toContain('registration?.update()');
    expect(source).toContain("window.addEventListener('pageshow', requestUpdate)");
    expect(source).toContain("document.addEventListener('visibilitychange', requestUpdate)");
  });

  it('new worker refreshes old clients and only bypasses cache for HTML navigation', () => {
    const source = read('../worker/sw-keep-alive.ts');
    expect(source).toContain("const SW_VERSION = '1.17.0'");
    expect(source).toContain('sw.clients.claim()');
    expect(source).toContain('(client as WindowClient).navigate(client.url)');
    expect(source).toContain("sw.addEventListener('fetch'");
    expect(source).toContain("request.mode !== 'navigate'");
    expect(source).toContain("fetch(request, { cache: 'no-store' })");
  });

  it('the update path never clears persistent app data', () => {
    const registration = read('./keepAlive.ts');
    const worker = read('../worker/sw-keep-alive.ts');
    expect(registration).not.toContain('deleteDatabase(');
    expect(registration).not.toContain('caches.delete(');
    expect(worker).not.toContain('indexedDB.deleteDatabase(');
    expect(worker).not.toContain('caches.delete(');
  });
});
