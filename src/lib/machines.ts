// Office computers and the addresses they are reached over; pure so node tests can run them.

/**
 * One way to reach a machine's mobd (its LAN name, a Tailscale or Cloudflare address), paired on
 * its own: each address has its own device token, so a token never goes to an address it was not
 * paired on.
 */
export interface MachineAddress {
  id: string;
  /** Origin from the pairing link. */
  url: string;
  clientId?: string;
  /** No usable credential for this address: never paired, or mobd answered 401. */
  needsPairing?: boolean;
  /** A name the user gave it; unset shows the kind ("LAN" or "Remote"). */
  label?: string;
}

export interface Machine {
  id: string;
  name: string;
  /** The first keeps the machine's ID, so its token account is the one from before addresses. */
  addresses: MachineAddress[];
  /** The address in use, chosen by the user; the first when unset or gone. */
  route?: string;
  serverId?: string;
  /** Live view quality; unset means auto. */
  liveQuality?: "auto" | "high" | "low";
  /** The live view last needed mobd's WebSocket here (no UDP path): try it at once next time. */
  liveWebSocket?: boolean;
  /**
   * This computer: the mobd Desktop runs on and manages (mobd docs/mob-desktop-local-mobd.md). No
   * live view, control or USB for it; the user is sitting at it.
   */
  local?: boolean;
}

export type AddressKind = "LAN" | "Remote";

export const tokenAccount = (addressId: string) => `${addressId}.token`;

/** LAN for .local names and private or link-local addresses; Remote for anything else. */
export function addressKind(url: string): AddressKind {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return "Remote";
  }
  if (host.endsWith(".local")) return "LAN";
  const ip = host.split(".");
  if (ip.length === 4 && ip.every((p) => /^\d+$/.test(p))) {
    const [a, b] = ip.map(Number);
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) ? "LAN" : "Remote";
  }
  if (host.includes(":") && /^(fe80|fc|fd)/.test(host)) return "LAN";
  return "Remote";
}

export function currentAddress(m: Machine | null | undefined): MachineAddress | undefined {
  if (!m) return undefined;
  return m.addresses.find((a) => a.id === m.route) ?? m.addresses[0];
}

/** The address in use needs pairing (the others may still work). */
export function needsPairing(m: Machine | null | undefined): boolean {
  const a = currentAddress(m);
  return !a || !!a.needsPairing;
}

export function baseUrl(m: Machine | null | undefined): string {
  return (currentAddress(m)?.url ?? "").trim().replace(/\/$/, "");
}

/** "LAN", "Remote", or the user's label; a second address of the same kind is numbered. */
export function addressLabel(m: Machine, a: MachineAddress): string {
  if (a.label?.trim()) return a.label.trim();
  const kind = addressKind(a.url);
  const same = m.addresses.filter((x) => addressKind(x.url) === kind && !x.label?.trim());
  const n = same.findIndex((x) => x.id === a.id);
  return same.length > 1 && n > 0 ? `${kind} ${n + 1}` : kind;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

const sameOrigin = (a: string, b: string) => {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
};

/** Whether `origin` is one of the machine's saved addresses. */
export const hasAddress = (m: Machine, origin: string) => m.addresses.some((a) => sameOrigin(a.url, origin));

/**
 * The machine after pairing `origin`: that address paired again when it is saved, else added next
 * to the others; a machine from before pairing, or of another office, keeps only the new one. The
 * paired address is the one in use. Returns it and the token accounts of the addresses that went.
 */
export function pairMachine(m: Machine, origin: string, serverId: string, clientId: string, newId: () => string):
  { machine: Machine; address: MachineAddress; dropped: string[] } {
  let addresses = m.addresses;
  let dropped: string[] = [];
  if (m.serverId !== serverId) {
    dropped = addresses.map((a) => tokenAccount(a.id));
    addresses = [];
  }
  const existing = addresses.find((a) => sameOrigin(a.url, origin));
  const address: MachineAddress = { ...(existing ?? { id: addresses.length ? newId() : m.id }), url: origin, clientId, needsPairing: false };
  addresses = existing ? addresses.map((a) => (a.id === existing.id ? address : a)) : [...addresses, address];
  return { machine: { ...m, addresses, route: address.id, serverId }, address, dropped: dropped.filter((d) => d !== tokenAccount(address.id)) };
}

/** A saved machine from before addresses: its mobdUrl, clientId and needsPairing become one address. */
export function withAddresses(m: Record<string, unknown> & { id: string }): Machine {
  if (Array.isArray(m.addresses) && m.addresses.length) return m as unknown as Machine;
  const { mobdUrl, clientId, needsPairing: np, addresses: _, ...rest } = m;
  const address: MachineAddress = { id: m.id, url: typeof mobdUrl === "string" ? mobdUrl : "" };
  if (typeof clientId === "string") address.clientId = clientId;
  if (np !== false) address.needsPairing = true;
  return { ...rest, name: typeof rest.name === "string" ? rest.name : "", addresses: [address] } as Machine;
}

export const isLocal = (m: Machine | null | undefined) => !!m?.local;

/** Marks `id` as this computer (the only one) and lists it first. */
export function markLocal(machines: Machine[], id: string): Machine[] {
  const target = machines.find((m) => m.id === id);
  if (!target) return machines;
  const rest = machines.filter((m) => m.id !== id).map((m) => {
    if (!m.local) return m;
    const { local: _, ...plain } = m;
    return plain;
  });
  return [{ ...target, local: true }, ...rest];
}
