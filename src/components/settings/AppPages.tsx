import { isTauri } from "@tauri-apps/api/core";
import { ArrowLeft, Check, Copy, ExternalLink, Laptop, Monitor, ScrollText, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Licenses } from "@/components/settings/Licenses";
import { Spinner } from "@/components/StatusIcon";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Switch } from "@/components/ui/switch";
import { formatBytes } from "@/lib/desktops";
import { historyStore } from "@/lib/historyStore";
import { isLocal } from "@/lib/machines";
import { MOD, shortcut } from "@/lib/platform";
import { getSecretStorageInfo, type SecretStorageInfo } from "@/lib/secrets";
import { cn } from "@/lib/utils";
import { useApp, type NotifyPrefs, type TextSize, type Theme } from "@/store/app";
import { log, useLog } from "@/store/log";
import { useUpdates } from "@/store/updates";
import { Group, Page, Row, Segmented } from "./ui";

const SHORTCUTS: [string, string][] = [
  ["Search or ask an agent", shortcut("K")],
  ["New chat", shortcut("N")],
  ["Open a recent conversation", `${MOD} 1–9`],
  ["Hide or show the sidebar", shortcut("B")],
  ["Hide or show the side panel", shortcut("B", true)],
  ["Take control of the screen", shortcut("C", true)],
  ["Release control", "Esc"],
  ["Settings", shortcut(",")],
];

function AboutCard() {
  const updates = useUpdates();
  const busy = ["checking", "installing", "installed"].includes(updates.phase);
  return (
    <div className="flex items-center gap-4 rounded-[14px] border bg-background p-4">
      <img src="/logo.svg" alt="Mob Screen Buddy" className="size-16" />
      <div className="grid min-w-0 flex-1 gap-0.5">
        <p className="text-[15px] font-semibold">Mob</p>
        <p className="text-xs text-muted-foreground">
          {updates.currentVersion ? `Version ${updates.currentVersion}` : isTauri() ? "" : "Browser preview"}
          {updates.phase === "current" && " · Up to date"}
          {updates.phase === "available" && ` · ${updates.update?.version} available`}
        </p>
        {updates.error && <p className="break-words text-xs text-danger" role="alert">{updates.error}</p>}
      </div>
      {updates.phase === "available" ? (
        <Button size="sm" onClick={() => void updates.install()}>Install and restart</Button>
      ) : (
        <Button size="sm" variant="secondary" disabled={!isTauri() || updates.phase === "disabled" || busy} onClick={() => void updates.check()}>
          {updates.phase === "checking" && <Spinner />} Check for updates
        </Button>
      )}
    </div>
  );
}

function SavedCopies() {
  const [size, setSize] = useState<number | null>(null);
  const [clearing, setClearing] = useState(false);
  const measure = () => void historyStore.size().then(setSize, () => setSize(null));
  useEffect(measure, []);
  return (
    <Row label="Saved copies" detail={size === null ? "Size unknown" : `${formatBytes(size)} of 500 MB`}>
      <IconButton label="Clear saved copies" disabled={clearing || !size} onClick={() => {
        setClearing(true);
        historyStore.clear().catch((err) => log(`clearing the local copy failed: ${String(err)}`, "error"))
          .finally(() => { setClearing(false); measure(); });
      }}>
        {clearing ? <Spinner /> : <Trash2 />}
      </IconButton>
    </Row>
  );
}

function Credentials() {
  const [info, setInfo] = useState<SecretStorageInfo | null>(null);
  useEffect(() => void getSecretStorageInfo().then(setInfo), []);
  const where = !isTauri() ? "In memory (browser preview)"
    : info?.backend === "file" ? "Encrypted file" : /Mac/.test(navigator.userAgent) ? "Keychain" : "System keyring";
  return <Row label="Pairing credentials" detail={info?.backend === "file" ? info.path ?? undefined : undefined}><span className="text-xs text-muted-foreground">{where}</span></Row>;
}

export function GeneralPage() {
  const set = useApp((s) => s.set);
  const [licenses, setLicenses] = useState(false);
  if (licenses) {
    return (
      <Page title={<span className="flex items-center gap-1"><IconButton label="Back" onClick={() => setLicenses(false)}><ArrowLeft /></IconButton>Licenses</span>}>
        <Licenses />
      </Page>
    );
  }
  return (
    <Page title="General">
      <AboutCard />
      <Group title="Updates">
        <Row label="Mob updates" detail="Checked at launch; stable releases only"><span className="text-xs text-muted-foreground">Automatic</span></Row>
      </Group>
      <Group title="Conversations">
        <SavedCopies />
        <Credentials />
      </Group>
      <Group title="Keyboard shortcuts">
        {SHORTCUTS.map(([what, keys]) => (
          <Row key={what} label={what} className="min-h-9 py-1.5"><Kbd>{keys}</Kbd></Row>
        ))}
      </Group>
      <Group title="Help">
        <Row label="App log"><IconButton label="Open the app log" onClick={() => set({ settingsTab: "log" })}><ScrollText /></IconButton></Row>
        <Row label="What is Mob?">
          <a href="https://mymob.dev/" target="_blank" rel="noreferrer" aria-label="Open mymob.dev"
            className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
            <ExternalLink className="size-4" />
          </a>
        </Row>
        <Row label="Licenses"><Button size="sm" variant="ghost" onClick={() => setLicenses(true)}>Show</Button></Row>
      </Group>
    </Page>
  );
}

/** A small picture of the window in each theme. */
function ThemePreview({ dark }: { dark: boolean | "split" }) {
  const pane = (d: boolean) => (
    <div className={cn("flex h-full flex-1", d ? "bg-[#1c1c20]" : "bg-white")}>
      <div className={cn("w-[34%] border-r p-1.5", d ? "border-white/10 bg-[#26262b]" : "border-black/10 bg-[#f4f4f6]")}>
        {[60, 80, 50].map((w) => <div key={w} className={cn("mb-1 h-1 rounded", d ? "bg-white/25" : "bg-black/15")} style={{ width: `${w}%` }} />)}
      </div>
      <div className="flex flex-1 flex-col justify-end gap-1 p-1.5">
        <div className="ml-auto h-1.5 w-1/2 rounded bg-accent/70" />
        <div className={cn("h-1.5 w-3/4 rounded", d ? "bg-white/20" : "bg-black/10")} />
      </div>
    </div>
  );
  return (
    <div className="flex h-16 w-full overflow-hidden rounded-md border">
      {dark === "split" ? <><div className="flex w-1/2 overflow-hidden">{pane(false)}</div><div className="flex w-1/2 overflow-hidden">{pane(true)}</div></> : pane(dark)}
    </div>
  );
}

export function AppearancePage() {
  const { theme, textSize, perComputer, stepsOpen, previewOpen, set, togglePreview } = useApp();
  const themes: { value: Theme; label: string; dark: boolean | "split" }[] = [
    { value: "system", label: "System", dark: "split" },
    { value: "light", label: "Light", dark: false },
    { value: "dark", label: "Dark", dark: true },
  ];
  return (
    <Page title="Appearance">
      <Group title="Theme">
        <div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 gap-3 p-3">
          {themes.map((t) => (
            <button key={t.value} type="button" role="radio" aria-checked={theme === t.value} onClick={() => set({ theme: t.value })}
              className={cn("grid gap-1.5 rounded-lg border p-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring",
                theme === t.value ? "border-accent ring-1 ring-accent" : "hover:bg-muted")}>
              <ThemePreview dark={t.dark} />
              <span className={cn(theme === t.value && "font-medium")}>{t.label}</span>
            </button>
          ))}
        </div>
      </Group>
      <Group title="Layout">
        <Row label="Text size">
          <Segmented<TextSize> label="Text size" value={textSize} onChange={(v) => set({ textSize: v })}
            options={[{ value: "small", label: "Small" }, { value: "default", label: "Default" }, { value: "large", label: "Large" }]} />
        </Row>
        <Row label="Conversations per computer" detail="In the sidebar, before Show more">
          <Segmented label="Conversations per computer" value={String(perComputer)} onChange={(v) => set({ perComputer: Number(v) })}
            options={["3", "5", "10"].map((v) => ({ value: v, label: v }))} />
        </Row>
        <Row label="Agent steps in replies">
          <Segmented label="Agent steps in replies" value={stepsOpen ? "open" : "folded"} onChange={(v) => set({ stepsOpen: v === "open" })}
            options={[{ value: "folded", label: "Folded" }, { value: "open", label: "Unfolded" }]} />
        </Row>
        <Row label="Side panel" detail={shortcut("B", true)}>
          <Switch checked={previewOpen} onCheckedChange={(on) => togglePreview(on)} aria-label="Show the side panel" />
        </Row>
      </Group>
    </Page>
  );
}

export function NotificationsPage() {
  const { notify, machines, set } = useApp();
  const supported = typeof Notification !== "undefined";
  const [perm, setPerm] = useState(supported ? Notification.permission : "denied");
  const change = (patch: Partial<NotifyPrefs>) => set({ notify: { ...notify, ...patch } });
  const when: [keyof NotifyPrefs, string][] = [["needs", "An agent needs you"], ["done", "A conversation finishes"], ["failed", "A conversation fails"]];
  return (
    <Page title="Notifications">
      <Group>
        <Row label="System notifications" detail={perm === "denied" ? "Turned off for Mob in System Settings" : undefined}>
          {perm === "granted" ? <span className="flex items-center gap-1 text-xs text-success"><Check className="size-3.5" /> Allowed</span> : (
            <Button size="sm" variant="secondary" disabled={!supported || perm === "denied"} onClick={() => void Notification.requestPermission().then(setPerm)}>Allow…</Button>
          )}
        </Row>
      </Group>
      <Group title="Tell me when">
        {when.map(([key, label]) => (
          <Row key={key} label={label}>
            <Switch checked={!!notify[key]} onCheckedChange={(on) => change({ [key]: on })} aria-label={label} />
          </Row>
        ))}
      </Group>
      <Group title="Per computer">
        {machines.map((m) => (
          <Row key={m.id} label={<span className="flex items-center gap-1.5">{isLocal(m) ? <Laptop className="size-3.5" /> : <Monitor className="size-3.5" />}{m.name}</span>}>
            <Segmented label={`Notifications from ${m.name}`} value={notify.computers[m.id] ?? "all"}
              onChange={(v) => change({ computers: { ...notify.computers, [m.id]: v } })}
              options={[{ value: "all", label: "Everything" }, { value: "needs", label: "Only when it needs me" }]} />
          </Row>
        ))}
        {!machines.length && <Row label="No computers yet" />}
      </Group>
      <Group title="Delivery">
        <Row label="Play a sound"><Switch checked={notify.sound} onCheckedChange={(on) => change({ sound: on })} aria-label="Play a sound" /></Row>
        <Row label="Only while Mob is in the background"><Switch checked={notify.background} onCheckedChange={(on) => change({ background: on })} aria-label="Only while Mob is in the background" /></Row>
      </Group>
    </Page>
  );
}

export function LogPage() {
  const { lines, clear } = useLog();
  const set = useApp((s) => s.set);
  const [filter, setFilter] = useState("");
  const [copied, setCopied] = useState(false);
  const shown = filter ? lines.filter((l) => l.text.toLowerCase().includes(filter.toLowerCase())) : lines;
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex items-center gap-1">
        <IconButton label="Back to General" onClick={() => set({ settingsTab: "general" })}><ArrowLeft /></IconButton>
        <h2 className="flex-1 text-[17px] font-semibold">App log</h2>
        <Input className="h-8 w-48" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <IconButton label={copied ? "Copied" : "Copy"} onClick={() => {
          void navigator.clipboard.writeText(shown.map((l) => `[${l.at}] ${l.text}`).join("\n"));
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }}>{copied ? <Check /> : <Copy />}</IconButton>
        <IconButton label="Clear" onClick={clear}><Trash2 /></IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border bg-code p-2 font-mono text-[11px] leading-relaxed">
        {shown.length === 0 && <p className="text-muted-foreground">Empty</p>}
        {shown.map((l) => (
          <p key={l.id} className={cn("break-all", l.kind === "error" && "text-danger", l.kind === "info" && "text-accent")}>
            <span className="text-muted-foreground">[{l.at}]</span> {l.text}
          </p>
        ))}
      </div>
    </div>
  );
}
