import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useAllSessions } from "@/hooks/useComputers";
import { openSession } from "@/hooks/navigate";
import { alertsFor, type Seen } from "@/lib/alerts";
import { needsYou } from "@/lib/computers";
import { useApp } from "@/store/app";

const TITLES = { needs: "Needs you", done: "Done", failed: "Failed" } as const;

/**
 * Tells the user when a conversation on any computer needs them, finishes or fails (Settings →
 * Notifications): a toast in the app, a system notification as chosen, and the count in the title.
 */
export function useAlerts(): void {
  const lists = useAllSessions();
  const seen = useRef<Seen>(new Map());
  const waiting = needsYou(lists).length;
  const key = lists.map((l) => `${l.machineId}:${l.sessions.map((s) => `${s.id}${s.waiting ? "w" : ""}${s.activeTaskId ? "a" : ""}${s.status}`).join(",")}`).join("|");
  useEffect(() => {
    document.title = waiting ? `(${waiting}) Mob` : "Mob";
  }, [waiting]);
  useEffect(() => {
    const { notify, machines } = useApp.getState();
    for (const a of alertsFor(seen.current, lists, notify)) {
      const computer = machines.find((m) => m.id === a.machineId)?.name ?? "";
      const title = `${TITLES[a.kind]} · ${a.session.title}`;
      const open = () => openSession(a.machineId, a.session.id);
      if (a.kind !== "done" || document.hidden) {
        toast(title, { description: computer, duration: a.kind === "needs" ? 8000 : 4000, action: { label: "Open", onClick: open } });
      }
      if (typeof Notification === "undefined" || Notification.permission !== "granted") continue;
      if (notify.background && !document.hidden && document.hasFocus()) continue;
      const n = new Notification(`Mob · ${title}`, { body: computer, silent: !notify.sound });
      n.onclick = () => {
        window.focus();
        open();
      };
    }
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
}
