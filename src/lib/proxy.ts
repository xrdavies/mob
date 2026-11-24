// A system proxy that does not leave Tailscale alone: the web view sends requests for a tailnet
// address to the proxy app (Clash, Surge…), which cannot reach it. Mob then says so and links to
// the FAQ instead of a bare "Load failed" (mymob.dev/faq/#proxy). Native side: src-tauri/src/proxy.rs.

export interface SystemProxy {
  enabled: boolean;
  bypass: string[];
}

export const PROXY_FAQ = "https://mymob.dev/faq/#proxy";

const ipv4 = (s: string): number | null => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.some((n) => n > 255) ? null : parts.reduce((a, n) => a * 256 + n, 0);
};

const TAILNET_START = ipv4("100.64.0.0")!;
const TAILNET_END = TAILNET_START + 2 ** 22 - 1;

const hostOf = (origin: string): string => {
  try {
    return new URL(origin).hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  } catch {
    return "";
  }
};

/** A Tailscale address: a MagicDNS name under ts.net or an IP in 100.64.0.0/10. */
export function isTailnetOrigin(origin: string): boolean {
  const host = hostOf(origin);
  if (host === "ts.net" || host.endsWith(".ts.net")) return true;
  const ip = ipv4(host);
  return ip !== null && ip >= TAILNET_START && ip <= TAILNET_END;
}

/** Whether one bypass entry (*.ts.net, .ts.net, 100.64.0.0/10, 100.*, an exact host) covers host. */
function covers(entry: string, host: string): boolean {
  const e = entry.trim().toLowerCase();
  if (!e) return false;
  if (e === host) return true;
  const cidr = /^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/.exec(e);
  const ip = ipv4(host);
  if (cidr) {
    const base = ipv4(cidr[1]!);
    const bits = Number(cidr[2]);
    if (base === null || ip === null || bits > 32) return false;
    const size = 2 ** (32 - bits);
    return Math.floor(ip / size) === Math.floor(base / size);
  }
  if (e.includes("*")) {
    const re = new RegExp(`^${e.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
    return re.test(host);
  }
  // ".ts.net" or "ts.net" as a domain suffix.
  const suffix = e.replace(/^\./, "");
  return ip === null && (host === suffix || host.endsWith(`.${suffix}`));
}

/** The proxy would take requests for origin, a tailnet address, instead of leaving them to Tailscale. */
export function proxyBlocksTailnet(proxy: SystemProxy | null | undefined, origin: string): boolean {
  if (!proxy?.enabled || !isTailnetOrigin(origin)) return false;
  const host = hostOf(origin);
  return !proxy.bypass.some((e) => covers(e, host));
}

export const PROXY_HINT = "A proxy app on this computer may be blocking Tailscale: add *.ts.net and 100.64.0.0/10 to its bypass list.";

/** This computer's proxy settings; null outside the desktop app or when they cannot be read. */
export async function systemProxy(): Promise<SystemProxy | null> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<SystemProxy>("system_proxy");
  } catch {
    return null;
  }
}
