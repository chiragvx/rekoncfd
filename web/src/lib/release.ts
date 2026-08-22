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

export const WINDOWS_ASSET = "rekon-app-x86_64-pc-windows-msvc.exe";
export const MAC_ASSET_ARM = "rekon-app-aarch64-apple-darwin";

/** Fetched via `curl` rather than a browser click so the file never picks up
 * macOS's quarantine flag -- without a paid Apple Developer ID to notarize
 * against, a browser-downloaded build would otherwise hit Gatekeeper's
 * "unidentified developer" block on first launch. curl/Terminal downloads
 * skip that flag entirely (it's only set by the browser's own download API),
 * so this is the one way to get a clean, warning-free first run without
 * paying for notarization. The build is still ad-hoc signed in CI -- Apple
 * Silicon refuses to run an entirely unsigned binary at all.
 *
 * Apple Silicon (arm64) only -- Intel Mac builds aren't published (the CI
 * runner pool for them queues indefinitely, and it isn't a priority), so
 * this checks the chip up front rather than silently handing an Intel user
 * a binary that won't run. */
export function macInstallCommand(): string {
  return [
    `[ "$(uname -m)" = "arm64" ] || { echo "Rekon only ships an Apple Silicon (arm64) build."; exit 1; }`,
    `curl -fsSL -o rekon-app "${downloadUrlFor(MAC_ASSET_ARM)}"`,
    `chmod +x rekon-app`,
    `xattr -d com.apple.quarantine rekon-app 2>/dev/null`,
    `./rekon-app`,
  ].join("\n");
}

/** Best-effort OS sniff for picking which download flow to lead with --
 * wrong guesses just show the other OS's option instead of the reader's,
 * never break anything. */
export function detectOS(): "mac" | "windows" | "other" {
  if (typeof navigator === "undefined") return "other";
  const platform = `${navigator.userAgent} ${navigator.platform ?? ""}`;
  if (/Mac|iPhone|iPad/i.test(platform)) return "mac";
  if (/Win/i.test(platform)) return "windows";
  return "other";
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
