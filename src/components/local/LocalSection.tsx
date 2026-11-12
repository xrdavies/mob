import { useQuery, useQueryClient } from "@tanstack/react-query";
import qrcode from "qrcode-generator";
import { Copy, RefreshCw, ScrollText, Smartphone } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Spinner } from "@/components/StatusIcon";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useLocalStatus } from "@/components/local/LocalSetup";
import { useQueue } from "@/hooks/useMachine";
import { cn, newerVersion } from "@/lib/utils";
import { baseUrl, currentAddress, type Machine } from "@/lib/machines";
import { invoke } from "@tauri-apps/api/core";
import { installLocal, localControl, localLatest, localLogs, localService, type LocalStatus } from "@/store/local";
import { log } from "@/store/log";

interface Grant { name: string; label: string; state: string; required: boolean; detail?: string; settings?: string }
interface Client { id: string; name: string; createdAt: string; lastSeenAt?: string; revokedAt?: string }

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="grid gap-2">
      <div className="flex items-center justify-between">
        <h4 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</h4>
        {action}
      </div>
      {children}
    </section>
  );
}

/** A two-step button: the first press says what happens, the second does it. */
function ConfirmButton({ label, confirm, onConfirm, disabled, variant = "secondary" }: {
  label: string; confirm?: string; onConfirm: () => void; disabled?: boolean; variant?: "secondary" | "ghost";
}) {
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    if (!asking) return;
    const t = setTimeout(() => setAsking(false), 5000);
    return () => clearTimeout(t);
  }, [asking]);
  if (!confirm) return <Button size="sm" variant={variant} disabled={disabled} onClick={onConfirm}>{label}</Button>;
  return (
    <Button size="sm" variant={asking ? "secondary" : variant} disabled={disabled} className={cn(asking && "text-warning")}
      onClick={() => (asking ? (setAsking(false), onConfirm()) : setAsking(true))}>
      {asking ? confirm : label}
    </Button>
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
    <svg viewBox={`0 0 ${cells.n} ${cells.n}`} className="size-44 rounded-md bg-white" shapeRendering="crispEdges" role="img" aria-label="Pairing QR code">
      <path d={cells.path} fill="#000" />
    </svg>
  );
}

/** "Pair a device": `mobd link`'s one-use link as a QR code for the phone, or to paste in another Desktop. */
function PairDevice({ onPaired }: { onPaired: () => void }) {
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const create = async () => {
    setBusy(true);
    setError("");
    try {
      setLink(await invoke<{ url: string; expiresAt: string }>("local_link"));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  // Picks up the new device in the list while the code is shown.
  useEffect(() => {
    if (!link) return;
    const t = setInterval(onPaired, 3000);
    return () => clearInterval(t);
  }, [link, onPaired]);
  if (!link) {
    return (
      <div className="grid gap-1.5">
        <Button size="sm" variant="secondary" className="w-fit" disabled={busy} onClick={() => void create()}>
          {busy ? <Spinner /> : <Smartphone className="size-3.5" />} Pair a device
        </Button>
        {error && <p className="text-xs text-danger">{error}</p>}
      </div>
    );
  }
  const insecure = link.url.startsWith("http://");
  return (
    <div className="flex gap-4 rounded-lg border p-3">
      <QrCode text={link.url} />
      <div className="grid min-w-0 content-start gap-2 text-xs">
        <p>Scan with Mob on your phone, or paste the link in Mob on another computer.</p>
        <p className="break-all font-mono text-[11px] text-muted-foreground">{link.url}</p>
        <p className="text-muted-foreground">One use{link.expiresAt && `, until ${new Date(link.expiresAt).toLocaleTimeString()}`}.</p>
        {insecure && <p className="text-warning">Plain HTTP: use it only on a trusted network, or set up remote access (mobd remote setup).</p>}
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard.writeText(link.url)}><Copy className="size-3.5" /> Copy link</Button>
          <Button size="sm" variant="ghost" onClick={() => { setLink(null); void localControl("DELETE", "/invitations").catch(() => undefined); }}>Done</Button>
        </div>
      </div>
    </div>
  );
}

function Devices({ machine }: { machine: Machine }) {
  const own = currentAddress(machine)?.clientId;
  const qc = useQueryClient();
  const { data, error } = useQuery({
    queryKey: ["local-clients"],
    queryFn: () => localControl<{ clients: Client[] }>("GET", "/clients"),
  });
  const refresh = useMemo(() => () => void qc.invalidateQueries({ queryKey: ["local-clients"] }), [qc]);
  const clients = (data?.clients ?? []).filter((c) => !c.revokedAt);
  return (
    <Section title="Devices">
      {error && <p className="text-xs text-danger">{errorText(error)}</p>}
      <ul className="grid gap-1">
        {clients.map((c) => (
          <li key={c.id} className="flex items-center gap-2 text-xs">
            <span className="min-w-0 flex-1 truncate">{c.name}{c.id === own && <span className="text-muted-foreground"> · this app</span>}</span>
            <span className="text-muted-foreground">{c.lastSeenAt ? `seen ${new Date(c.lastSeenAt).toLocaleDateString()}` : "never connected"}</span>
            {c.id !== own && (
              <ConfirmButton variant="ghost" label="Remove" confirm="Remove access" onConfirm={() => {
                localControl("POST", `/clients/${encodeURIComponent(c.id)}/revoke`).then(refresh, (err) => log(`revoke failed: ${errorText(err)}`, "error"));
              }} />
            )}
          </li>
        ))}
      </ul>
      <PairDevice onPaired={refresh} />
    </Section>
  );
}

function Permissions() {
  const { data, refetch } = useQuery({
    queryKey: ["local-permissions"],
    queryFn: () => localControl<{ permissions: Grant[] }>("GET", "/permissions"),
    refetchInterval: 5000,
  });
  const grants = data?.permissions ?? [];
  if (!grants.length) return null;
  const ask = async (g: Grant) => {
    try {
      await localControl("POST", `/permissions/${encodeURIComponent(g.name)}`);
    } catch {
      // No prompt (asked before): the pane where it is turned on.
      if (g.settings) await invoke("local_open_settings", { url: g.settings });
    }
    void refetch();
  };
  return (
    <Section title="macOS permissions">
      <p className="text-[11.5px] text-muted-foreground">For agents' screen tools and for viewing and controlling this computer from your phone.</p>
      <ul className="grid gap-1">
        {grants.map((g) => (
          <li key={g.name} className="flex items-center gap-2 text-xs">
            <span className={cn("size-1.5 rounded-full", g.state === "granted" ? "bg-success" : g.state === "restart" ? "bg-warning" : "bg-danger")} />
            <span className="min-w-0 flex-1 truncate" title={g.detail}>{g.label}</span>
            {g.state === "missing" && <Button size="sm" variant="ghost" onClick={() => void ask(g)}>Allow…</Button>}
            {g.state === "restart" && <span className="text-warning">applies after a restart</span>}
          </li>
        ))}
      </ul>
    </Section>
  );
}

function Workdir({ onSaved }: { onSaved: () => void }) {
  const { data: saved, refetch } = useQuery({ queryKey: ["local-workdir"], queryFn: () => invoke<string>("local_workdir", { set: null }) });
  const [value, setValue] = useState<string | null>(null);
  const [error, setError] = useState("");
  const dir = value ?? saved ?? "";
  const changed = value !== null && value.trim() !== (saved ?? "");
  return (
    <div className="grid gap-1.5">
      <Label htmlFor="local-workdir-edit">Agents work in</Label>
      <div className="flex gap-2">
        <Input id="local-workdir-edit" value={dir} spellCheck={false} placeholder="Where mobd was started" onChange={(e) => setValue(e.target.value)} className="font-mono text-xs" />
        <Button size="sm" variant="secondary" disabled={!changed || !dir.trim().startsWith("/")} onClick={() => {
          setError("");
          invoke("local_workdir", { set: dir.trim() }).then(() => { setValue(null); void refetch(); onSaved(); }, (err) => setError(errorText(err)));
        }}>Save</Button>
      </div>
      <p className="text-[11px] text-muted-foreground">New conversations use it after mobd restarts; existing ones keep theirs.</p>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}

function Service({ machine, status }: { machine: Machine; status: LocalStatus }) {
  const qc = useQueryClient();
  const { data: queue } = useQueue(baseUrl(machine), true);
  const running = queue?.running.length ?? 0;
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [needsRestart, setNeedsRestart] = useState(false);
  const [logs, setLogs] = useState<string | null>(null);
  const [latest, setLatest] = useState<string | null>(null);
  const health = status.health ?? undefined;
  const login = !!health?.loginStartup;
  // Desktop upgrades only the official install location; mobd from a .deb or a build is updated the way it came.
  const managed = !!status.binary && status.binary.endsWith("/.local/bin/mobd");
  const affects = running ? `Stops ${running} running task${running > 1 ? "s" : ""}` : undefined;

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
      void qc.invalidateQueries({ queryKey: ["health", baseUrl(machine)] });
    }
  };
  const upgrade = () => act("Updating", async () => {
    await localService("stop");
    try {
      await installLocal(setBusy);
    } finally {
      // Back as it was, also when the install failed (the old binary is still in place).
      await localService("start", login);
    }
    setLatest(null);
  });

  return (
    <Section title="mobd" action={<Button variant="ghost" size="icon-sm" aria-label="Refresh" onClick={() => void qc.invalidateQueries({ queryKey: ["local-status"] })}><RefreshCw /></Button>}>
      <div className="grid gap-1 text-xs">
        <p>
          <span className={cn("mr-1.5 inline-block size-1.5 rounded-full", status.running ? "bg-success" : "bg-danger")} />
          {status.running ? "Running" : "Stopped"}{health?.version && ` · ${health.version}`}{health?.listen && ` · listening on ${health.listen}`}
        </p>
        {status.binary && <p className="truncate font-mono text-[11px] text-muted-foreground" title={status.binary}>{status.binary}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {status.running ? (
          <>
            <ConfirmButton label="Restart" confirm={affects ? `${affects} — restart?` : undefined} disabled={!!busy} onConfirm={() => void act("Restarting", () => localService("restart"))} />
            <ConfirmButton label="Stop" confirm={`${affects ?? "Phones lose access"} — stop?`} disabled={!!busy} onConfirm={() => void act("Stopping", () => localService("stop"))} />
          </>
        ) : (
          <Button size="sm" variant="secondary" disabled={!!busy || !status.binary} onClick={() => void act("Starting", () => localService("start", login))}>Start</Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => void localLogs().then(setLogs, (err) => setError(errorText(err)))}><ScrollText className="size-3.5" /> Logs</Button>
        {busy && <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><Spinner /> {busy}…</span>}
      </div>
      {health?.loginStartup !== undefined && (
        <label className="flex items-center gap-2 text-xs">
          <Switch checked={login} disabled={!!busy || !status.running} onCheckedChange={(on) => void act(on ? "Turning on" : "Turning off", async () => {
            // mobd stop turns login startup off; restart --login turns it on. Both restart mobd.
            if (on) await localService("restart", true);
            else { await localService("stop"); await localService("start"); }
          })} />
          Start at login, so phones reach this computer after a restart{running > 0 && <span className="text-warning"> (restarts mobd)</span>}
        </label>
      )}
      <Workdir onSaved={() => setNeedsRestart(true)} />
      {needsRestart && status.running && (
        <div className="flex items-center gap-2 text-xs text-warning">
          Restart mobd to use the new directory.
          <ConfirmButton label="Restart now" confirm={affects ? `${affects} — restart?` : undefined} disabled={!!busy}
            onConfirm={() => void act("Restarting", () => localService("restart")).then(() => setNeedsRestart(false))} />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {latest === null ? (
          <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void localLatest().then(setLatest, (err) => setError(errorText(err)))}>Check for mobd updates</Button>
        ) : !newerVersion(latest, health?.version) ? (
          <span className="text-muted-foreground">mobd {health?.version ?? ""} is up to date{!health?.version && ` (latest ${latest})`}.</span>
        ) : managed ? (
          <>
            <span>mobd {latest} is available.</span>
            <Button size="sm" variant="secondary" disabled={!!busy || running > 0} onClick={() => void upgrade()}>Update</Button>
            {running > 0 && <span className="text-muted-foreground">after the running tasks finish</span>}
          </>
        ) : (
          <span className="text-muted-foreground">mobd {latest} is available. Update it the way it was installed ({status.binary}).</span>
        )}
      </div>
      {error && <p className="text-xs text-danger" role="alert">{error}</p>}
      {logs !== null && (
        <pre className="max-h-64 overflow-auto rounded-md bg-muted p-2 font-mono text-[10.5px] leading-snug">{logs || "No log yet."}</pre>
      )}
    </Section>
  );
}

/** Settings for this computer's mobd (mobd docs/mob-desktop-local-mobd.md). */
export function LocalSection({ machine }: { machine: Machine }) {
  const { data: status } = useLocalStatus();
  if (!status?.supported) return null;
  return (
    <div className="grid gap-5 rounded-xl border bg-panel p-4">
      <h3 className="text-[13px] font-semibold">This computer</h3>
      <Service machine={machine} status={status} />
      {status.running && <Devices machine={machine} />}
      {status.running && <Permissions />}
    </div>
  );
}
