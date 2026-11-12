import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Spinner } from "@/components/StatusIcon";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { connectLocal, defaultWorkdir, installLocal, localService, localStatus, setupLocal } from "@/store/local";

export function useLocalStatus() {
  return useQuery({ queryKey: ["local-status"], queryFn: localStatus, staleTime: 5_000, retry: false });
}

/**
 * "Set up this computer": installs mobd the official way when it is missing, starts it, and pairs
 * this Desktop with it (mobd docs/mob-desktop-local-mobd.md). An existing mobd is used as it is.
 * Renders nothing where Desktop cannot run a local mobd.
 */
export function LocalSetup({ onDone, onCancel }: { onDone?: (id: string) => void; onCancel?: () => void }) {
  const qc = useQueryClient();
  const { data: status, isLoading } = useLocalStatus();
  const [workdir, setWorkdir] = useState<string | null>(null);
  const [stage, setStage] = useState("");
  const [error, setError] = useState("");
  if (isLoading) return <p className="flex items-center justify-center gap-2 text-xs text-muted-foreground"><Spinner /> Checking this computer…</p>;
  if (!status?.supported) return null;
  const dir = workdir ?? defaultWorkdir(status);
  const fresh = !status.binary && !status.running;
  const configured = status.configured;

  const run = async () => {
    setError("");
    try {
      if (!status.running) {
        if (fresh) {
          setStage("Installing mobd");
          await installLocal(setStage);
        }
        if (fresh || !configured) {
          setStage("Starting mobd");
          await setupLocal(dir.trim());
        } else {
          // Installed and set up before (perhaps in a terminal): start it as it was, no login change.
          setStage("Starting mobd");
          await localService("start");
        }
      }
      setStage("Connecting");
      const id = await connectLocal();
      onDone?.(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStage("");
      void qc.invalidateQueries({ queryKey: ["local-status"] });
    }
  };

  const action = status.running ? "Connect" : fresh ? "Install and start" : "Start";
  const summary = status.running
    ? "mobd, the service that runs your agents, is already running here."
    : status.binary
      ? "mobd, the service that runs your agents, is installed here but stopped."
      : "Mob installs mobd, the service that runs your agents on this computer.";
  const workdirField = (fresh || (!status.running && !configured)) && (
    <div className="grid gap-1.5">
      <Label htmlFor="local-workdir">Agents work in</Label>
      <Input id="local-workdir" value={dir} spellCheck={false} onChange={(e) => setWorkdir(e.target.value)} className="font-mono text-xs" />
      <p className="text-[11px] text-muted-foreground">Created if missing; you can change it later.</p>
    </div>
  );
  const disabled = !!stage || (fresh && !dir.trim().startsWith("/"));
  return (
    <div className="grid gap-4 text-left">
      <p className="text-[12.5px] text-muted-foreground">{summary}</p>
      {workdirField}
      {error && <p className="text-xs text-danger" role="alert">{error}</p>}
      <div className="flex items-center justify-end gap-2">
        {onCancel && !stage && <Button variant="ghost" onClick={onCancel}>Cancel</Button>}
        <Button autoFocus disabled={disabled} onClick={() => void run()}>{stage ? <><Spinner /> {stage}…</> : action}</Button>
      </div>
    </div>
  );
}
