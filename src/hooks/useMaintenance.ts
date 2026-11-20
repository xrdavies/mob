import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { fetchConfig, fetchOperation, saveConfig, startMaintenance, supports } from "@/api/client";
import type { MaintenanceOp } from "@/api/types";
import { useHealth, useQueue } from "@/hooks/useMachine";
import { ApiError } from "@/lib/auth";
import { baseUrl, needsPairing, type Machine } from "@/store/app";
import { log } from "@/store/log";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A computer's config.json keys and its restart and upgrade (mobd docs/remote-maintenance.md, feature
 * "maintenance"). Applying waits for an idle computer: `tasks` counts running and queued ones (D6).
 */
export function useMaintenance(machine: Machine) {
  const qc = useQueryClient();
  const base = baseUrl(machine);
  const { data: health } = useHealth(machine);
  const supported = supports(health, "maintenance") && !needsPairing(machine);
  const config = useQuery({ queryKey: ["config", base], queryFn: () => fetchConfig(base), enabled: supported });
  const { data: queue } = useQueue(base, supported);
  const tasks = (queue?.running.length ?? 0) + (queue?.queued.length ?? 0);
  const [op, setOp] = useState<MaintenanceOp | null>(health?.maintenance ?? null);
  const [error, setError] = useState("");

  const refresh = () => {
    for (const key of ["config", "health", "settings", "queue"]) void qc.invalidateQueries({ queryKey: [key, base] });
  };

  /** Saves editable keys; true when saved. Errors per key come back as one line. */
  const save = async (changes: Record<string, unknown>): Promise<boolean> => {
    if (!config.data) return false;
    setError("");
    try {
      await saveConfig(base, config.data.rev, changes);
      void qc.invalidateQueries({ queryKey: ["config", base] });
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        void config.refetch();
        setError("Another device changed this first. It is reloaded; make your change again.");
      } else setError(err instanceof Error ? err.message : String(err));
      return false;
    }
  };

  /** Starts a restart or upgrade and follows it to the end; mobd is unreachable for a moment meanwhile. */
  const run = async (action: "restart" | "upgrade", version?: string) => {
    setError("");
    try {
      const { operationId } = await startMaintenance(base, action, version);
      log(`${machine.name}: ${action} ${operationId} started`);
      let last: MaintenanceOp = { id: operationId, action, state: "running", step: "preparing", startedAt: new Date().toISOString() };
      setOp(last);
      for (let i = 0; i < 400 && last.state === "running"; i++) {
        await sleep(1500);
        try {
          last = await fetchOperation(base, operationId);
          setOp(last);
        } catch {
          // Restarting: mobd does not answer for a few seconds.
        }
      }
      log(`${machine.name}: ${action} ${last.state}${last.error ? `: ${last.error}` : ""}`, last.state === "done" ? "info" : "error");
    } catch (err) {
      setError(err instanceof ApiError && err.code === "tasks_running" ? "Tasks are running; try again when they finish." : err instanceof Error ? err.message : String(err));
    } finally {
      refresh();
    }
  };

  return { supported, config: config.data, configError: config.error, tasks, op, error, save, run, busy: op?.state === "running" };
}

export const stepText: Record<string, string> = {
  preparing: "Preparing", checking: "Checking", swapping: "Installing", restarting: "Restarting", "rolling back": "Going back",
};

export function opText(op: MaintenanceOp): string {
  if (op.state === "running") return `${stepText[op.step ?? ""] ?? "Working"}…`;
  if (op.state === "done") return op.action === "upgrade" ? `Updated${op.version ? ` to ${op.version}` : ""}` : "Restarted";
  if (op.state === "rolled-back") return `Went back to the previous ${op.action === "upgrade" ? "version" : "settings"}: ${op.error ?? ""}`;
  return op.error || "Failed";
}
