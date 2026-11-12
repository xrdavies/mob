// mobd client protocol v1: `mobd link` prints <origin>/pair#v=1&serverId=…&invite=…

export interface PairLink {
  origin: string;
  invite: string;
  serverId: string;
  /** Plain HTTP: the invite and the credential travel unencrypted. */
  insecure: boolean;
}

export interface Pairing {
  serverId: string;
  clientId: string;
  token: string;
  /** The computer's own name (mobd 0.5.2+), for naming a new machine. */
  computerName?: string;
}

export function parsePairLink(text: string): PairLink {
  const raw = text.trim();
  if (!raw) throw new Error("Paste the pairing link printed by mobd link.");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("This is not a valid link. Copy the full link printed by mobd link.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Pairing links start with http:// or https://.");
  if (url.username || url.password) throw new Error("Pairing links cannot contain a user name or password.");
  if (url.pathname !== "/pair") throw new Error("This is not a mobd pairing link: the address must end in /pair.");
  if (url.search || raw.split("#")[0].includes("?")) throw new Error("Pairing links have no query string. Copy the link exactly as printed.");
  const params = new URLSearchParams(url.hash.slice(1));
  for (const key of ["v", "invite", "serverId"]) {
    if (params.getAll(key).length > 1) throw new Error("The pairing link is malformed. Run mobd link again.");
  }
  const v = params.get("v");
  if (v && v !== "1") throw new Error("This pairing link needs a newer Mob. Update the app.");
  const invite = params.get("invite") ?? "";
  const serverId = params.get("serverId") ?? "";
  if (v !== "1" || !invite || !serverId) throw new Error("The pairing link is incomplete. Copy the whole link, including the part after #.");
  return { origin: url.origin, invite, serverId, insecure: url.protocol === "http:" };
}

/** The device name mobd shows in its client list: 1–128 bytes, no control characters. */
export function deviceNameError(name: string): string {
  const n = name.trim();
  if (!n) return "Enter a name for this device.";
  if (new TextEncoder().encode(n).length > 128) return "The device name is too long.";
  if (/[\u0000-\u001f\u007f-\u009f]/.test(n)) return "The device name contains invalid characters.";
  return "";
}

/** Redeems the invite. The request carries no existing credential and never follows redirects. */
export async function pair(link: PairLink, name: string): Promise<Pairing> {
  const nameError = deviceNameError(name);
  if (nameError) throw new Error(nameError);
  let res: Response;
  try {
    res = await fetch(`${link.origin}/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invite: link.invite, name: name.trim() }),
      redirect: "error",
      cache: "no-store",
    });
  } catch (err) {
    throw new Error(`Could not reach ${link.origin}. Check the network or VPN and that the office computer is awake. (${err instanceof Error ? err.message : String(err)})`);
  }
  const data = (await res.json().catch(() => ({}))) as Partial<Pairing> & { error?: string; code?: string; computerName?: unknown };
  // mobd answers 404 pairing_closed while no invitation is open (used, expired or closed).
  if (res.status === 401 || data.code === "pairing_closed") throw new Error("This pairing link is invalid, expired or already used. Run mobd link on the office computer again.");
  if (res.status === 400) throw new Error(`mobd rejected the pairing request: ${data.error || "invalid request"}.`);
  if (res.status === 503) throw new Error("The office computer could not save the pairing. Ask its administrator to check mobd's storage, then try again.");
  if (res.status === 404 || res.status === 405) throw new Error("This mobd does not support pairing. Update mobd on the office computer.");
  if (!res.ok) throw new Error(`Pairing failed: ${data.error || `HTTP ${res.status}`}`);
  if (typeof data.token !== "string" || !data.token || typeof data.clientId !== "string" || typeof data.serverId !== "string") {
    throw new Error("Invalid pairing response from mobd.");
  }
  if (data.serverId !== link.serverId) {
    throw new Error("The office computer answered with a different server ID than the link. Check the address and run mobd link again.");
  }
  const computerName = typeof data.computerName === "string" ? data.computerName.trim().slice(0, 128) : "";
  return { serverId: data.serverId, clientId: data.clientId, token: data.token, ...(computerName ? { computerName } : {}) };
}

export type UnpairResult = "removed" | "unsupported" | "failed";

/**
 * Removes this device's pairing at `origin` with its own credential (mobd's DELETE /pair), so it
 * leaves the machine's device list. "unsupported": a mobd without the unpair feature.
 */
export async function unpair(origin: string, token: string, timeoutMs = 5000): Promise<UnpairResult> {
  try {
    const res = await fetch(`${origin.replace(/\/$/, "")}/pair`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    // 401: the credential no longer works there, so nothing is left to remove.
    if (res.ok || res.status === 401 || res.status === 404) return "removed";
    return res.status === 405 ? "unsupported" : "failed";
  } catch {
    return "failed";
  }
}

/** A name for a machine before mobd tells its own: the address's IP, else its first name label. */
export function nameFromOrigin(origin: string): string {
  let host: string;
  try {
    host = new URL(origin).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return "Office computer";
  }
  if (/^[\d.]+$/.test(host) || host.includes(":")) return host;
  return host.split(".")[0] || "Office computer";
}
