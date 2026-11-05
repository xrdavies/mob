import { ArrowUp, Bot, Brain, ChevronDown, Cpu, Paperclip, Square, X } from "lucide-react";
import { MentionPicker } from "./MentionPicker";
import { mentionAt, mentionCandidates, mentionToken, resolveMentions } from "@/lib/collab";
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { runnerFor, supports, uploadImage } from "@/api/client";
import type { Health, Session } from "@/api/types";
import { Spinner } from "@/components/StatusIcon";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/menu";
import { Tooltip } from "@/components/ui/tooltip";
import { useChat } from "@/hooks/useChat";
import { imeGuard } from "@/lib/ime";
import { menuModels, shownChoice } from "@/lib/turnSettings";
import { cn, defaultLabel } from "@/lib/utils";
import { useApp } from "@/store/app";
import { useComposer } from "@/store/composer";

interface Attachment {
  key: string;
  name: string;
  preview: string;
  id?: string;
  error?: string;
}

const MAX_ATTACHMENTS = 10;

function Picker({ icon: Icon, label, value, options, onChange, placeholder, onEdit }: {
  icon: typeof Cpu;
  label: string;
  value: string;
  options: string[];
  placeholder: string;
  onChange: (v: string) => void;
  /** Adds an "Edit models…" entry that opens the machine's agent settings. */
  onEdit?: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-1 px-2 text-muted-foreground" aria-label={label}>
          <Icon className="size-3.5" />
          {value || placeholder}
          <ChevronDown className="size-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top">
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          <DropdownMenuRadioItem value="">{placeholder}</DropdownMenuRadioItem>
          {options.map((o) => (
            <DropdownMenuRadioItem key={o} value={o}>
              {o}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {onEdit && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onEdit}>Edit models…</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function Composer({ machineId, machineName, health }: { machineId: string; machineName: string; health?: Health }) {
  const chat = useChat();
  const { text, setText, focusTick } = useComposer();
  const [caret, setCaret] = useState(0);
  const [pickerActive, setPickerActive] = useState(0);
  /** Where the @ word starts that Escape closed the picker for; typing elsewhere opens it again. */
  const [pickerClosed, setPickerClosed] = useState<number | null>(null);
  const [mentionError, setMentionError] = useState("");
  const machinePrefs = useApp((s) => s.turnPrefs[machineId]) ?? {};
  const setTurnPrefs = useApp((s) => s.setTurnPrefs);
  const clearTurnPrefs = useApp((s) => s.clearTurnPrefs);
  const openSettings = useApp((s) => s.openSettings);
  const runners = (health?.runners ?? []).filter((r) => r.available);
  // A conversation keeps its runner; a new chat uses the picked one if it is still available.
  const picked = chat.sessionId ? chat.session?.runner : runners.find((r) => r.name === machinePrefs.runner)?.name;
  const runnerKey = `${machineId}/${picked ?? health?.runner ?? ""}`;
  const prefs = useApp((s) => s.turnPrefs[runnerKey]) ?? {};
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const [ime] = useState(imeGuard);
  const input = useRef<HTMLTextAreaElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const runner = runnerFor(health, picked);
  const canUpload = supports(health, "uploads") && (runner?.images ?? true);
  const canOptions = supports(health, "taskOptions");
  const models = runner?.models ?? [];
  const efforts = runner?.efforts ?? [];
  // An open chat shows and changes its conversation's model and effort (shared by every device);
  // a new chat keeps a draft on this device until it exists.
  const shown = shownChoice(chat.sessionId ? chat.session : null, prefs);
  const choose = (patch: { model?: string; effort?: string }) => {
    if (chat.sessionId) void chat.patchSession(chat.sessionId, patch);
    else setTurnPrefs(runnerKey, patch);
  };
  const uploading = attachments.some((a) => !a.id && !a.error);
  const ready = attachments.filter((a) => a.id);
  const busy = chat.busy;
  // While a turn runs, a runner that supports it takes extra messages.
  const canSteer = chat.currentTask?.status === "running" && !!runner?.steer && supports(health, "steer") && !chat.cancelling;

  useEffect(() => {
    input.current?.focus();
  }, [focusTick, chat.sessionId, machineId]);

  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  function addFiles(files: File[]) {
    if (!canUpload) return;
    const images = files.filter((f) => f.type.startsWith("image/")).slice(0, MAX_ATTACHMENTS - attachments.length);
    for (const f of images) {
      const key = `${f.name}-${f.size}-${Math.random()}`;
      setAttachments((list) => [...list, { key, name: f.name, preview: URL.createObjectURL(f) }]);
      uploadImage(chat.baseUrl, f)
        .then((u) => setAttachments((list) => list.map((a) => (a.key === key ? { ...a, id: u.id } : a))))
        .catch((err) => setAttachments((list) => list.map((a) => (a.key === key ? { ...a, error: String(err.message ?? err) } : a))));
    }
  }

  /** Replaces the @ word at the caret with the agent's token (handle, else short ID). */
  function insertMention(agent: Session) {
    const m = mentionAt(text, caret);
    if (!m || agent.archived) return;
    const token = mentionToken(agent);
    const next = text.slice(0, m.start) + token + " " + text.slice(caret);
    setText(next);
    setPickerActive(0);
    const at = m.start + token.length + 1;
    setCaret(at);
    requestAnimationFrame(() => input.current?.setSelectionRange(at, at));
  }

  async function send() {
    const prompt = text.trim();
    if (canSteer && prompt) {
      if (await chat.steer(prompt) && useComposer.getState().text.trim() === prompt) setText("");
      return;
    }
    if (!prompt || !chat.canSend || uploading) return;
    const mentioned = chat.collab ? resolveMentions(prompt, chat.sessions, chat.sessionId) : { ids: [], archived: [] };
    if (mentioned.archived.length) {
      setMentionError(`${mentioned.archived.join(", ")} ${mentioned.archived.length > 1 ? "are" : "is"} archived. Unarchive it to ask it, or move its handle.`);
      return;
    }
    setMentionError("");
    const newChat = !chat.sessionId;
    const ok = await chat.submit(prompt, {
      // Only a new chat names them (they become its settings); later turns use the conversation's.
      ...(canOptions && newChat ? { model: shown.model || undefined, effort: efforts.includes(shown.effort) ? shown.effort : undefined } : {}),
      attachments: ready.map((a) => a.id!),
      runner: newChat ? runner?.name : undefined,
      mentions: mentioned.ids,
    });
    if (ok && newChat) {
      // The conversation has its settings now; the next new chat starts from the defaults.
      clearTurnPrefs(runnerKey);
      clearTurnPrefs(machineId);
    }
    if (ok) {
      if (useComposer.getState().text.trim() === prompt) setText("");
      for (const a of attachments) URL.revokeObjectURL(a.preview);
      setAttachments([]);
    }
  }

  return (
    <div className="mx-auto w-full max-w-[760px] px-6 pb-4">
      <div
        className={cn(
          "relative rounded-[14px] border bg-background shadow-panel transition-colors focus-within:border-accent/50",
          dragging && "border-accent bg-accent-soft",
        )}
        onDragOver={(e: DragEvent) => {
          if (!canUpload) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e: DragEvent) => {
          e.preventDefault();
          setDragging(false);
          addFiles([...e.dataTransfer.files]);
        }}
      >
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-3">
            {attachments.map((a) => (
              <div key={a.key} className="group relative">
                <img src={a.preview} alt={a.name} className={cn("size-14 rounded-lg border object-cover", (!a.id || a.error) && "opacity-50")} />
                {!a.id && !a.error && <Spinner className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2" />}
                {a.error && (
                  <Tooltip content={a.error}>
                    <span className="absolute inset-x-0 bottom-0 rounded-b-lg bg-danger/90 text-center text-[10px] text-white">failed</span>
                  </Tooltip>
                )}
                <button
                  type="button"
                  aria-label={`Remove ${a.name}`}
                  onClick={() => {
                    URL.revokeObjectURL(a.preview);
                    setAttachments((list) => list.filter((x) => x.key !== a.key));
                  }}
                  className="absolute -right-1.5 -top-1.5 hidden size-4.5 items-center justify-center rounded-full bg-foreground text-background group-hover:flex"
                >
                  <X className="size-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        {chat.collab && mentionAt(text, caret) && mentionAt(text, caret)?.start !== pickerClosed && (
          <MentionPicker
            sessions={chat.sessions}
            query={mentionAt(text, caret)?.query ?? ""}
            self={chat.sessionId}
            active={pickerActive}
            onPick={(agent) => insertMention(agent)}
          />
        )}
        {mentionError && <p role="alert" className="px-3.5 pt-2 text-xs text-danger">{mentionError}</p>}
        <textarea
          ref={input}
          rows={1}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart ?? 0);
            setPickerActive(0);
            // Removing the @ word Escape closed the picker for lets a new one open it.
            if (!mentionAt(e.target.value, e.target.selectionStart ?? 0)) setPickerClosed(null);
          }}
          onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
          onPaste={(e: ClipboardEvent) => {
            const files = [...e.clipboardData.files];
            if (files.length) {
              e.preventDefault();
              addFiles(files);
            }
          }}
          onCompositionStart={ime.start}
          onCompositionEnd={ime.end}
          onKeyDown={(e) => {
            const m = mentionAt(text, caret);
            const candidates = m && chat.collab && m.start !== pickerClosed ? mentionCandidates(chat.sessions, m.query, chat.sessionId) : [];
            if (m && candidates.length > 0) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const step = e.key === "ArrowDown" ? 1 : -1;
                setPickerActive((n) => (n + step + candidates.length) % candidates.length);
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                const picked = candidates[pickerActive];
                if (picked && !picked.archived) insertMention(picked);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setPickerActive(0);
                setPickerClosed(m.start);
                return;
              }
            }
            // Enter that commits Pinyin or another input method must not send.
            if (e.key === "Enter" && !e.shiftKey && !ime.owns(e.nativeEvent)) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={canSteer ? "Add to what the agent is doing… (↵ sends to the running turn)" : busy ? "The agent is working… you can draft the next message" : `Ask Mob to do something on ${machineName}…`}
          aria-label="Task prompt"
          className="block max-h-60 min-h-[44px] w-full resize-none bg-transparent px-3.5 pb-1 pt-3 text-[14px] leading-relaxed outline-none placeholder:text-muted-foreground/70"
        />
        <div className="flex items-center gap-0.5 px-2 pb-2">
          <input
            ref={file}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            hidden
            onChange={(e) => {
              addFiles([...(e.target.files ?? [])]);
              e.target.value = "";
            }}
          />
          <Tooltip content={canUpload ? "Attach images" : "Update office mobd to attach images"} side="top">
            <span>
              <Button variant="ghost" size="icon-sm" aria-label="Attach images" disabled={!canUpload || attachments.length >= MAX_ATTACHMENTS} onClick={() => file.current?.click()}>
                <Paperclip />
              </Button>
            </span>
          </Tooltip>
          {runners.length > 1 && !chat.sessionId && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="gap-1 px-2 text-muted-foreground" aria-label="Agent">
                  <Bot className="size-3.5" />
                  {runner?.label ?? "Agent"}
                  <ChevronDown className="size-3 opacity-60" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="top">
                <DropdownMenuLabel>Agent for this chat</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={runner?.name ?? ""} onValueChange={(name) => setTurnPrefs(machineId, { runner: name })}>
                  {runners.map((r) => (
                    <DropdownMenuRadioItem key={r.name} value={r.name}>{r.label}</DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {chat.sessionId && runner && (health?.runners?.length ?? 0) > 1 && (
            <Tooltip content="A conversation keeps its agent. Start a new chat to switch." side="top">
              <span className="flex h-7 items-center gap-1 px-2 text-xs text-muted-foreground"><Bot className="size-3.5" />{runner.label}</span>
            </Tooltip>
          )}
          {canOptions && (
            <>
              <Picker icon={Cpu} label="Model" placeholder={defaultLabel("model", runner?.defaultModel)} value={shown.model} options={menuModels(models, shown.model)}
                onChange={(model) => choose({ model })}
                onEdit={() => openSettings("machines", machineId, runner?.name ?? "")} />
              <Picker icon={Brain} label="Reasoning effort" placeholder={defaultLabel("effort", runner?.defaultEffort)} value={shown.effort} options={efforts}
                onChange={(effort) => choose({ effort })} />
            </>
          )}
          <div className="flex-1" />
          {canSteer && (
            <Tooltip content="Send to the running turn" side="top">
              <Button size="icon" variant="secondary" className="mr-1 size-8 rounded-full" aria-label="Send to running turn" disabled={!text.trim()} onClick={() => void send()}>
                <ArrowUp className="size-4" strokeWidth={2.5} />
              </Button>
            </Tooltip>
          )}
          {busy ? (
            <Tooltip content="Stop" side="top">
              <Button size="icon" className="size-8 rounded-full" aria-label="Stop" disabled={chat.cancelling} onClick={() => void chat.cancel()}>
                {chat.cancelling ? <Spinner className="border-accent-foreground border-t-transparent" /> : <Square className="size-3 fill-current" />}
              </Button>
            </Tooltip>
          ) : (
            <Button
              size="icon"
              className="size-8 rounded-full"
              aria-label="Send"
              disabled={!text.trim() || !chat.canSend || uploading}
              onClick={() => void send()}
            >
              {chat.submitting ? <Spinner className="border-accent-foreground border-t-transparent" /> : <ArrowUp className="size-4" strokeWidth={2.5} />}
            </Button>
          )}
        </div>
      </div>
      <p className="mt-1.5 text-center text-[11px] text-muted-foreground/70">
        ↵ send · ⇧↵ new line · the agent controls the office computer
      </p>
    </div>
  );
}
