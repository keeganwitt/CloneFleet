export interface ParsedRemote {
  protocol: "ssh" | "https" | "http" | "git";
  user: string | null;
  host: string;
  port: string | null;
  path: string;
}

const SCP_LIKE = /^(?:([^@/\s]+)@)?([^:/\s]{2,}):(?!\/\/)(.+)$/;

export function parseRemoteUrl(url: string): ParsedRemote | null {
  const trimmed = url.trim();
  const scp = SCP_LIKE.exec(trimmed);
  if (scp && !trimmed.includes("://")) {
    return { protocol: "ssh", user: scp[1] ?? null, host: scp[2], port: null, path: scp[3] };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  const protocol = parsed.protocol.replace(/:$/, "");
  if (protocol !== "ssh" && protocol !== "https" && protocol !== "http" && protocol !== "git") {
    return null;
  }
  return {
    protocol,
    user: parsed.username || null,
    host: parsed.hostname,
    port: parsed.port || null,
    path: decodeURIComponent(parsed.pathname.replace(/^\/+/, "")),
  };
}

export function toSshUrl(remote: ParsedRemote): string {
  const user = remote.user && remote.protocol === "ssh" ? remote.user : "git";
  return remote.protocol === "ssh" && remote.port
    ? `ssh://${user}@${remote.host}:${remote.port}/${remote.path}`
    : `${user}@${remote.host}:${remote.path}`;
}

export function toHttpsUrl(remote: ParsedRemote): string {
  const port = remote.protocol === "https" && remote.port ? `:${remote.port}` : "";
  return `https://${remote.host}${port}/${remote.path}`;
}

export type UrlTransform = (url: string) => string | null;

export const httpsToSsh: UrlTransform = (url) => {
  const parsed = parseRemoteUrl(url);
  return parsed && (parsed.protocol === "https" || parsed.protocol === "http")
    ? toSshUrl(parsed)
    : null;
};

export const sshToHttps: UrlTransform = (url) => {
  const parsed = parseRemoteUrl(url);
  return parsed?.protocol === "ssh" ? toHttpsUrl(parsed) : null;
};

export function findAndReplace(find: string, replace: string): UrlTransform {
  return (url) => (find && url.includes(find) ? url.split(find).join(replace) : null);
}

export interface RemoteRow {
  repo: string;
  remote: string;
  url: string;
}

export interface UrlChange extends RemoteRow {
  newUrl: string;
}

export function planUrlChanges(rows: RemoteRow[], transform: UrlTransform): UrlChange[] {
  return rows.flatMap((row) => {
    const newUrl = transform(row.url);
    return newUrl && newUrl !== row.url ? [{ ...row, newUrl }] : [];
  });
}

export function webUrl(
  remoteUrl: string,
  hosts: { host: string; webUrl: string }[],
): string | null {
  const parsed = parseRemoteUrl(remoteUrl);
  if (!parsed) return null;
  const path = parsed.path.replace(/\.git$/, "").replace(/\/+$/, "");
  const mapping = hosts.find((h) => h.host.trim().toLowerCase() === parsed.host.toLowerCase());
  const base = mapping ? mapping.webUrl.trim().replace(/\/+$/, "") : `https://${parsed.host}`;
  return `${base}/${path}`;
}

export function parseWebHosts(text: string): { host: string; webUrl: string }[] {
  return text
    .split("\n")
    .map((line) => line.split("="))
    .filter((parts) => parts.length === 2 && parts[0].trim() && parts[1].trim())
    .map(([host, url]) => ({ host: host.trim(), webUrl: url.trim() }));
}

export function formatWebHosts(hosts: { host: string; webUrl: string }[]): string {
  return hosts.map((h) => `${h.host} = ${h.webUrl}`).join("\n");
}

export type RemoteProtocol = "ssh" | "https" | "other";

export function remoteProtocol(url: string): RemoteProtocol {
  const parsed = parseRemoteUrl(url);
  if (!parsed) return "other";
  if (parsed.protocol === "ssh") return "ssh";
  if (parsed.protocol === "https" || parsed.protocol === "http") return "https";
  return "other";
}
