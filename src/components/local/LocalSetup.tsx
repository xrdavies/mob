import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Laptop } from "lucide-react";
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
export function LocalSetup({ onDone }: { onDone?: (id: string) => void }) {
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

  const action = status.running ? "Connect" : fresh ? "Install and set up" : configured ? "Start mobd and connect" : "Set up";
  return (
    <div className="grid gap-3 rounded-xl border bg-panel p-4 text-left">
      <div className="flex items-start gap-3">
        <Laptop className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 space-y-1">
          <p className="text-[13px] font-semibold">Work with this computer</p>
          <p className="text-[12px] text-muted-foreground">
            {status.running
              ? "mobd is running here. Connect this app to it to chat with your local agents."
              : status.binary
                ? "mobd is installed here but not running. Start it to chat with your local agents."
                : "Install mobd, the service that runs your agents, to chat with them on this computer. Phones and other computers can pair with it later."}
          </p>
        </div>
      </div>
      {(fresh || (!status.running && !configured)) && (
        <div className="grid gap-1.5">
          <Label htmlFor="local-workdir">Agents work in</Label>
          <Input id="local-workdir" value={dir} spellCheck={false} onChange={(e) => setWorkdir(e.target.value)} className="font-mono text-xs" />
          <p className="text-[11px] text-muted-foreground">Created if missing. You can change it later in Settings.</p>
        </div>
      )}
      <div className="flex items-center gap-2">
        <Button disabled={!!stage || (fresh && !dir.trim().startsWith("/"))} onClick={() => void run()}>
          {stage && <Spinner />} {stage || action}
        </Button>
      </div>
      {error && <p className="text-xs text-danger" role="alert">{error}</p>}
    </div>
  );
}
