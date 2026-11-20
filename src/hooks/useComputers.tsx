import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { fetchSessions, supports } from "@/api/client";
import type { Session } from "@/api/types";
import { useChat } from "@/hooks/useChat";
import { useHealth } from "@/hooks/useMachine";
import { streamAuth } from "@/lib/auth";
import { applySessionEvent, needsYou, removeSession, type Waiting } from "@/lib/computers";
import { EventStream } from "@/lib/sse";
import { baseUrl, needsPairing, useApp, type Machine } from "@/store/app";
import { log } from "@/store/log";

// Every computer's conversations (docs/desktop-redesign D2, D4). The open computer's come from the Chat
// controller; each other paired computer's from GET /sessions, kept current by its own /events stream.

const sessionsQuery = (base: string, enabled: boolean) => ({
  queryKey: ["sessions", base],
  queryFn: () => fetchSessions(base),
  enabled: !!base && enabled,
  staleTime: Infinity,
  retry: false,
});

/** Keeps a computer that is not open current: one stream for its session summaries. */
function Watcher({ machine }: { machine: Machine }) {
  const qc = useQueryClient();
  const base = baseUrl(machine);
  const { data: health } = useHealth(machine);
  const live = supports(health, "events");
  useQuery(sessionsQuery(base, true));
  useEffect(() => {
    if (!base || !live) return;
    const key = ["sessions", base];
    const es = new EventStream(`${base}/events`, { ...streamAuth(base), resumeParam: "after" });
    es.addEventListener("session", (raw) => {
      try {
        const s = JSON.parse(raw.data) as Session;
        qc.setQueryData<Session[]>(key, (list) => applySessionEvent(list, { ...s, messages: undefined }));
      } catch (err) {
        log(`${machine.name}: session event decode failed: ${String(err)}`, "error");
      }
    });
    es.addEventListener("session.deleted", (raw) => {
      try {
        const { id } = JSON.parse(raw.data) as { id: string };
        qc.setQueryData<Session[]>(key, (list) => removeSession(list, id));
      } catch { /* ignored */ }
    });
    // A gap in the stream: the list is read again.
    const refetch = () => void qc.invalidateQueries({ queryKey: key });
    es.addEventListener("reset", refetch);
    es.onopen = refetch;
    return () => es.close();
  }, [base, live, qc, machine.name]);
  return null;
}

/** Mounted once: a watcher for every paired computer that is not open. */
export function ComputerWatchers() {
  const machines = useApp((s) => s.machines);
  const activeId = useApp((s) => s.activeMachineId);
  return <>{machines.filter((m) => m.id !== activeId && !needsPairing(m)).map((m) => <Watcher key={m.id} machine={m} />)}</>;
}

/** A computer's conversations: the open one's live list, or the watched one's. */
export function useComputerSessions(machine: Machine): { sessions: Session[]; loading: boolean } {
  const activeId = useApp((s) => s.activeMachineId);
  const chatState = useChat();
  const active = machine.id === activeId;
  const q = useQuery(sessionsQuery(baseUrl(machine), !active && !needsPairing(machine)));
  if (active) return { sessions: chatState.sessions, loading: chatState.loading && !chatState.sessions.length };
  return { sessions: q.data ?? [], loading: q.isLoading };
}

/** Every computer's conversations: watched ones from their cache, the open one from Chat. */
export function useAllSessions(): { machineId: string; sessions: Session[] }[] {
  const machines = useApp((s) => s.machines);
  const activeId = useApp((s) => s.activeMachineId);
  const chatState = useChat();
  const others = machines.filter((m) => m.id !== activeId && !needsPairing(m));
  const results = useQueries({ queries: others.map((m) => sessionsQuery(baseUrl(m), true)) });
  const lists = others.map((m, i) => ({ machineId: m.id, sessions: results[i]?.data ?? [] }));
  if (activeId && chatState.machineId === activeId) lists.unshift({ machineId: activeId, sessions: chatState.sessions });
  return lists;
}

/** Conversations waiting for the user on every computer, the longest waiting first. */
export function useNeedsYou(): Waiting[] {
  return needsYou(useAllSessions());
}
