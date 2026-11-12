export const REPOSITORY_URL = "https://github.com/keeganwitt/CloneFleet";
export const LATEST_RELEASE_API =
  "https://api.github.com/repos/keeganwitt/CloneFleet/releases/latest";

function parts(version: string): number[] {
  return version
    .trim()
    .replace(/^v/i, "")
    .split(/[.+-]/)
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10) || 0);
}

export function isNewer(candidate: string, current: string): boolean {
  const a = parts(candidate);
  const b = parts(current);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

export interface LatestRelease {
  version: string;
  url: string;
}

export async function fetchLatestRelease(fetcher: typeof fetch = fetch): Promise<LatestRelease> {
  const response = await fetcher(LATEST_RELEASE_API, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (response.status === 404) throw new Error("No releases have been published yet");
  if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
  const body = (await response.json()) as { tag_name?: string; html_url?: string };
  if (!body.tag_name || !body.html_url) throw new Error("Unexpected response from GitHub");
  return { version: body.tag_name.replace(/^v/i, ""), url: body.html_url };
}
