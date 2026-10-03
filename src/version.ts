// Version strings like "v1.12.1" (a GitHub release tag) or "1.12.1", for the update check.

export function parseVersion(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** True when `latest` is a strictly higher version than `current`. Unparseable input is never "newer". */
export function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

export interface ReleaseInfo {
  tag_name?: string;
  html_url?: string;
  prerelease?: boolean;
  draft?: boolean;
}

/** The release to offer as an update, from GitHub's release list, or null. A full release is offered to
 * everyone. Before 1.0 the pre-releases (0.x) *are* the releases, so a 0.x install is also offered newer
 * 0.x pre-releases — but never an older-numbered scheme's leftover pre-release (the project's early
 * v1.x tags, from before it was renumbered to 0.x, still sit on GitHub and would otherwise look newer).
 * Drafts are never offered. The highest eligible version wins, whatever order the list came in. */
export function pickUpdate(releases: ReleaseInfo[], current: string): ReleaseInfo | null {
  const cur = parseVersion(current);
  if (!cur) return null;
  let best: ReleaseInfo | null = null;
  for (const r of releases) {
    const v = parseVersion(r.tag_name ?? '');
    if (r.draft || !v || !isNewer(r.tag_name!, current)) continue;
    const eligible = cur[0] === 0 ? v[0] === 0 || !r.prerelease : !r.prerelease;
    if (eligible && (!best || isNewer(r.tag_name!, best.tag_name!))) best = r;
  }
  return best;
}
