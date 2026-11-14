/**
 * Update check against the project's GitHub releases. One anonymous request at startup (and on demand),
 * no background polling, nothing about the user is sent. Installing stays the user's choice: ZERO opens the
 * release download, it never runs a downloaded installer by itself.
 */
export const REPO = 'lololyeye/zero-client';
export const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;
export const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;

export interface UpdateInfo {
  current: string;
  latest: string;
  newer: boolean;
  url: string;
  installerUrl: string | null;
  notes: string;
}

/** Compare dotted versions ("v0.10.1" > "0.9.9"); pre-release suffixes sort before the release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.trim().replace(/^v/i, '').split('-', 2) as [string, string | undefined];
    return { nums: core.split('.').map((n) => parseInt(n, 10) || 0), pre: pre ?? null };
  };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** Interpret a GitHub "latest release" response. Only https links on github.com are accepted. */
export function parseRelease(json: any, current: string): UpdateInfo | null {
  if (!json || typeof json.tag_name !== 'string' || json.draft || json.prerelease) return null;
  const gh = (u: unknown) => (typeof u === 'string' && /^https:\/\/github\.com\//.test(u) ? u : null);
  const asset = Array.isArray(json.assets) ? json.assets.find((a: any) => typeof a?.name === 'string' && /setup.*\.exe$|\.exe$/i.test(a.name)) : null;
  return {
    current, latest: json.tag_name.replace(/^v/i, ''),
    newer: compareVersions(json.tag_name, current) > 0,
    url: gh(json.html_url) ?? RELEASES_PAGE,
    installerUrl: gh(asset?.browser_download_url),
    notes: typeof json.body === 'string' ? json.body.slice(0, 1500) : '',
  };
}

export async function fetchLatest(fetcher: (url: string, init: RequestInit) => Promise<Response>, current: string): Promise<UpdateInfo | null> {
  const res = await fetcher(RELEASES_API, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'ZERO-client-update-check' } });
  if (res.status === 404) return null; // no release published yet
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  return parseRelease(await res.json(), current);
}
