import { invoke, isTauri } from "@tauri-apps/api/core";
import { ArrowLeft, Check, ChevronRight, ClipboardPaste, Copy, Laptop, Lock, Monitor, Pencil, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { Spinner } from "@/components/StatusIcon";
import { LocalSetup, useLocalStatus } from "@/components/local/LocalSetup";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { addressKind, addressLabel, hasAddress, hostOf, isLocal } from "@/lib/machines";
import { deviceNameError, nameFromOrigin, pair, parsePairLink, type PairLink } from "@/lib/pairing";
import { cn } from "@/lib/utils";
import { useApp, type Machine } from "@/store/app";

type Step = "choose" | "link" | "confirm" | "local";

const defaultDeviceName = () => {
  const ua = navigator.userAgent;
  return `Mob on ${/Mac/i.test(ua) ? "Mac" : /Windows/i.test(ua) ? "Windows" : /Linux/i.test(ua) ? "Linux" : "desktop"}`;
};

/** The OS clipboard through Tauri: WebKitGTK 2.54 can SIGSEGV on a native paste (WebKit bug 324466). */
async function readClipboard(): Promise<string> {
  if (isTauri()) return invoke<string>("clipboard_read_text");
  return navigator.clipboard?.readText?.() ?? "";
}

function tryParse(text: string): PairLink | null {
  try {
    return parsePairLink(text);
  } catch {
    return null;
  }
}

function Header({ title, description, onBack }: { title: string; description?: ReactNode; onBack?: () => void }) {
  return (
    <div className="flex items-start gap-2 pr-6">
      {onBack && (
        <Button variant="ghost" size="icon-sm" aria-label="Back" className="-ml-1.5 mt-[-3px]" onClick={onBack}><ArrowLeft /></Button>
      )}
      <div className="grid gap-1">
        <DialogTitle className="text-[15px]">{title}</DialogTitle>
        {description && <DialogDescription className="text-[12.5px]">{description}</DialogDescription>}
      </div>
    </div>
  );
}

function ChoiceCard({ icon, title, text, onClick }: { icon: ReactNode; title: string; text: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}
      className="group grid gap-3 rounded-xl border bg-panel p-4 text-left transition-colors hover:border-foreground/25 hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <span className="flex size-10 items-center justify-center rounded-lg bg-background text-muted-foreground shadow-sm group-hover:text-foreground">{icon}</span>
      <span className="grid gap-0.5">
        <span className="flex items-center gap-1 text-[13.5px] font-semibold">{title}<ChevronRight className="size-3.5 opacity-0 transition-opacity group-hover:opacity-60" /></span>
        <span className="text-[12px] text-muted-foreground">{text}</span>
      </span>
    </button>
  );
}

/** Step 2: run `mobd link` there, paste what it prints. A valid link moves on by itself. */
function LinkStep({ machine, onLink, onBack, checkClipboard }: {
  machine?: Machine; onLink: (l: PairLink) => void; onBack?: () => void; checkClipboard: () => boolean;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [more, setMore] = useState(false);
  const take = (raw: string) => {
    const value = raw.trim();
    setText(value);
    if (!value) return setError("");
    try {
      onLink(parsePairLink(value));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  // A link already on the clipboard (just copied from the terminal) is used at once; only on the
  // first visit, so Back from the next step stays here.
  useEffect(() => {
    if (!checkClipboard()) return;
    void readClipboard().then((t) => { const l = tryParse(t); if (l) onLink(l); }, () => undefined);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const paste = () => void readClipboard().then(take, (err) => setError(err instanceof Error ? err.message : String(err)));
  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    paste();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") {
      e.preventDefault();
      paste();
    } else if (e.key === "Enter") take(text);
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    take(e.dataTransfer.getData("text/plain"));
  };
  return (
    <div className="grid gap-5" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <Header
        title={machine ? `Pair ${machine.name} again` : "Add another computer"}
        description={machine ? "Or add another of its addresses, such as its Tailscale one." : "An office Mac or Linux machine running mobd."}
        onBack={onBack}
      />
      <ol className="grid gap-4">
        <li className="flex gap-3">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold">1</span>
          <div className="grid min-w-0 flex-1 gap-2">
            <p className="text-[13px]">On that computer, run</p>
            <div className="flex items-center justify-between rounded-lg border bg-muted/50 py-1.5 pl-3 pr-1.5 font-mono text-[13px]">
              mobd link
              <Button variant="ghost" size="sm" className="h-7 gap-1.5 font-sans text-xs" onClick={() => {
                void navigator.clipboard.writeText("mobd link").then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
              }}>
                {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          </div>
        </li>
        <li className="flex gap-3">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold">2</span>
          <div className="grid min-w-0 flex-1 gap-2">
            <p className="text-[13px]">Paste the link it prints</p>
            <div className="flex gap-2">
              <Input autoFocus value={text} autoComplete="off" spellCheck={false} aria-invalid={!!error}
                placeholder="https://…/pair#v=1&serverId=…&invite=…" className="font-mono text-xs"
                onChange={(e) => { setText(e.target.value); setError(""); }} onPaste={onPaste} onKeyDown={onKeyDown} />
              <Button variant="secondary" className="shrink-0 gap-1.5" onClick={paste}><ClipboardPaste className="size-3.5" /> Paste</Button>
            </div>
            {error && <p className="text-xs text-danger">{error}</p>}
          </div>
        </li>
      </ol>
      <div className="grid gap-2 border-t pt-3 text-[12px] text-muted-foreground">
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <a href="https://mymob.dev/install/" target="_blank" rel="noreferrer" className="hover:text-foreground hover:underline">No mobd there yet? Install it ↗</a>
          <button type="button" className="hover:text-foreground hover:underline" onClick={() => setMore(!more)}>Other addresses</button>
        </div>
        {more && (
          <p className="text-[11.5px]">
            <code className="font-mono">mobd link</code> uses the remote address set up with <code className="font-mono">mobd remote</code>, else
            the office network. <code className="font-mono">mobd link --lan</code> picks the office network, <code className="font-mono">--url ADDRESS</code> any other.
          </p>
        )}
      </div>
    </div>
  );
}

/** Step 3: what is about to be paired, with its name and this device's name. */
function ConfirmStep({ link, machine, onBack, onPaired }: {
  link: PairLink; machine?: Machine; onBack: () => void; onPaired: (id: string) => void;
}) {
  const machines = useApp((s) => s.machines);
  const completePairing = useApp((s) => s.completePairing);
  const saveMachine = useApp((s) => s.saveMachine);
  const saved = machine ?? machines.find((m) => m.serverId === link.serverId);
  const otherOffice = !!saved?.serverId && saved.serverId !== link.serverId;
  const newAddress = !!saved?.serverId && !otherOffice && !hasAddress(saved, link.origin);
  const [name, setName] = useState(saved?.name ?? nameFromOrigin(link.origin));
  const [renamed, setRenamed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [deviceName, setDeviceName] = useState(defaultDeviceName);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const nameError = deviceNameError(deviceName);
  const ready = !!name.trim() && !nameError && (!otherOffice || confirmed) && !busy;

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const paired = await pair(link, deviceName);
      const id = await completePairing({ id: saved?.id, name: name.trim(), origin: link.origin, ...paired });
      // A new machine takes the computer's own name unless the user typed one.
      if (!saved && !renamed && paired.computerName) saveMachine({ id, name: paired.computerName });
      else if (renamed && saved) saveMachine({ id, name: name.trim() });
      onPaired(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const kind = addressKind(link.origin);
  return (
    <div className="grid gap-5">
      <Header title={newAddress ? `Add an address to ${saved?.name}?` : saved ? `Pair ${saved.name} again?` : "Pair with this computer?"} onBack={onBack} />
      <div className="grid gap-3 rounded-xl border bg-panel p-4">
        <div className="flex items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-background text-muted-foreground shadow-sm"><Monitor className="size-5" /></span>
          <div className="grid min-w-0 flex-1 gap-0.5">
            {editing ? (
              <Input autoFocus value={name} maxLength={80} className="h-7 text-[13.5px] font-semibold"
                onChange={(e) => { setName(e.target.value); setRenamed(true); }}
                onBlur={() => setEditing(false)} onKeyDown={(e) => e.key === "Enter" && setEditing(false)} />
            ) : (
              <button type="button" className="group flex min-w-0 items-center gap-1.5 text-left" onClick={() => setEditing(true)} aria-label="Rename">
                <span className="truncate text-[13.5px] font-semibold">{name || "Untitled"}</span>
                <Pencil className="size-3 shrink-0 text-muted-foreground opacity-60 group-hover:opacity-100" />
              </button>
            )}
            <p className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted-foreground">
              <span className="truncate">{hostOf(link.origin)}</span>
              <span>·</span>
              <span>{saved && newAddress ? addressLabel({ ...saved, addresses: [...saved.addresses, { id: "new", url: link.origin }] }, { id: "new", url: link.origin }) : kind}</span>
              <span>·</span>
              {link.insecure
                ? <span className="flex items-center gap-1 text-warning"><TriangleAlert className="size-3" /> not encrypted</span>
                : <span className="flex items-center gap-1"><Lock className="size-3" /> HTTPS</span>}
            </p>
          </div>
        </div>
        {link.insecure && (
          <p className="text-[11.5px] text-muted-foreground">Plain HTTP: use it only on a trusted network or a Tailscale or VPN address.</p>
        )}
        {newAddress && saved && (
          <p className="text-[11.5px] text-muted-foreground">Mob uses this address from now on; switch with the address chip next to {saved.name} in the sidebar.</p>
        )}
        {otherOffice && (
          <label className="flex items-start gap-2 text-[11.5px] text-warning">
            <input type="checkbox" className="mt-0.5" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            This link is for a different computer than {saved?.name}. Pairing replaces its addresses.
          </label>
        )}
      </div>
      <div className="grid gap-2">
        <button type="button" className="flex w-fit items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground" onClick={() => setAdvanced(!advanced)}>
          <ChevronRight className={cn("size-3.5 transition-transform", advanced && "rotate-90")} />
          Shown there as “{deviceName.trim() || "…"}”
        </button>
        {advanced && (
          <div className="grid gap-1 pl-5">
            <Input value={deviceName} maxLength={128} onChange={(e) => setDeviceName(e.target.value)} aria-label="Name of this device" />
            <p className="text-[11px] text-muted-foreground">{nameError || "The name of this app in that computer's list of devices."}</p>
          </div>
        )}
      </div>
      {error && <p className="text-xs text-danger" role="alert">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onBack}>Back</Button>
        <Button disabled={!ready} onClick={() => void submit()}>{busy && <Spinner />} {newAddress ? "Add address" : saved ? "Pair again" : "Pair"}</Button>
      </div>
    </div>
  );
}

/** "Add a computer" (docs/add-computer.md): this computer, or another one by its `mobd link`. */
export function AddComputerDialog() {
  const { addOpen, addFor, addStart, machines, set, selectMachine } = useApp();
  const target = machines.find((m) => m.id === addFor);
  const { data: local } = useLocalStatus();
  const offerLocal = !target && !!local?.supported && !machines.some(isLocal);
  const first: Step = addStart ?? (offerLocal ? "choose" : "link");
  // Back to Choose only when the dialog started there.
  const fromChoose = first === "choose";
  const [step, setStep] = useState<Step>(first);
  const [link, setLink] = useState<PairLink | null>(null);
  const clipboardChecked = useRef(false);
  const checkClipboard = () => !clipboardChecked.current && (clipboardChecked.current = true);
  // Each opening starts over.
  const opened = useRef(false);
  useEffect(() => {
    if (addOpen && !opened.current) {
      setStep(first);
      setLink(null);
      clipboardChecked.current = false;
    }
    opened.current = addOpen;
  }, [addOpen, first]);
  const close = () => set({ addOpen: false, addFor: null, addStart: null });
  // Straight into the computer: it is listed, selected and ready for a chat.
  const done = (id: string) => {
    const name = useApp.getState().machines.find((m) => m.id === id)?.name;
    selectMachine(id);
    close();
    if (name) toast.success(`${name} is ready`);
  };

  return (
    <Dialog open={addOpen} onOpenChange={(o) => !o && close()}>
      <DialogContent className="w-[520px] max-w-[92vw] p-6" aria-describedby={undefined}>
        {step === "choose" && (
          <div className="grid gap-5">
            <Header title="Add a computer" description="Your agents work on the computer you add; Mob steers them from here." />
            <div className="grid grid-cols-2 gap-3">
              <ChoiceCard icon={<Laptop className="size-5" />} title="This computer" text="Chat with agents on this computer." onClick={() => setStep("local")} />
              <ChoiceCard icon={<Monitor className="size-5" />} title="Another computer" text="An office Mac or Linux machine." onClick={() => setStep("link")} />
            </div>
          </div>
        )}
        {step === "local" && (
          <div className="grid gap-4">
            <Header title="Start with this computer" onBack={fromChoose ? () => setStep("choose") : undefined} />
            <LocalSetup onDone={done} onCancel={close} />
          </div>
        )}
        {step === "link" && (
          <LinkStep machine={target} checkClipboard={checkClipboard} onBack={fromChoose ? () => setStep("choose") : undefined}
            onLink={(l) => { setLink(l); setStep("confirm"); }} />
        )}
        {step === "confirm" && link && (
          <ConfirmStep link={link} machine={target} onBack={() => setStep("link")} onPaired={done} />
        )}
      </DialogContent>
    </Dialog>
  );
}
