import release from './amsgRelease.json';

export { release as AMSG_RELEASE };

export type AmsgReleaseState = 'current' | 'newer' | 'outdated' | 'missing' | 'unknown' | 'incompatible';

const DATE_VERSION = /^(\d{4}-\d{2}-\d{2})(?:\.([1-9]\d*))?$/;

function compareDateVersions(deployed: string): number | null {
  const version = DATE_VERSION.exec(deployed);
  if (!version) return null;
  const [, day, revision = '0'] = version;
  const timestamp = Date.parse(day);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== day) return null;
  const [, expectedDay, expectedRevision = '0'] = DATE_VERSION.exec(release.version)!;
  if (day !== expectedDay) return day < expectedDay ? -1 : 1;
  if (revision === expectedRevision) return 0;
  return BigInt(revision) < BigInt(expectedRevision) ? -1 : 1;
}

export function identifyAmsgRelease(data: Record<string, unknown> | null) {
  const rawVersion = data?.workerVersion;
  const deployed = typeof rawVersion === 'string' ? rawVersion.trim() || null : null;
  const compatible = data?.releaseChannel === release.channel && data?.schemaProtocol === release.schemaProtocol;
  const order = deployed ? compareDateVersions(deployed) : null;
  let state: AmsgReleaseState = 'unknown';
  if (data && (rawVersion == null || (typeof rawVersion === 'string' && !deployed))) {
    state = 'missing';
  } else if (order !== null) {
    if (order < 0) state = 'outdated';
    else if (!compatible) state = 'incompatible';
    else state = order === 0 ? 'current' : 'newer';
  } else if (deployed && /^2\.6\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(deployed)) {
    state = 'outdated';
  }
  return { state, deployed, expected: release.version, canSelfUpdate: state === 'current' || state === 'newer' };
}

export async function loadAmsgRelease(): Promise<ArrayBuffer> {
  const base = import.meta.env.BASE_URL || '/';
  const response = await fetch(`${base}${release.fileName}`, { cache: 'no-store', redirect: 'error' });
  if (!response.ok) throw new Error(`下载 Lemuria Worker 失败（HTTP ${response.status}）。`);
  const bytes = await response.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const actual = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  if (actual !== release.sha256) throw new Error('Lemuria Worker 文件的 SHA-256 校验失败。');
  return bytes;
}
