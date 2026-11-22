import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, ChevronRight, Copy, Plus, RotateCw, X } from "lucide-react";
import { useEffect, useState, type ComponentProps } from "react";
import { fetchSettings, saveSettings } from "@/api/client";
import type { AgentOption, AgentStatus, SettingsView } from "@/api/types";
import { AgentAvatar } from "@/components/AgentAvatar";
import { Spinner } from "@/components/StatusIcon";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useHealth } from "@/hooks/useMachine";
import { opText, useMaintenance } from "@/hooks/useMaintenance";
import { ApiError } from "@/lib/auth";
import { addModel, newlyUnguarded, withAgent, type AgentEdit, type SettingsEdit } from "@/lib/turnSettings";
import { cn } from "@/lib/utils";
import { baseUrl, needsPairing, useApp, type Machine } from "@/store/app";
import { errorText, Group, Page, Row, Segmented } from "./ui";

function Select({ className, ...props }: ComponentProps<"select">) {
  return <select className={cn("h-8 max-w-[240px] rounded-md border bg-background px-2 text-[13px] outline-none focus-visible:border-accent", className)} {...props} />;
}

const PERMISSIONS: Record<AgentEdit["permissions"], string> = { approve: "Ask before commands and edits", bypass: "Run without asking" };

const stateText = (a?: AgentStatus) =>
  !a ? "" : a.state === "ready" ? "Ready" : a.state === "disabled" ? "Off" : a.state === "missing" ? "Not installed"
    : /log ?in|sign/i.test(a.detail ?? "") ? "Not signed in" : "Not working";

/** Restart to apply config.json changes: only while no task runs (mobd remote-maintenance D6). */
export function RestartBar({ m, name }: { m: ReturnType<typeof useMaintenance>; name: string }) {
  if (!m.config?.pendingRestart && !m.op) return null;
  const running = m.op?.state === "running";
  const failed = m.op && (m.op.state === "failed" || m.op.state === "rolled-back");
  return (
    <div className={cn("flex items-center gap-2 rounded-[10px] border px-3 py-2 text-xs",
      failed ? "border-danger/40 bg-danger/5" : m.config?.pendingRestart ? "border-warning/50 bg-warning/[0.07]" : "bg-background")}>
      <span className="min-w-0 flex-1">
        {m.op && (running || !m.config?.pendingRestart) ? opText(m.op)
          : `Restart mobd on ${name} to apply${m.tasks ? ` · ${m.tasks} task${m.tasks > 1 ? "s" : ""} running` : ""}`}
      </span>
      {m.config?.pendingRestart && m.config.canRestart !== false && (
        <Button size="sm" disabled={running || m.tasks > 0} onClick={() => void m.run("restart")}>
          {running ? <Spinner className="border-accent-foreground border-t-transparent" /> : <RotateCw className="size-3.5" />} Restart to apply
        </Button>
      )}
    </div>
  );
}

/** The value config.json will apply (shown while a restart is pending), else the running one. */
function pendingValue(m: ReturnType<typeof useMaintenance>, name: string, o: AgentOption): unknown {
  const section = (m.config?.values.agents as Record<string, Record<string, unknown>> | undefined)?.[name];
  return section?.[o.key] ?? o.value;
}

/** One of an agent's options from mobd (feature agentOptions), drawn by its type and saved to config.json. */
function OptionRow({ m, name, o }: { m: ReturnType<typeof useMaintenance>; name: string; o: AgentOption }) {
  const key = `agents.${name}.${o.key}`;
  const [draft, setDraft] = useState<string | null>(null);
  const canEdit = !!m.config && m.config.editable.includes(key) && !m.config.overridden.includes(key) && !o.overridden;
  const value = pendingValue(m, name, o);
  const detail = o.overridden ? `${o.help ?? ""} Set on the computer; change it there.`.trim() : o.help;
  const save = (v: unknown) => canEdit && void m.save({ [key]: v });
  if (o.type === "bool") {
    return <Row label={o.label} detail={detail}><Switch checked={value === true} disabled={!canEdit} aria-label={o.label} onCheckedChange={save} /></Row>;
  }
  if (o.type === "choice" && o.choices?.length) {
    return (
      <Row label={o.label} detail={detail}>
        {o.choices.length <= 3
          ? <Segmented label={o.label} value={String(value ?? "")} onChange={save} options={o.choices} />
          : <Select value={String(value ?? "")} disabled={!canEdit} onChange={(e) => save(e.target.value)}>
              {o.choices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </Select>}
      </Row>
    );
  }
  const shown = String(value ?? "");
  return (
    <Row label={o.label} detail={draft === null ? <>{detail && <>{detail}<br /></>}<span className="font-mono">{shown || "Not set"}</span></> : detail}>
      {draft === null ? (
        <IconButton label={`Change ${o.label.toLowerCase()}`} disabled={!canEdit} onClick={() => setDraft(shown)}><ChevronRight /></IconButton>
      ) : (
        <form className="flex gap-1.5" onSubmit={(e) => {
          e.preventDefault();
          const v = draft.trim();
          void m.save({ [key]: !v ? null : o.type === "number" ? Number(v) : v }).then((ok) => ok && setDraft(null));
        }}>
          <Input autoFocus value={draft} spellCheck={false} inputMode={o.type === "number" ? "decimal" : undefined}
            className="h-8 w-64 font-mono text-xs" onChange={(e) => setDraft(e.target.value)} />
          <Button size="sm" type="submit">Save</Button>
          <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
        </form>
      )}
    </Row>
  );
}

/** The program row and Claude's settings source, for a mobd without agentOptions (flat config keys). */
function LegacyProgramRows({ m, name, status }: { m: ReturnType<typeof useMaintenance>; name: string; status?: AgentStatus }) {
  const [program, setProgram] = useState<string | null>(null);
  const binKey = `${name}Bin`;
  const editable = (key: string) => !!m.config && m.config.editable.includes(key) && !m.config.overridden.includes(key);
  const effectiveBin = String(m.config?.effective[binKey] ?? status?.bin ?? "");
  return (
    <>
      <Row label="Program" detail={program === null ? <span className="font-mono">{effectiveBin || "Not found"}</span> : undefined}>
        {program === null ? (
          <IconButton label="Change program" disabled={!editable(binKey)} onClick={() => setProgram(String(m.config?.values[binKey] ?? effectiveBin))}>
            <ChevronRight />
          </IconButton>
        ) : (
          <form className="flex gap-1.5" onSubmit={(e) => {
            e.preventDefault();
            void m.save({ [binKey]: program.trim() || null }).then((ok) => ok && setProgram(null));
          }}>
            <Input autoFocus value={program} spellCheck={false} className="h-8 w-64 font-mono text-xs" onChange={(e) => setProgram(e.target.value)} />
            <Button size="sm" type="submit">Save</Button>
            <Button size="sm" variant="ghost" onClick={() => setProgram(null)}>Cancel</Button>
          </form>
        )}
      </Row>
      {name === "claude" && (
        <Row label="Claude settings it loads" detail="Your personal ~/.claude settings, or only the project's">
          <Segmented label="Claude settings it loads" value={String(m.config?.effective.claudeSettingSources ?? "project")}
            onChange={(v) => editable("claudeSettingSources") && void m.save({ claudeSettingSources: v })}
            options={[{ value: "project", label: "Project" }, { value: "all", label: "All" }]} />
        </Row>
      )}
    </>
  );
}

function useSettingsEdit(machine: Machine) {
  const base = baseUrl(machine);
  const qc = useQueryClient();
  const { data: view, error, refetch } = useQuery({ queryKey: ["settings", base], queryFn: () => fetchSettings(base), enabled: !!base && !needsPairing(machine) });
  const save = async (next: SettingsEdit): Promise<string> => {
    try {
      const saved = await saveSettings(base, next);
      qc.setQueryData(["settings", base], saved);
      void qc.invalidateQueries({ queryKey: ["health", base] });
      return "";
    } catch (err) {
      if (err instanceof ApiError && err.code === "settings_changed") {
        await refetch();
        return "Another device changed these settings. They are reloaded; make your change again.";
      }
      return errorText(err);
    }
  };
  return { view, error, save };
}

/**
 * One agent: models, defaults and permissions (settings.json, applied at once) while it is on, and its
 * config.json options (applied on restart), drawn from mobd's list or, from an older mobd, the program row.
 */
function AgentPage({ machine, name, view, onBack, m, status }: {
  machine: Machine; name: string; view: SettingsView; onBack: () => void; m: ReturnType<typeof useMaintenance>; status?: AgentStatus;
}) {
  const { save } = useSettingsEdit(machine);
  const [edit, setEdit] = useState<SettingsEdit>(() => structuredClone(view.settings));
  const [adding, setAdding] = useState("");
  const [state, setState] = useState<{ kind: "idle" | "saving" | "saved" | "confirm" | "error"; text?: string }>({ kind: "idle" });
  useEffect(() => setEdit(structuredClone(view.settings)), [view.settings.rev]); // eslint-disable-line react-hooks/exhaustive-deps
  const a = edit.agents[name];
  const info = view.agents[name];
  const label = info?.label ?? status?.label ?? name;
  const changed = JSON.stringify(edit) !== JSON.stringify(view.settings);
  const commit = async (confirmed = false) => {
    if (newlyUnguarded(view.settings, edit).length && !confirmed) return setState({ kind: "confirm" });
    setState({ kind: "saving" });
    const err = await save(edit);
    setState(err ? { kind: "error", text: err } : { kind: "saved" });
    if (!err) setTimeout(() => setState((s) => (s.kind === "saved" ? { kind: "idle" } : s)), 1500);
  };
  const agentDefault = (v?: string) => (v ? `Agent's default (${v})` : "Agent's default");
  const suggestions = (info?.agentModels ?? []).filter((x) => !a?.models.includes(x));

  return (
    <Page title={
      <span className="flex items-center gap-2">
        <IconButton label="All agents" onClick={onBack}><ArrowLeft /></IconButton>
        <AgentAvatar runner={name} size="lg" />
        <span className="grid">
          <span>{label}</span>
          <span className="text-xs font-normal text-muted-foreground">{stateText(status)}{status?.version && ` · ${status.version}`}</span>
        </span>
      </span>
    }>
      {a && info ? (
        <>
        <Group title="Models" footer="New chats start with these; each chat keeps its own.">
          <div className="grid gap-2 px-3 py-2.5">
            <div className="flex flex-wrap gap-1.5">
              {a.models.map((x) => (
                <span key={x} className="flex items-center gap-1 rounded-full border bg-panel py-0.5 pl-2.5 pr-1 font-mono text-[12px]">
                  {x}
                  <button type="button" aria-label={`Remove ${x}`} className="rounded-full p-0.5 hover:bg-muted"
                    onClick={() => setEdit(withAgent(edit, name, { models: a.models.filter((y) => y !== x), ...(a.defaultModel === x ? { defaultModel: "" } : {}) }))}>
                    <X className="size-3" />
                  </button>
                </span>
              ))}
              {!a.models.length && <span className="text-xs text-muted-foreground">
                {suggestions.length ? `None listed: chats offer the ${suggestions.length === 1 ? "model" : `${suggestions.length} models`} ${label} reports.` : "None listed: chats use the agent's default."}
              </span>}
            </div>
            <form className="flex gap-1.5" onSubmit={(e) => {
              e.preventDefault();
              const next = addModel(a.models, adding);
              if (typeof next === "string") return setState({ kind: "error", text: next });
              setEdit(withAgent(edit, name, { models: next }));
              setAdding("");
            }}>
              <Input value={adding} placeholder="Model ID" className="h-8 font-mono" list={suggestions.length ? `models-${name}` : undefined}
                onChange={(e) => setAdding(e.target.value)} />
              {suggestions.length > 0 && <datalist id={`models-${name}`}>{suggestions.map((x) => <option key={x} value={x} />)}</datalist>}
              <IconButton label="Add model" type="submit" disabled={!adding.trim()}><Plus /></IconButton>
            </form>
          </div>
          <Row label="Default model">
            <Select value={a.defaultModel} onChange={(e) => setEdit(withAgent(edit, name, { defaultModel: e.target.value }))}>
              <option value="">{agentDefault(info.agentDefaultModel)}</option>
              {a.models.map((x) => <option key={x} value={x}>{x}</option>)}
            </Select>
          </Row>
          {(info.efforts ?? []).length > 0 && <Row label="Default effort">
            <Select value={a.defaultEffort} onChange={(e) => setEdit(withAgent(edit, name, { defaultEffort: e.target.value }))}>
              <option value="">{agentDefault(info.agentDefaultEffort)}</option>
              {(info.efforts ?? []).map((x) => <option key={x} value={x}>{x}</option>)}
            </Select>
          </Row>}
        </Group>
        <Group title="Permissions">
          {info.approvals === false ? (
            <Row label="Commands and file edits" detail={`${label} decides on its own and cannot ask you first.`}>
              <span className="text-xs text-muted-foreground">Runs without asking</span>
            </Row>
          ) : (
            <Row label="Commands and file edits">
              <Segmented<AgentEdit["permissions"]> label="Permissions" value={a.permissions} onChange={(v) => setEdit(withAgent(edit, name, { permissions: v }))}
                options={[{ value: "approve", label: "Ask first" }, { value: "bypass", label: "Run without asking" }]} />
            </Row>
          )}
        </Group>
        {state.kind === "confirm" && (
          <div className="grid gap-2 rounded-[10px] border border-warning/50 bg-warning/10 p-3 text-xs">
            <p><strong>{label}</strong> will run commands and edit files on {machine.name} without asking you first.</p>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => void commit(true)}>Allow and save</Button>
              <Button size="sm" variant="ghost" onClick={() => setState({ kind: "idle" })}>Cancel</Button>
            </div>
          </div>
        )}
        <div className="flex items-center gap-2">
          <Button disabled={!changed || state.kind === "saving" || state.kind === "saved"} onClick={() => void commit()}>
            {state.kind === "saving" ? <><Spinner /> Saving…</> : state.kind === "saved" ? <><Check className="size-3.5" /> Saved</> : "Save"}
          </Button>
          <Button variant="ghost" disabled={!changed} onClick={() => { setEdit(structuredClone(view.settings)); setState({ kind: "idle" }); }}>Discard</Button>
          {state.kind === "error" && <span className="text-xs text-danger">{state.text}</span>}
        </div>
        </>
      ) : (
        <p className="px-1 text-xs text-muted-foreground">Turn {label} on to choose its models and permissions.</p>
      )}

      <Group title="Program" footer={!m.supported ? `Update mobd on ${machine.name} to change these here.`
        : status?.protocol === "acp" ? `${label} is connected through the Agent Client Protocol.` : undefined}>
        {status?.options ? status.options.map((o) => <OptionRow key={o.key} m={m} name={name} o={o} />) : <LegacyProgramRows m={m} name={name} status={status} />}
        {status?.detail && (
          <Row label="Check" detail={status.detail}>
            <span className={cn("text-xs", status.state === "ready" ? "text-success" : "text-warning")}>{stateText(status)}</span>
          </Row>
        )}
      </Group>
      {m.error && <p className="text-xs text-danger">{m.error}</p>}
      <RestartBar m={m} name={machine.name} />
    </Page>
  );
}

/**
 * A computer's agents (docs/desktop-redesign, Agents tab): the list with each agent's state and on/off,
 * the default for new chats, and a page per agent. Works for any paired computer.
 */
export function AgentsTab({ machine }: { machine: Machine }) {
  const focus = useApp((s) => s.settingsFocus);
  const { data: health } = useHealth(machine);
  const { view, error, save } = useSettingsEdit(machine);
  const m = useMaintenance(machine);
  const [open, setOpen] = useState<string | null>(null);
  const [saveError, setSaveError] = useState("");
  // Opened from a chat's model menu: that agent's page.
  useEffect(() => {
    if (focus === null) return;
    if (focus) setOpen(focus);
    useApp.getState().set({ settingsFocus: null });
  }, [focus]);

  if (needsPairing(machine)) return <p className="text-xs text-muted-foreground">Pair {machine.name} again to change its agents.</p>;
  if (error) return <p className="text-xs text-danger">{error instanceof TypeError ? `${machine.name} is not reachable.` : errorText(error)}</p>;
  if (!view) return <Spinner />;

  const statuses = new Map((health?.agents ?? view.installed ?? []).map((a) => [a.name, a]));
  if (open && (view.agents[open] || statuses.get(open)?.options)) {
    return <AgentPage machine={machine} name={open} view={view} m={m} status={statuses.get(open)} onBack={() => setOpen(null)} />;
  }
  const runners = (m.config?.effective.runners as string[] | undefined) ?? [...statuses.values()].filter((a) => a.enabled).map((a) => a.name);
  const canToggle = !!m.config && m.config.editable.includes("runners") && !m.config.overridden.includes("runners");
  const names = [...new Set([...Object.keys(view.agents), ...statuses.keys()])];

  return (
    <div className="grid content-start gap-5">
      <Group title="Agents" footer={!m.supported ? `Update mobd on ${machine.name} to turn agents on or off here.` : undefined}>
        {names.map((name) => {
          const s = view.settings.agents[name];
          const st = statuses.get(name);
          const label = view.agents[name]?.label ?? st?.label ?? name;
          const page = !!view.agents[name] || !!st?.options;
          const on = runners.includes(name);
          const perms = view.agents[name]?.approvals === false ? PERMISSIONS.bypass : s && PERMISSIONS[s.permissions];
          const sub = s ? [s.defaultModel || "Default model", s.defaultEffort, perms].filter(Boolean).join(" · ") : st?.detail;
          return (
            <div key={name} className="flex min-h-12 items-center gap-3 px-3 py-2">
              <AgentAvatar runner={name} size="lg" />
              <button type="button" disabled={!page} onClick={() => setOpen(name)} className="grid min-w-0 flex-1 text-left disabled:cursor-default">
                <span className="text-[13px] font-medium">{label}</span>
                <span className="truncate text-[11.5px] text-muted-foreground">{sub}</span>
              </button>
              <span className={cn("shrink-0 text-xs", st?.state === "ready" ? "text-success" : "text-muted-foreground")}>{stateText(st)}</span>
              <Switch checked={on} disabled={!canToggle || (!on && st?.state === "missing")} aria-label={`${label} on`}
                onCheckedChange={(v) => {
                  const next = v ? [...runners, name] : runners.filter((r) => r !== name);
                  if (next.length) void m.save({ runners: next });
                }} />
              {page && <IconButton label={`${label} settings`} onClick={() => setOpen(name)}><ChevronRight /></IconButton>}
            </div>
          );
        })}
      </Group>
      {[...statuses.values()].filter((a) => a.state === "missing" && a.install).map((a) => (
        <Group key={a.name} title={`Install ${a.label}`}>
          <Row label={<code className="font-mono text-xs">{a.install}</code>}>
            <IconButton label="Copy" onClick={() => void navigator.clipboard.writeText(a.install!)}><Copy /></IconButton>
          </Row>
        </Group>
      ))}
      <Group title="New chats">
        <Row label="Default agent">
          <Select value={view.settings.defaultAgent} onChange={(e) => {
            setSaveError("");
            void save({ ...view.settings, defaultAgent: e.target.value }).then(setSaveError);
          }}>
            {Object.keys(view.agents).filter((n) => runners.includes(n) || n === view.settings.defaultAgent).map((n) => <option key={n} value={n}>{view.agents[n]!.label}</option>)}
          </Select>
        </Row>
      </Group>
      {(saveError || m.error) && <p className="text-xs text-danger">{saveError || m.error}</p>}
      <RestartBar m={m} name={machine.name} />
    </div>
  );
}
