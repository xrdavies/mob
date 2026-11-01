import { UpdateSettings } from "@/components/UpdateNotice";
import { AgentsSection } from "@/components/settings/AgentsSection";
import { Licenses } from "@/components/settings/Licenses";
import {
  CheckCircle2, CircleHelp, Info, Monitor, Moon, Palette, Pencil, Plus, ScrollText, Sun, SunMoon, Trash2, TriangleAlert, XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { fetchHealth } from "@/api/client";
import { formatBytes } from "@/lib/desktops";
import { historyStore } from "@/lib/historyStore";
import { QUALITIES } from "@/lib/stream";
import type { Check, Health } from "@/api/types";
import { Spinner } from "@/components/StatusIcon";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip } from "@/components/ui/tooltip";
import { UnauthorizedError } from "@/lib/auth";
import { deviceNameError, pair, parsePairLink } from "@/lib/pairing";
import { getSecretStorageInfo, type SecretStorageInfo } from "@/lib/secrets";
import { cn } from "@/lib/utils";
import { addressKind, addressLabel, currentAddress, hasAddress } from "@/lib/machines";
import { baseUrl, needsPairing, useApp, type Machine, type Theme } from "@/store/app";
import { log, useLog } from "@/store/log";

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

export function ChecksList({ checks }: { checks?: Record<string, Check> }) {
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

const defaultDeviceName = () => {
  const ua = navigator.userAgent;
  return `Mob on ${/Mac/i.test(ua) ? "Mac" : /Windows/i.test(ua) ? "Windows" : /Linux/i.test(ua) ? "Linux" : "desktop"}`;
};

/** A help icon that explains on hover or focus, instead of a paragraph on the page. */
function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip content={<span className="block font-normal leading-snug">{children}</span>} side="top">
      <button type="button" aria-label={label} className="inline-flex text-muted-foreground hover:text-foreground">
        <CircleHelp className="size-3.5" />
      </button>
    </Tooltip>
  );
}

function InsecureWarning() {
  return (
    <p className="flex gap-1.5 rounded-md bg-warning/10 px-2.5 py-1.5 text-[11.5px] text-foreground">
      <TriangleAlert className="mt-px size-3.5 shrink-0 text-warning" />
      HTTP link: traffic including the credential is not encrypted. Use it only on a trusted network or a Tailscale/VPN address.
    </p>
  );
}

/** Paste a `mobd link` URL, confirm the target, redeem the invite. Never sends an existing credential. */
function PairForm({ machine, onPaired }: { machine?: Machine; onPaired: (id: string) => void }) {
  const completePairing = useApp((s) => s.completePairing);
  const machines = useApp((s) => s.machines);
  const [link, setLink] = useState("");
  const [officeName, setOfficeName] = useState("Office computer");
  const [deviceName, setDeviceName] = useState(defaultDeviceName);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const parsed = useMemo(() => {
    if (!link.trim()) return { error: "" };
    try {
      return { link: parsePairLink(link) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }, [link]);
  const target = parsed.link;
  // The saved machine this pairing goes to: the one being edited, else the saved one of that office.
  const saved = machine ?? (target && machines.find((m) => m.serverId === target.serverId));
  const otherOffice = !!saved?.serverId && !!target && target.serverId !== saved.serverId;
  // Another address of the saved office: pairing adds it to the same machine.
  const newAddress = !!saved?.serverId && !!target && !otherOffice && !hasAddress(saved, target.origin);
  const nameError = deviceNameError(deviceName);
  const ready = !!target && !nameError && (!saved ? !!officeName.trim() : true) && (!otherOffice || confirmed) && !busy;

  useEffect(() => setConfirmed(false), [target?.origin]);

  /** Prefer OS clipboard via Tauri — WebKitGTK 2.54 can SIGSEGV on native Ctrl+V (bug 324466). */
  const pasteLink = useCallback(async () => {
    setError("");
    try {
      let text = "";
      if (isTauri()) {
        text = await invoke<string>("clipboard_read_text");
      } else if (navigator.clipboard?.readText) {
        text = await navigator.clipboard.readText();
      } else {
        throw new Error("Clipboard is not available in this environment.");
      }
      setLink(text.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const onLinkKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") {
      e.preventDefault();
      void pasteLink();
    }
  };

  const onLinkPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    // Never let WebKit complete a native paste: Clipboard::formats can SIGSEGV on empty /
    // one-shot clipboards (WebKitGTK 2.54, bugs.webkit.org/show_bug.cgi?id=324466).
    // Reading via Tauri/arboard (pasteLink) avoids that path.
    e.preventDefault();
    void pasteLink();
  };

  const submit = async () => {
    if (!target || !ready) return;
    setBusy(true);
    setError("");
    try {
      const paired = await pair(target, deviceName);
      const id = await completePairing({
        id: saved?.id, name: saved?.name ?? officeName, origin: target.origin, ...paired,
      });
      setLink("");
      onPaired(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-3">
      {!saved && (
        <Label>Display name<Input value={officeName} placeholder="Office computer" onChange={(e) => setOfficeName(e.target.value)} /></Label>
      )}
      <Label>
        Pairing link
        <div className="flex gap-2">
          <Input value={link} autoComplete="off" spellCheck={false} placeholder="https://office.example.com/pair#v=1&serverId=…&invite=…"
            onChange={(e) => { setLink(e.target.value); setError(""); }}
            onKeyDown={onLinkKeyDown}
            onPaste={onLinkPaste} />
          <Button type="button" variant="secondary" className="shrink-0" onClick={() => void pasteLink()}>Paste</Button>
        </div>
      </Label>
      {!target && (
        <p className="-mt-1.5 text-[11px] text-muted-foreground">
          Run <code className="font-mono">mobd link</code> on the office computer and paste the link it prints. It uses the remote address
          set up with <code className="font-mono">mobd remote</code>, else the office network; <code className="font-mono">--lan</code> or{" "}
          <code className="font-mono">--url ADDRESS</code> picks one. Mob relay — coming soon.
        </p>
      )}
      {parsed.error && <p className="-mt-1.5 text-xs text-danger">{parsed.error}</p>}
      {target && (
        <div className="grid grid-cols-1 gap-2 rounded-lg border bg-panel p-3">
          <p className="text-xs"><span className="text-muted-foreground">Pair with </span><span className="break-all font-mono font-medium">{target.origin}</span></p>
          {target.insecure && <InsecureWarning />}
          {saved && newAddress && (
            <p className="text-[11.5px] text-muted-foreground">
              Adds this address to {saved.name} as {addressKind(target.origin)}, next to {saved.addresses.map((a) => addressLabel(saved, a)).join(", ")}.
              Mob uses it from now on; switch with the route chip next to {saved.name} in the sidebar.
            </p>
          )}
          {otherOffice && (
            <label className="flex items-start gap-2 text-[11.5px]">
              <input type="checkbox" className="mt-0.5" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
              <span className="text-warning">This link belongs to a different office than the one saved as {saved?.name}. Pairing replaces its addresses.</span>
            </label>
          )}
        </div>
      )}
      <Label>
        Name of this device
        <Input value={deviceName} maxLength={128} onChange={(e) => setDeviceName(e.target.value)} />
      </Label>
      <p className="-mt-1.5 text-[11px] text-muted-foreground">Shown in the office computer's list of paired devices.</p>
      <div className="flex items-center gap-2">
        <Button disabled={!ready} onClick={() => void submit()}>{busy && <Spinner />} {newAddress ? "Add address" : saved ? "Pair again" : "Pair"}</Button>
        {target && nameError && <span className="text-xs text-danger">{nameError}</span>}
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}


function QualityPicker({ value, onChange }: { value: NonNullable<Machine["liveQuality"]>; onChange: (q: NonNullable<Machine["liveQuality"]>) => void }) {
  const hint = QUALITIES.find((q) => q.value === value)?.hint;
  return (
    <div className="grid grid-cols-1 gap-1">
      <span className="flex items-center gap-1.5 text-xs font-medium">
        Live view quality
        <InfoTip label="About live view quality">{hint}. Applies at once and reconnects an open live view; also in the live view&apos;s header.</InfoTip>
      </span>
      <div role="radiogroup" aria-label="Live view quality" className="flex w-fit rounded-md border bg-panel p-0.5">
        {QUALITIES.map((q) => (
          <button key={q.value} type="button" role="radio" aria-checked={value === q.value} onClick={() => onChange(q.value)}
            className={cn("h-6 rounded px-3 text-[11.5px] font-medium transition-colors",
              value === q.value ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground")}>
            {q.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function MachineForm({ machine }: { machine: Machine }) {
  const { saveMachine, setLiveQuality, deleteMachine, selectRoute, removeAddress, set } = useApp();
  const [form, setForm] = useState<{ name: string; labels: Record<string, string> }>({ name: "", labels: {} });
  const [test, setTest] = useState<{ state: "idle" | "testing" | "ok" | "error"; health?: Health; error?: string }>({ state: "idle" });
  const [saved, setSaved] = useState("");
  const [repair, setRepair] = useState(false);
  /** The address whose name is being edited. */
  const [renaming, setRenaming] = useState<string | null>(null);

  useEffect(() => {
    setForm({ name: machine.name, labels: Object.fromEntries(machine.addresses.map((a) => [a.id, a.label ?? ""])) });
    setTest({ state: "idle" });
    setSaved("");
    setRepair(false);
  }, [machine.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const runTest = async () => {
    setTest({ state: "testing" });
    try {
      const health = await fetchHealth(baseUrl(machine));
      setTest({ state: health.ok ? "ok" : "error", health });
    } catch (err) {
      setTest({
        state: "error",
        error: err instanceof UnauthorizedError ? err.message
          : `${err instanceof Error ? err.message : String(err)} — check the network/VPN and that mobd is running`,
      });
    }
  };

  return (
    <form
      className="grid min-w-0 grid-cols-1 content-start gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!form.name.trim()) return;
        saveMachine({ id: machine.id, name: form.name, labels: form.labels });
        setSaved("Saved");
      }}
    >
      <h3 className="text-[13px] font-semibold">{machine.name} · Connection</h3>
      <Label>Display name<Input value={form.name} placeholder="Office computer" onChange={(e) => setForm({ ...form, name: e.target.value })} required /></Label>
      <div className="grid grid-cols-1 gap-2 rounded-lg border bg-panel p-3">
        <span className="flex items-center gap-1.5 text-xs font-medium">
          Addresses
          <InfoTip label="About addresses">
            Each address is paired on its own, so the device credential never goes to an address it was not paired on. To add one, run
            mobd link (or mobd link --lan) on the office computer and paste its link.
          </InfoTip>
        </span>
        {machine.addresses.map((a) => {
          const inUse = currentAddress(machine)?.id === a.id;
          return (
            <div key={a.id} className="grid grid-cols-1 gap-1">
              <div className="flex items-center gap-2 text-xs">
                <span className={cn("size-2 shrink-0 rounded-full", a.needsPairing ? "bg-warning" : "bg-success")} />
                {renaming === a.id ? (
                  <Input className="h-7 w-32" aria-label="Address name" autoFocus value={form.labels[a.id] ?? ""} placeholder={addressKind(a.url)}
                    onChange={(e) => setForm({ ...form, labels: { ...form.labels, [a.id]: e.target.value } })}
                    onBlur={() => setRenaming(null)}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Escape") { e.preventDefault(); setRenaming(null); } }} />
                ) : (
                  <>
                    <span className="shrink-0 font-medium">{form.labels[a.id]?.trim() || addressLabel(machine, { ...a, label: undefined })}</span>
                    <Button variant="ghost" size="icon-sm" className="-my-1 shrink-0 text-muted-foreground" aria-label="Rename address" title="Rename"
                      onClick={() => setRenaming(a.id)}>
                      <Pencil className="size-3" />
                    </Button>
                  </>
                )}
                <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground" title={a.url}>{a.url}</span>
                {!a.needsPairing && a.url.startsWith("http:") && (
                  <Tooltip content="Not encrypted: traffic including the credential can be read on the network. Use it only on a trusted network or a Tailscale/VPN address." side="top">
                    <span tabIndex={0} className="flex shrink-0 items-center gap-1 text-warning"><TriangleAlert className="size-3.5" />HTTP</span>
                  </Tooltip>
                )}
                {a.needsPairing && <span className="shrink-0 text-warning">Needs pairing</span>}
                {inUse ? <span className="shrink-0 text-muted-foreground">In use</span>
                  : <Button variant="ghost" size="sm" className="-my-1 shrink-0" onClick={() => selectRoute(machine.id, a.id)}>Use</Button>}
                {machine.addresses.length > 1 && (
                  <Button variant="ghost" size="icon-sm" aria-label={`Remove ${addressLabel(machine, a)}`} className="shrink-0 text-danger hover:text-danger"
                    onClick={() => removeAddress(machine.id, a.id)}>
                    <Trash2 className="size-3.5" />
                  </Button>
                )}
              </div>
            </div>
          );
        })}
        {needsPairing(machine) && (
          <p className="text-[11.5px] text-muted-foreground">
            This device has no valid credential for the address in use. Run <code className="font-mono">mobd link</code> on the office computer and paste the new link.
          </p>
        )}
        {needsPairing(machine) || repair ? (
          <PairForm machine={machine} onPaired={() => { setRepair(false); setTest({ state: "idle" }); }} />
        ) : (
          <Button variant="ghost" size="sm" className="w-fit" onClick={() => setRepair(true)}>Add address or pair again…</Button>
        )}
      </div>
      <QualityPicker value={machine.liveQuality ?? "auto"} onChange={(q) => setLiveQuality(machine.id, q)} />
      <div className="flex items-center gap-2 pt-1">
        <Button type="submit" disabled={!form.name.trim()}>Save</Button>
        <Button variant="secondary" disabled={needsPairing(machine) || test.state === "testing"} onClick={() => void runTest()}>
          {test.state === "testing" && <Spinner />} Test connection
        </Button>
        {saved && <span className={cn("text-xs", saved === "Saved" ? "text-success" : "text-danger")}>{saved}</span>}
        <div className="flex-1" />
        <Button variant="ghost" className="text-danger hover:text-danger" onClick={() => { deleteMachine(machine.id); set({ editMachineId: "" }); }}>
          <Trash2 className="size-3.5" /> Remove
        </Button>
      </div>
      {test.state === "error" && test.error && <p className="text-xs text-danger">{test.error}</p>}
      {test.health && (
        <div className="rounded-lg border bg-panel p-3">
          <p className="mb-2 text-xs text-muted-foreground">
            mobd API v{test.health.apiVersion}{test.health.apiVersion < 3 && " — update the office daemon for activities, queue and uploads"}
          </p>
          <ChecksList checks={test.health.checks} />
        </div>
      )}
    </form>
  );
}

function CredentialStorageNote() {
  const [info, setInfo] = useState<SecretStorageInfo | null>(null);
  useEffect(() => {
    void getSecretStorageInfo().then(setInfo);
  }, []);
  if (!info || info.backend !== "file") return null;
  return (
    <div
      role="status"
      className="mb-3 flex shrink-0 items-start gap-2 rounded-lg border bg-muted/70 p-3 text-xs"
    >
      <Info className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 space-y-0.5">
        <p className="font-medium text-foreground">Using encrypted local file for pairing credentials</p>
        <p className="text-muted-foreground">
          {info.path ? <span className="break-all font-mono">{info.path}</span> : null}
          {info.path ? " · " : null}
          System keyring / Secret Service unavailable. Same-user readable — see docs/credential-storage.md.
        </p>
      </div>
    </div>
  );
}

function MachinesTab() {
  const { machines, editMachineId, selectMachine, set } = useApp();
  const editing = machines.find((m) => m.id === editMachineId);
  return (
    <div className="flex h-full flex-col">
      <CredentialStorageNote />
      <div className="flex min-h-0 flex-1 gap-4 overflow-hidden">
        <div className="flex w-44 shrink-0 flex-col gap-1 overflow-y-auto">
          {machines.map((m) => (
            <button key={m.id} type="button" onClick={() => set({ editMachineId: m.id })}
              className={cn("rounded-md px-2.5 py-1.5 text-left hover:bg-muted", m.id === editMachineId && "bg-muted")}>
              <p className="truncate text-[13px] font-medium">{m.name}</p>
              <p className={cn("truncate text-[11px]", needsPairing(m) ? "text-warning" : "text-muted-foreground")}>
                {needsPairing(m) ? "Needs pairing" : m.addresses.length > 1 ? `${m.addresses.length} addresses` : baseUrl(m)}
              </p>
            </button>
          ))}
          <Button variant="ghost" size="sm" className="justify-start" onClick={() => set({ editMachineId: "" })}>
            <Plus className="size-3.5" /> Add machine
          </Button>
        </div>
        {editing ? (
          // One page per machine: its connection, then its agents.
          <div className="grid min-h-0 min-w-0 flex-1 grid-cols-1 content-start gap-6 overflow-y-auto overflow-x-hidden pr-1">
            <MachineForm machine={editing} />
            <AgentsSection key={editing.id} machine={editing} />
          </div>
        ) : (
          <div className="grid min-h-0 min-w-0 flex-1 grid-cols-1 content-start gap-3 overflow-y-auto">
            <h3 className="text-[13px] font-semibold">Add machine</h3>
            <PairForm onPaired={(id) => { set({ editMachineId: id }); selectMachine(id); }} />
          </div>
        )}
      </div>
    </div>
  );
}

function AppearanceTab() {
  const { theme, set } = useApp();
  const options: { value: Theme; label: string; icon: typeof Sun }[] = [
    { value: "system", label: "System", icon: SunMoon },
    { value: "light", label: "Light", icon: Sun },
    { value: "dark", label: "Dark", icon: Moon },
  ];
  return (
    <div className="grid gap-2">
      <h3 className="text-[13px] font-semibold">Theme</h3>
      <div className="grid w-fit grid-cols-3 gap-2">
        {options.map((o) => (
          <button key={o.value} type="button" onClick={() => set({ theme: o.value })}
            className={cn("flex w-28 flex-col items-center gap-1.5 rounded-lg border p-3 text-xs hover:bg-muted", theme === o.value && "border-accent bg-accent-soft")}>
            <o.icon className="size-4" /> {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function NotificationsSetting() {
  const supported = typeof Notification !== "undefined";
  const [perm, setPerm] = useState(supported ? Notification.permission : "denied");
  return (
    <div className="grid gap-2">
      <h3 className="text-[13px] font-semibold">Notifications</h3>
      <p className="text-xs text-muted-foreground">Get a system notification when the agent asks you something while Mob is in the background.</p>
      {perm === "granted" ? (
        <p className="text-xs text-success">Enabled</p>
      ) : (
        <Button variant="secondary" className="w-fit" disabled={!supported || perm === "denied"}
          onClick={() => void Notification.requestPermission().then(setPerm)}>
          {perm === "denied" ? "Blocked in system settings" : "Enable notifications"}
        </Button>
      )}
    </div>
  );
}

/** The local copy of conversations (docs/conversation-history.md): its size, and clearing it. */
function LocalCopySetting() {
  const [size, setSize] = useState<number | null>(null);
  const [clearing, setClearing] = useState(false);
  const measure = () => void historyStore.size().then(setSize, () => setSize(null));
  useEffect(measure, []);
  return (
    <div className="grid gap-2">
      <h3 className="text-[13px] font-semibold">Saved conversations</h3>
      <p className="text-xs text-muted-foreground">
        Conversations you open are saved on this computer, so they show at once and can be read while the office
        computer is unreachable. Up to 500 MB; the least recently opened are removed first.
      </p>
      <p className="text-xs">{size === null ? "Size unknown" : `${formatBytes(size)} used`}</p>
      <Button variant="secondary" className="w-fit" disabled={clearing || !size}
        onClick={() => {
          setClearing(true);
          historyStore.clear().catch((err) => log(`clearing the local copy failed: ${String(err)}`, "error"))
            .finally(() => { setClearing(false); measure(); });
        }}>
        Clear local copy
      </Button>
    </div>
  );
}

function LogTab() {
  const { lines, clear } = useLog();
  const [filter, setFilter] = useState("");
  const shown = filter ? lines.filter((l) => l.text.toLowerCase().includes(filter.toLowerCase())) : lines;
  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex gap-2">
        <Input placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <Button variant="secondary" onClick={() => void navigator.clipboard.writeText(shown.map((l) => `[${l.at}] ${l.text}`).join("\n"))}>Copy</Button>
        <Button variant="secondary" onClick={clear}>Clear</Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border bg-code p-2 font-mono text-[11px] leading-relaxed">
        {shown.length === 0 && <p className="text-muted-foreground">Event stream and debug lines appear here. The chat stays clean.</p>}
        {shown.map((l) => (
          <p key={l.id} className={cn("break-all", l.kind === "error" && "text-danger", l.kind === "info" && "text-accent")}>
            <span className="text-muted-foreground">[{l.at}]</span> {l.text}
          </p>
        ))}
      </div>
    </div>
  );
}

export function SettingsDialog() {
  const { settingsOpen, settingsTab, set } = useApp();
  const tabs = [
    { value: "machines", label: "Machines", icon: Monitor },
    { value: "appearance", label: "Appearance", icon: Palette },
    { value: "log", label: "Log", icon: ScrollText },
    { value: "about", label: "About", icon: Info },
  ] as const;
  return (
    <Dialog open={settingsOpen} onOpenChange={(o) => set({ settingsOpen: o })}>
      <DialogContent className="flex h-[560px] w-[760px] max-w-[94vw] overflow-hidden p-0">
        <Tabs value={settingsTab} onValueChange={(v) => set({ settingsTab: v as typeof settingsTab })} orientation="vertical" className="flex w-full">
          <div className="w-44 shrink-0 border-r bg-panel p-2">
            <DialogTitle className="px-2.5 pb-2 pt-1.5">Settings</DialogTitle>
            <DialogDescription className="sr-only">Machines, appearance and logs</DialogDescription>
            <TabsList>
              {tabs.map((t) => <TabsTrigger key={t.value} value={t.value}><t.icon /> {t.label}</TabsTrigger>)}
            </TabsList>
          </div>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto p-5 pt-11">
            <TabsContent value="machines" className="h-full"><MachinesTab /></TabsContent>
            <TabsContent value="appearance"><div className="grid gap-6"><AppearanceTab /><NotificationsSetting /><LocalCopySetting /></div></TabsContent>
            <TabsContent value="log" className="h-full"><LogTab /></TabsContent>
            <TabsContent value="about">
              <div className="grid gap-1 text-[13px]">
                <img src="/logo.svg" alt="Mob Screen Buddy" className="mb-2 size-20" />
                <p className="font-semibold">Mob</p>
                <p className="text-muted-foreground">Home client for the Mob office agent</p>
                <UpdateSettings />
                <Licenses />
              </div>
            </TabsContent>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
