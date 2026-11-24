import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AMSG_RELEASE, identifyAmsgRelease, loadAmsgRelease } from './amsgRelease';

const compatible = { releaseChannel: 'lemuria-amsg', schemaProtocol: '3.2.0-lease-token' };

describe('Lemuria Worker release detection', () => {
  it.each([
    ['2026-11-24', 'current', true],
    ['2026-11-23.3', 'outdated', false],
    ['2026-11-23.2', 'outdated', false],
    ['2026-11-24.10', 'newer', true],
    ['2026-11-25', 'newer', true],
    ['2026-11-23', 'outdated', false],
    ['2026-11-23.1', 'outdated', false],
    ['2026-11-19', 'outdated', false],
    ['2.6.0-next.22', 'outdated', false],
    [undefined, 'missing', false],
    [' ', 'missing', false],
    ['unrecognized', 'unknown', false],
    ['2026-02-30', 'unknown', false],
  ])('%s is %s', (workerVersion, state, canSelfUpdate) => {
    expect(identifyAmsgRelease({ ...compatible, workerVersion })).toMatchObject({ state, canSelfUpdate });
  });

  it('requires the release channel and D1 protocol before offering self-update', () => {
    expect(identifyAmsgRelease(null)).toMatchObject({ state: 'unknown', canSelfUpdate: false });
    expect(identifyAmsgRelease({ workerVersion: AMSG_RELEASE.version })).toMatchObject({ state: 'incompatible', canSelfUpdate: false });
    expect(identifyAmsgRelease({ ...compatible, workerVersion: AMSG_RELEASE.version, schemaProtocol: '2.6.0' }))
      .toMatchObject({ state: 'incompatible', canSelfUpdate: false });
  });
});

describe('Lemuria pinned Worker download', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('fetches the versioned local asset and returns its original bytes', async () => {
    const bytes = readFileSync(new URL(`../public/${AMSG_RELEASE.fileName}`, import.meta.url));
    const fetch = vi.fn(async () => new Response(new Uint8Array(bytes)));
    vi.stubGlobal('fetch', fetch);
    const result = await loadAmsgRelease();
    expect(Buffer.compare(Buffer.from(result), bytes)).toBe(0);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/amsg-worker-2026-11-24\.bundle\.js$/),
      { cache: 'no-store', redirect: 'error' },
    );
  });

  it('rejects a replaced artifact and makes no fallback request', async () => {
    const fetch = vi.fn(async () => new Response('replaced'));
    vi.stubGlobal('fetch', fetch);
    await expect(loadAmsgRelease()).rejects.toThrow('SHA-256');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
