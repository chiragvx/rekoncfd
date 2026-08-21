/**
 * GitHub repo hosting release builds -- the single source of truth for the
 * Download page's "latest release" info and download link. Until an actual
 * release is cut there, `fetchLatestRelease` fails (404) and callers should
 * show a "check back soon" state rather than crash -- mirrors
 * `rekon_app::updater`'s same repo constant on the Rust side, which fails
 * the exact same way for the exact same reason.
 */
export const GITHUB_REPO = { owner: "chiragvx", name: "rekoncfd" };

export interface LatestRelease {
  version: string;
  name: string;
  notes: string | null;
  publishedAt: string;
  htmlUrl: string;
}

/** The stable "always points at whatever's newest" asset URL GitHub
 * provides per release, so the Download button never needs to know the
 * actual latest version/tag ahead of time. */
export function downloadUrlFor(assetName: string): string {
  return `https://github.com/${GITHUB_REPO.owner}/${GITHUB_REPO.name}/releases/latest/download/${assetName}`;
}

export async function fetchLatestRelease(): Promise<LatestRelease> {
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO.owner}/${GITHUB_REPO.name}/releases/latest`);
  if (!res.ok) throw new Error(`no release found (${res.status})`);
  const data = await res.json();
  return {
    version: String(data.tag_name ?? "").replace(/^v/, ""),
    name: data.name || data.tag_name,
    notes: data.body ?? null,
    publishedAt: data.published_at,
    htmlUrl: data.html_url,
  };
}
