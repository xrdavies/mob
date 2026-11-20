import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import qrcode from "qrcode-generator";
import {
  Check, CheckCircle2, ChevronRight, CircleHelp, Copy, FolderOpen, Laptop, Monitor, Pencil, Play, RefreshCw, RotateCw, ScrollText, Smartphone, Square,
  Trash2, TriangleAlert, XCircle,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { fetchHealth, fetchQueue, fetchRelease, supports } from "@/api/client";
import type { Check as HealthCheck, Health } from "@/api/types";
import { AgentsTab, RestartBar } from "@/components/settings/AgentsSection";
import { useLocalStatus } from "@/components/local/LocalSetup";
import { Spinner } from "@/components/StatusIcon";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useHealth, useQueue } from "@/hooks/useMachine";
import { opText, useMaintenance } from "@/hooks/useMaintenance";
import { UnauthorizedError } from "@/lib/auth";
import { addressKind, addressLabel, currentAddress, hostOf, isLocal } from "@/lib/machines";
import { QUALITIES } from "@/lib/stream";
import { cn, newerVersion } from "@/lib/utils";
import { baseUrl, needsPairing, useApp, type ComputerTab, type Machine } from "@/store/app";
import { installLocal, localControl, localLatest, localLogs, localService, type LocalStatus } from "@/store/local";
import { log } from "@/store/log";
import { ConfirmButton, Dot, errorText, Group, Page, Row, Segmented } from "./ui";

/** Permissions the user asked for from Desktop this session: mobd restarts for them once idle. */
const askedGrants = new Set<string>();

/** Grants whose prompt macOS shows once; after that only System Settings turns them on. */
const PANE_GRANTS = new Set(["screenRecording", "accessibility"]);

interface Grant { name: string; label: string; state: string; required: boolean; detail?: string; settings?: string }
interface Client { id: string; name: string; createdAt: string; lastSeenAt?: string; revokedAt?: string }

const CHECK_LABELS: Record<string, string> = {
  codex: "Codex CLI",
  actuation: "Desktop actuation",
  accessibility: "Accessibility permission",
  screenRecording: "Screen Recording permission",
};
const order = (key: string) => {
  const i = Object.keys(CHECK_LABELS).indexOf(key);
  return i < 0 ? 99 : i;
};

export function ChecksList({ checks }: { checks?: Record<string, HealthCheck> }) {
  if (!checks) return null;
  return (
    <ul className="grid gap-1.5">
      {Object.entries(checks).sort(([a], [b]) => order(a) - order(b)).map(([key, c]) => (
        <li key={key} className="flex gap-2 text-xs">
          {c.unknown ? <CircleHelp className="size-4 shrink-0 text-muted-foreground" />
            : c.ok ? <CheckCircle2 className="size-4 shrink-0 text-success" />
              : <XCircle className="size-4 shrink-0 text-danger" />}
          <div className="min-w-0">
            <p className="font-medium">{CHECK_LABELS[key] ?? key}</p>
            {c.detail && <p className="break-words text-muted-foreground">{c.detail}</p>}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Removal could not reach mobd: this device is still in its list there. */
function warnKept(urls: string[]) {
  if (!urls.length) return;
  toast.warning(`Removed here, but ${urls.map(hostOf).join(", ")} still lists this device`, {
    description: "Remove it there with mobd clients delete, or from Mob on that computer.",
  });
}

function computerState(machine: Machine, health: Health | undefined, error: boolean): { tone: "ok" | "warn" | "bad" | "off"; text: string } {
  if (needsPairing(machine)) return { tone: "warn", text: "Needs pairing" };
  if (error) return { tone: "off", text: "Offline" };
  if (!health) return { tone: "off", text: "Checking…" };
  const failing = Object.values(health.checks ?? {}).filter((c) => !c.ok && !c.unknown).length;
  return failing ? { tone: "warn", text: `${failing} issue${failing > 1 ? "s" : ""}` } : { tone: "ok", text: "Online" };
}

/** The computer's name, renamed in place. */
function NameRow({ machine }: { machine: Machine }) {
  const saveMachine = useApp((s) => s.saveMachine);
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <Row label="Name" detail={editing === null ? machine.name : undefined}>
      {editing === null ? (
        <IconButton label="Rename" onClick={() => setEditing(machine.name)}><Pencil /></IconButton>
      ) : (
        <form className="flex gap-1.5" onSubmit={(e) => {
          e.preventDefault();
          if (editing.trim()) saveMachine({ id: machine.id, name: editing });
          setEditing(null);
        }}>
          <Input autoFocus value={editing} className="h-8 w-56" onChange={(e) => setEditing(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setEditing(null)} />
          <Button size="sm" type="submit" disabled={!editing.trim()}>Save</Button>
        </form>
      )}
    </Row>
  );
}

/** Where agents work: config.json's workdir (remote maintenance), or this computer's file before it. */
function FolderRow({ machine, m }: { machine: Machine; m: ReturnType<typeof useMaintenance> }) {
  const local = isLocal(machine);
  const { data: legacy, refetch } = useQuery({
    queryKey: ["local-workdir"], queryFn: () => invoke<string>("local_workdir", { set: null }), enabled: local && !m.supported,
  });
  const { data: health } = useHealth(machine);
  const [value, setValue] = useState<string | null>(null);
  const [error, setError] = useState("");
  const current = m.supported ? String(m.config?.effective.workdir ?? "") : legacy ?? health?.workdir ?? "";
  const editable = m.supported ? !!m.config?.editable.includes("workdir") && !m.config.overridden.includes("workdir") : local;
  const save = async () => {
    const dir = (value ?? "").trim();
    setError("");
    if (m.supported) {
      if (await m.save({ workdir: dir || null })) setValue(null);
      return;
    }
    invoke("local_workdir", { set: dir }).then(() => { setValue(null); void refetch(); toast("Restart mobd in Service to use the new folder"); }, (err) => setError(errorText(err)));
  };
  return (
    <Row label="Agents work in" detail={value === null ? <span className="font-mono">{current || "Not set"}</span> : error || undefined}>
      {value === null ? (
        <IconButton label="Choose folder" disabled={!editable} onClick={() => setValue(current)}><FolderOpen /></IconButton>
      ) : (
        <form className="flex gap-1.5" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <Input autoFocus value={value} spellCheck={false} className="h-8 w-64 font-mono text-xs" onChange={(e) => setValue(e.target.value)} />
          <Button size="sm" type="submit" disabled={!value.trim().startsWith("/") && !value.trim().startsWith("~")}>Save</Button>
          <Button size="sm" variant="ghost" onClick={() => setValue(null)}>Cancel</Button>
        </form>
      )}
    </Row>
  );
}

function GeneralTab({ machine, status, go }: { machine: Machine; status?: LocalStatus | null; go: (t: ComputerTab) => void }) {
  const { data: health, isError } = useHealth(machine);
  const m = useMaintenance(machine);
  const { deleteMachine, set } = useApp();
  const [removing, setRemoving] = useState(false);
  const state = computerState(machine, health, isError);
  const agents = health?.agents ?? [];
  const ready = agents.filter((a) => a.enabled && a.state === "ready").length;
  const local = isLocal(machine);
  const { data: clients } = useQuery({
    queryKey: ["local-clients"], queryFn: () => localControl<{ clients: Client[] }>("GET", "/clients"), enabled: local && !!status?.running,
  });
  const summary = (label: string, value: string, tab: ComputerTab) => (
    <Row label={label} detail={value}><IconButton label={`Open ${label}`} onClick={() => go(tab)}><ChevronRight /></IconButton></Row>
  );
  return (
    <div className="grid content-start gap-5">
      <Group>
        <NameRow machine={machine} />
        <Row label="Status"><span className="flex items-center gap-1.5 text-xs"><Dot tone={state.tone} />{state.text}</span></Row>
        {!needsPairing(machine) && <FolderRow machine={machine} m={m} />}
      </Group>
      <Group>
        {summary("Agents", agents.length ? `${ready} of ${agents.length} ready` : "–", "agents")}
        {local
          ? <>
            {summary("Service", status?.running ? `Running${status.health?.version ? ` · ${status.health.version}` : ""}` : status?.binary ? "Stopped" : "Not set up", "service")}
            {summary("Devices & access", clients ? `${clients.clients.filter((c) => !c.revokedAt).length} paired` : "–", "devices")}
          </>
          : summary("Connection", `${machine.addresses.length} address${machine.addresses.length > 1 ? "es" : ""} · ${addressLabel(machine, currentAddress(machine)!)}`, "connection")}
      </Group>
      {m.error && <p className="text-xs text-danger">{m.error}</p>}
      <RestartBar m={m} name={machine.name} />
      {/* This computer is always listed (docs/desktop-redesign D8): its Service tab stops or uninstalls mobd. */}
      {!local && (
        <Group>
          <Row label={`Remove ${machine.name}`} detail="Also removes this app's pairing there">
            <Button size="sm" variant="secondary" className="text-danger hover:text-danger" onClick={() => setRemoving(true)}>Remove…</Button>
          </Row>
        </Group>
      )}
      <Dialog open={removing} onOpenChange={setRemoving}>
        <DialogContent className="w-[400px] p-5" showClose={false}>
          <DialogTitle>Remove {machine.name}?</DialogTitle>
          <DialogDescription className="mt-1.5">Its conversations stay on {machine.name}. To add it again, paste a new mobd link.</DialogDescription>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setRemoving(false)}>Cancel</Button>
            <Button variant="danger" onClick={() => {
              setRemoving(false);
              void deleteMachine(machine.id).then(warnKept);
              set({ editMachineId: null, settingsTab: "general" });
            }}>Remove</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function QrCode({ text }: { text: string }) {
  const cells = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const dark: string[] = [];
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.isDark(y, x)) dark.push(`M${x + 2} ${y + 2}h1v1h-1z`);
    return { n: n + 4, path: dark.join("") };
  }, [text]);
  return (
    <svg viewBox={`0 0 ${cells.n} ${cells.n}`} className="size-40 shrink-0 rounded-md bg-white" shapeRendering="crispEdges" role="img" aria-label="Pairing QR code">
      <path d={cells.path} fill="#000" />
    </svg>
  );
}

/** `mobd link`'s one-use link as a QR code for a phone, or to paste in Mob on another computer. */
function PairDevice({ onPaired }: { onPaired: () => void }) {
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!link) return;
    const t = setInterval(onPaired, 3000);
    return () => clearInterval(t);
  }, [link, onPaired]);
  if (!link) {
    return (
      <Row label="Pair a phone or computer" detail={error || undefined}>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => {
          setBusy(true);
          setError("");
          invoke<{ url: string; expiresAt: string }>("local_link").then(setLink, (err) => setError(errorText(err))).finally(() => setBusy(false));
        }}>
          {busy ? <Spinner /> : <Smartphone className="size-3.5" />} Show code
        </Button>
      </Row>
    );
  }
  return (
    <div className="flex gap-4 p-3">
      <QrCode text={link.url} />
      <div className="grid min-w-0 content-start gap-2 text-xs">
        <p className="text-[13px] font-medium">Scan with Mob on your phone</p>
        <p className="text-muted-foreground">Or paste the link in Mob on another computer. One use{link.expiresAt && `, until ${new Date(link.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}.</p>
        <div className="flex items-center gap-1">
          <code className="min-w-0 flex-1 truncate rounded border bg-panel px-2 py-1 font-mono text-[11px]">{link.url}</code>
          <IconButton label={copied ? "Copied" : "Copy link"} onClick={() => { void navigator.clipboard.writeText(link.url); setCopied(true); setTimeout(() => setCopied(false), 1200); }}>
            {copied ? <Check /> : <Copy />}
          </IconButton>
        </div>
        {link.url.startsWith("http://") && <p className="flex items-center gap-1 text-warning"><TriangleAlert className="size-3.5" /> Not encrypted: use it on a trusted network</p>}
        <Button size="sm" variant="ghost" className="w-fit" onClick={() => { setLink(null); void localControl("DELETE", "/invitations").catch(() => undefined); }}>Done</Button>
      </div>
    </div>
  );
}

function DevicesTab({ machine }: { machine: Machine }) {
  const own = currentAddress(machine)?.clientId;
  const qc = useQueryClient();
  const { data, error } = useQuery({ queryKey: ["local-clients"], queryFn: () => localControl<{ clients: Client[] }>("GET", "/clients") });
  const refresh = useMemo(() => () => void qc.invalidateQueries({ queryKey: ["local-clients"] }), [qc]);
  const clients = (data?.clients ?? []).filter((c) => !c.revokedAt);
  const perms = useQuery({ queryKey: ["local-permissions"], queryFn: () => localControl<{ permissions: Grant[] }>("GET", "/permissions"), refetchInterval: 5000 });
  const [restarting, setRestarting] = useState(false);
  const ask = async (g: Grant) => {
    askedGrants.add(g.name);
    let asked = true;
    try {
      await localControl("POST", `/permissions/${encodeURIComponent(g.name)}`);
    } catch {
      asked = false;
    }
    // macOS shows the Screen Recording and Accessibility prompts only the first time and then
    // answers silently, so their pane opens too; elsewhere only when there was no prompt.
    if (g.settings && (!asked || PANE_GRANTS.has(g.name))) {
      await invoke("local_open_settings", { url: g.settings }).catch((err) => log(`opening System Settings failed: ${errorText(err)}`, "error"));
    }
    void perms.refetch();
  };
  // A grant this mobd only sees after a restart (Screen Recording: macOS tells a process once).
  const restart = (label?: string) => {
    setRestarting(true);
    localService("restart").then(
      () => label && toast.success(`mobd restarted to use ${label}`),
      (err) => log(`restarting mobd failed: ${errorText(err)}`, "error"),
    ).finally(() => {
      setRestarting(false);
      void perms.refetch();
      void qc.invalidateQueries({ queryKey: ["local-status"] });
      void qc.invalidateQueries({ queryKey: ["health", baseUrl(machine)] });
    });
  };
  // Allowed from here: mobd restarts by itself once nothing runs, and says so.
  const pending = (perms.data?.permissions ?? []).find((g) => g.state === "restart" && askedGrants.has(g.name));
  const { data: queue } = useQuery({
    queryKey: ["queue", baseUrl(machine)], queryFn: () => fetchQueue(baseUrl(machine)), enabled: !!pending, refetchInterval: 3000,
  });
  const tasks = (queue?.running.length ?? 0) + (queue?.queued.length ?? 0);
  useEffect(() => {
    if (!pending || !queue || tasks > 0 || restarting) return;
    askedGrants.delete(pending.name);
    restart(pending.label);
  }, [pending?.name, queue, tasks, restarting]); // eslint-disable-line react-hooks/exhaustive-deps
  const restartDetail = (g: Grant) => restarting ? "Restarting mobd…"
    : askedGrants.has(g.name) && tasks > 0 ? `Allowed · mobd restarts to use it when ${tasks} task${tasks > 1 ? "s" : ""} finish${tasks > 1 ? "" : "es"}`
      : "Allowed · applies after mobd restarts";
  return (
    <div className="grid content-start gap-5">
      <Group title="Paired devices">
        {error && <Row label="Could not read the list" detail={errorText(error)} />}
        {clients.map((c) => (
          <Row key={c.id} label={c.name} detail={c.id === own ? "This app" : c.lastSeenAt ? `Last seen ${new Date(c.lastSeenAt).toLocaleDateString()}` : "Never connected"}>
            {c.id !== own && (
              <ConfirmButton variant="ghost" danger label="Remove" confirm="Remove access" onConfirm={() => {
                localControl("POST", `/clients/${encodeURIComponent(c.id)}/revoke`).then(refresh, (err) => log(`revoke failed: ${errorText(err)}`, "error"));
              }} />
            )}
          </Row>
        ))}
        <PairDevice onPaired={refresh} />
      </Group>
      {!!perms.data?.permissions.length && (
        <Group title="macOS permissions">
          {perms.data.permissions.map((g) => (
            <Row key={g.name} label={<span className="flex items-center gap-2"><Dot tone={g.state === "granted" ? "ok" : g.state === "restart" ? "warn" : "bad"} />{g.label}</span>}
              detail={g.state === "missing" ? g.detail : g.state === "restart" ? restartDetail(g) : undefined}>
              {g.state === "missing" && <Button size="sm" variant="secondary" onClick={() => void ask(g)}>Allow…</Button>}
              {g.state === "restart" && (
                <ConfirmButton label={<>{restarting && <Spinner />} Restart now</>} disabled={restarting}
                  confirm={tasks > 0 ? `Stops ${tasks} task${tasks > 1 ? "s" : ""} — restart?` : undefined}
                  onConfirm={() => { askedGrants.delete(g.name); restart(g.label); }} />
              )}
            </Row>
          ))}
        </Group>
      )}
    </div>
  );
}

function ServiceTab({ machine, status }: { machine: Machine; status: LocalStatus }) {
  const qc = useQueryClient();
  const base = baseUrl(machine);
  const m = useMaintenance(machine);
  const { data: queue } = useQueue(base, status.running);
  const running = queue?.running.length ?? 0;
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [logs, setLogs] = useState<string | null>(null);
  const [uninstalling, setUninstalling] = useState(false);
  const health = status.health ?? undefined;
  const login = !!health?.loginStartup;
  const affects = running ? `Stops ${running} running task${running > 1 ? "s" : ""}` : undefined;
  // Updates come from mobd itself (mobd upgrade) when it can; before that, Desktop's own installer
  // for the official install location only.
  const release = useQuery({ queryKey: ["release", base], queryFn: () => fetchRelease(base), enabled: false, retry: false });
  const [legacyLatest, setLegacyLatest] = useState<string | null>(null);
  const managed = !!status.binary && status.binary.endsWith("/.local/bin/mobd");

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError("");
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy("");
      void qc.invalidateQueries({ queryKey: ["local-status"] });
      void qc.invalidateQueries({ queryKey: ["health", base] });
    }
  };
  const check = () => {
    setError("");
    if (m.supported) void release.refetch();
    else void localLatest().then(setLegacyLatest, (err) => setError(errorText(err)));
  };
  const legacyUpgrade = () => act("Updating", async () => {
    await localService("stop");
    try {
      await installLocal(setBusy);
    } finally {
      await localService("start", login);
    }
    setLegacyLatest(null);
  });
  const latest = m.supported ? release.data : legacyLatest ? { latest: legacyLatest, newer: newerVersion(legacyLatest, health?.version), canUpgrade: managed, reason: managed ? "" : `Update it the way it was installed (${status.binary})` } : undefined;
  const upgrading = m.op?.action === "upgrade" ? m.op : null;

  return (
    <div className="grid content-start gap-5">
      <Group>
        <Row label={<span className="flex items-center gap-2"><Dot tone={status.running ? "ok" : status.binary ? "bad" : "off"} />mobd</span>}
          detail={status.running ? `Running${health?.version ? ` · ${health.version}` : ""}` : status.binary ? "Stopped" : "Not set up"}>
          {busy && <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><Spinner /> {busy}…</span>}
          {status.running ? (
            <>
              <IconButton label={affects ? `Restart (${affects.toLowerCase()})` : "Restart"} disabled={!!busy} onClick={() => {
                if (!affects || window.confirm(`${affects}. Restart mobd?`)) void act("Restarting", () => localService("restart"));
              }}><RotateCw /></IconButton>
              <IconButton label="Stop" disabled={!!busy} onClick={() => {
                if (window.confirm(`${affects ? `${affects}. ` : ""}Phones lose access until mobd starts again. Stop mobd?`)) void act("Stopping", () => localService("stop"));
              }}><Square /></IconButton>
            </>
          ) : (
            <IconButton label="Start" disabled={!!busy || !status.binary} onClick={() => void act("Starting", () => localService("start", login))}><Play /></IconButton>
          )}
        </Row>
        {health?.loginStartup !== undefined && (
          <Row label="Start at login" detail={running ? "Changing it restarts mobd" : undefined}>
            <Switch checked={login} disabled={!!busy || !status.running} aria-label="Start at login" onCheckedChange={(on) => void act(on ? "Turning on" : "Turning off", async () => {
              // mobd stop turns login startup off; restart --login turns it on. Both restart mobd.
              if (on) await localService("restart", true);
              else { await localService("stop"); await localService("start"); }
            })} />
          </Row>
        )}
      </Group>
      <Group title="Version">
        <Row label={`mobd ${health?.version ?? ""}`} detail={
          upgrading ? opText(upgrading)
            : !latest ? undefined
              : !latest.newer ? "Up to date"
                : !latest.canUpgrade ? `${latest.latest} available · ${latest.reason}`
                  : `${latest.latest} available${m.tasks ? ` · ${m.tasks} task${m.tasks > 1 ? "s" : ""} running` : ""}`
        }>
          {latest?.newer && latest.canUpgrade ? (
            <Button size="sm" disabled={!!busy || m.busy || (m.supported ? m.tasks > 0 : running > 0)}
              onClick={() => (m.supported ? void m.run("upgrade", latest.latest) : void legacyUpgrade())}>
              {m.busy && <Spinner className="border-accent-foreground border-t-transparent" />} Update
            </Button>
          ) : (
            <IconButton label="Check for updates" disabled={!status.running || release.isFetching} onClick={check}>
              {release.isFetching ? <Spinner /> : <RefreshCw />}
            </IconButton>
          )}
        </Row>
      </Group>
      <Group title="Network">
        <Row label="Local network address" detail={health?.listen ? <span className="font-mono">{health.listen}</span> : "–"} />
      </Group>
      <Group title="Logs">
        <Row label="mobd log">
          <IconButton label={logs === null ? "Show log" : "Hide log"} onClick={() => (logs === null ? void localLogs().then(setLogs, (err) => setError(errorText(err))) : setLogs(null))}>
            <ScrollText />
          </IconButton>
        </Row>
        {logs !== null && <pre className="max-h-64 overflow-auto bg-code p-2 font-mono text-[10.5px] leading-snug">{logs || "Empty"}</pre>}
      </Group>
      <details className="group/adv">
        <summary className="flex cursor-default list-none items-center gap-1 px-1 text-[12px] font-semibold text-muted-foreground hover:text-foreground">
          <ChevronRight className="size-3 transition-transform group-open/adv:rotate-90" /> Advanced
        </summary>
        <div className="mt-1.5 grid gap-5">
          <Group>
            <Row label="Program" detail={<span className="font-mono">{status.binary ?? "Not installed"}</span>} />
            <Row label="Settings and data" detail={<span className="font-mono">{status.home.replace(/\/$/, "")}/.mobd</span>} />
          </Group>
          {status.binary && (
            <Group>
              <Row label="Uninstall mobd" detail="Settings, pairings and conversations are kept">
                <Button size="sm" variant="secondary" className="text-danger hover:text-danger" disabled={!!busy} onClick={() => setUninstalling(true)}>Uninstall…</Button>
              </Row>
            </Group>
          )}
        </div>
      </details>
      {(error || m.error) && <p className="text-xs text-danger" role="alert">{error || m.error}</p>}
      <Dialog open={uninstalling} onOpenChange={setUninstalling}>
        <DialogContent className="w-[420px] p-5" showClose={false}>
          <DialogTitle>Uninstall mobd?</DialogTitle>
          <DialogDescription className="mt-1.5">
            {affects ? `${affects}. ` : ""}Agents stop working on this computer and phones lose access. Settings, pairings and conversations stay in ~/.mobd, so installing it again picks them up.
          </DialogDescription>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setUninstalling(false)}>Cancel</Button>
            <Button variant="danger" onClick={() => { setUninstalling(false); void act("Uninstalling", () => localService("uninstall")); }}>Uninstall</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ConnectionTab({ machine }: { machine: Machine }) {
  const { selectRoute, removeAddress, openAdd, setLiveQuality, activeMachineId, selectMachine, set } = useApp();
  const saveMachine = useApp((s) => s.saveMachine);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [test, setTest] = useState<{ state: "idle" | "testing" | "ok" | "error"; health?: Health; error?: string; at?: Date }>({ state: "idle" });
  const runTest = async () => {
    setTest({ state: "testing" });
    try {
      const health = await fetchHealth(baseUrl(machine));
      setTest({ state: health.ok ? "ok" : "error", health, at: new Date() });
    } catch (err) {
      setTest({ state: "error", at: new Date(), error: err instanceof UnauthorizedError ? err.message : `${errorText(err)}: check the network or VPN and that mobd is running` });
    }
  };
  const { data: health } = useHealth(machine);
  return (
    <div className="grid content-start gap-5">
      <Group title="Addresses" action={<Button size="sm" variant="ghost" onClick={() => openAdd(machine.id)}>{needsPairing(machine) ? "Pair again…" : "Add address…"}</Button>}>
        {machine.addresses.map((a) => {
          const inUse = currentAddress(machine)?.id === a.id;
          return (
            <Row key={a.id}
              label={renaming?.id === a.id ? (
                <form className="flex gap-1.5" onSubmit={(e) => {
                  e.preventDefault();
                  saveMachine({ id: machine.id, name: machine.name, labels: { [a.id]: renaming.value } });
                  setRenaming(null);
                }}>
                  <Input autoFocus className="h-7 w-40" value={renaming.value} placeholder={addressKind(a.url)} onChange={(e) => setRenaming({ id: a.id, value: e.target.value })}
                    onKeyDown={(e) => e.key === "Escape" && setRenaming(null)} onBlur={() => setRenaming(null)} />
                </form>
              ) : (
                <span className="flex items-center gap-2"><Dot tone={a.needsPairing ? "warn" : "ok"} />{addressLabel(machine, a)}{inUse && <span className="text-xs text-muted-foreground">In use</span>}</span>
              )}
              detail={<span className="flex items-center gap-1.5 font-mono">{a.url}{!a.needsPairing && a.url.startsWith("http:") && <span className="flex items-center gap-0.5 font-sans text-warning"><TriangleAlert className="size-3" /> not encrypted</span>}{a.needsPairing && <span className="font-sans text-warning">needs pairing</span>}</span>}>
              {!inUse && <Button size="sm" variant="ghost" onClick={() => selectRoute(machine.id, a.id)}>Use</Button>}
              <IconButton label="Rename address" onClick={() => setRenaming({ id: a.id, value: a.label ?? "" })}><Pencil /></IconButton>
              {machine.addresses.length > 1 && (
                <IconButton label="Remove address" className="text-danger hover:text-danger" onClick={() => void removeAddress(machine.id, a.id).then(warnKept)}><Trash2 /></IconButton>
              )}
            </Row>
          );
        })}
      </Group>
      <Group title="Test connection">
        <Row label={test.state === "ok" ? "Connected" : test.state === "error" ? "Failed" : "Last test"}
          detail={test.at ? `${test.at.toLocaleTimeString()}${test.health ? ` · mobd API v${test.health.apiVersion}` : ""}${test.error ? ` · ${test.error}` : ""}` : "Not tested yet"}>
          <Button size="sm" variant="secondary" disabled={needsPairing(machine) || test.state === "testing"} onClick={() => void runTest()}>
            {test.state === "testing" && <Spinner />} Test
          </Button>
        </Row>
        {test.health?.checks && <div className="px-3 py-2.5"><ChecksList checks={test.health.checks} /></div>}
      </Group>
      <Group title="Screen">
        <Row label="Quality" detail={QUALITIES.find((q) => q.value === (machine.liveQuality ?? "auto"))?.hint}>
          <Segmented label="Screen quality" value={machine.liveQuality ?? "auto"} onChange={(q) => setLiveQuality(machine.id, q)}
            options={QUALITIES.map((q) => ({ value: q.value, label: q.label }))} />
        </Row>
      </Group>
      {supports(health, "fileTransfers") && (
        <Group title="Shared folder">
          <Row label="Files" detail={`Move files to and from ${machine.name}`}>
            <IconButton label="Open Files" onClick={() => {
              if (activeMachineId !== machine.id) selectMachine(machine.id);
              set({ settingsOpen: false, filesOpen: true });
            }}><FolderOpen /></IconButton>
          </Row>
        </Group>
      )}
    </div>
  );
}

/** One computer in Settings: This computer has General · Agents · Service · Devices & access; others General · Agents · Connection. */
export function ComputerPage({ machine }: { machine: Machine }) {
  const { computerTab, set } = useApp();
  const { data: health, isError } = useHealth(machine);
  const { data: status } = useLocalStatus();
  const local = isLocal(machine);
  const tabs: { value: ComputerTab; label: string }[] = local
    ? [{ value: "general", label: "General" }, { value: "agents", label: "Agents" }, ...(status?.supported ? [{ value: "service" as const, label: "Service" }, { value: "devices" as const, label: "Devices & access" }] : [])]
    : [{ value: "general", label: "General" }, { value: "agents", label: "Agents" }, { value: "connection", label: "Connection" }];
  const tab = tabs.some((t) => t.value === computerTab) ? computerTab : "general";
  const go = (t: ComputerTab) => set({ computerTab: t });
  const state = computerState(machine, health, isError);
  const Icon = local ? Laptop : Monitor;
  return (
    <Page title={
      <span className="flex items-center gap-2.5">
        <span className="grid size-9 place-items-center rounded-lg border bg-panel"><Icon className="size-4.5" /></span>
        <span className="grid">
          <span>{machine.name}</span>
          <span className="flex items-center gap-1.5 text-xs font-normal text-muted-foreground"><Dot tone={state.tone} />{local ? "This computer · " : ""}{state.text}</span>
        </span>
      </span>
    }>
      <div role="tablist" aria-label={`${machine.name} settings`} className="-mt-1 flex gap-1 border-b">
        {tabs.map((t) => (
          <button key={t.value} type="button" role="tab" aria-selected={tab === t.value} onClick={() => go(t.value)}
            className={cn("-mb-px border-b-2 px-2.5 pb-2 pt-1 text-[13px] outline-none focus-visible:text-foreground",
              tab === t.value ? "border-accent font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === "general" && <GeneralTab machine={machine} status={status} go={go} />}
      {tab === "agents" && <AgentsTab key={machine.id} machine={machine} />}
      {tab === "service" && status && <ServiceTab machine={machine} status={status} />}
      {tab === "devices" && <DevicesTab machine={machine} />}
      {tab === "connection" && <ConnectionTab machine={machine} />}
    </Page>
  );
}
