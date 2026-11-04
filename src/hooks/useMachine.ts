import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { fetchDesktops, fetchHealth, fetchQueue, sessionDesktops, supports } from "@/api/client";
import type { CollabRequest, Desktops, Queue, Session, Task } from "@/api/types";
import { chat } from "@/hooks/useChat";
import { streamAuth } from "@/lib/auth";
import { applyDesktop, applyLevel, parseDesktop, parseDisk, parseMemory } from "@/lib/desktops";
import { EventStream } from "@/lib/sse";
import { baseUrl, needsPairing, type Machine } from "@/store/app";
import { log } from "@/store/log";

/** Polls /health while the machine is paired; a 401 marks it and stops polling. */
export function useHealth(machine: Machine | null | undefined) {
  const base = baseUrl(machine);
  return useQuery({
    queryKey: ["health", base],
    queryFn: () => fetchHealth(base),
    enabled: !!base && !needsPairing(machine),
    refetchInterval: 30_000,
    retry: false,
  });
}

export function useQueue(base: string, enabled: boolean) {
  return useQuery({ queryKey: ["queue", base], queryFn: () => fetchQueue(base), enabled: !!base && enabled });
}

/** Conversation desktops and the office computer's memory and disk (mobd with sessionDesktops). */
export function useDesktops(base: string, enabled: boolean, refetchInterval?: number) {
  return useQuery({
    queryKey: ["desktops", base],
    queryFn: () => fetchDesktops(base),
    enabled: !!base && enabled,
    refetchInterval,
  });
}

/** Subscribes to mobd's global stream: sidebar, queue and status stay live without polling. */
export function useMachineEvents(machine: Machine | null | undefined) {
  const qc = useQueryClient();
  const base = baseUrl(machine);
  const { data: health } = useHealth(machine);
  const live = supports(health, "events") && !needsPairing(machine);
  const desktops = sessionDesktops(health);
  useEffect(() => {
    if (!base || !live) return;
    // Resume via ?after=: mobd's CORS does not allow a Last-Event-ID header.
    const es = new EventStream(`${base}/events`, { ...streamAuth(base), resumeParam: "after" });
    const on = <T,>(type: string, fn: (data: T) => void) =>
      es.addEventListener(type, (raw) => {
        try {
          fn(JSON.parse(raw.data) as T);
        } catch (err) {
          log(`global event ${type} decode failed: ${String(err)}`, "error");
        }
      });
    on<Session>("session", (s) => chat.applySession(s));
    on<{ id: string }>("session.deleted", ({ id }) => chat.removeSession(id));
    on<Queue>("queue", (q) => {
      qc.setQueryData(["queue", base], q);
      chat.applyQueue(q);
    });
    on<Task>("task", (t) => chat.applyTask(t));
    on<CollabRequest>("collab", (r) => chat.applyRequest(r));
    // Machine settings changed on some device: the models and defaults offered come from /health.
    on<unknown>("settings", (v) => {
      qc.setQueryData(["settings", base], v);
      void qc.invalidateQueries({ queryKey: ["health", base] });
    });
    if (desktops) {
      const update = (fn: (d: Desktops | undefined) => Desktops) => qc.setQueryData<Desktops>(["desktops", base], fn);
      on<unknown>("desktop", (raw) => {
        const info = parseDesktop(raw);
        if (info) update((d) => applyDesktop(d, info));
      });
      on<unknown>("memory", (raw) => {
        const info = parseMemory(raw);
        if (info) update((d) => applyLevel(d, "memory", info));
      });
      on<unknown>("disk", (raw) => {
        const info = parseDisk(raw);
        if (info) update((d) => applyLevel(d, "disk", info));
      });
    }
    const refetch = () => {
      void qc.invalidateQueries({ queryKey: ["queue", base] });
      if (desktops) void qc.invalidateQueries({ queryKey: ["desktops", base] });
    };
    on<unknown>("reset", () => {
      log("global events reset; refreshing", "info");
      void chat.refresh();
      refetch();
    });
    // Snapshots may predate the subscription; refetch once it is open (also after a reconnect).
    es.onopen = refetch;
    return () => es.close();
  }, [base, live, desktops, qc]);
}
