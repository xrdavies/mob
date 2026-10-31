import { useEffect, useState } from "react";
import { Spinner } from "@/components/StatusIcon";
import { Button } from "@/components/ui/button";
import { useChat } from "@/hooks/useChat";

/** Next to the conversation title: syncing (after 300 ms, so a fast sync shows nothing), offline or failed. */
export function SyncStatus() {
  const chat = useChat();
  const [late, setLate] = useState(false);
  useEffect(() => {
    setLate(false);
    if (chat.sync !== "syncing") return;
    const t = setTimeout(() => setLate(true), 300);
    return () => clearTimeout(t);
  }, [chat.sync]);
  if (chat.sync === "syncing") {
    return late ? (
      <span className="ml-2.5 flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground" role="status">
        <Spinner /> Syncing…
      </span>
    ) : null;
  }
  if (chat.sync === "offline") {
    return <span className="ml-2.5 shrink-0 text-xs text-muted-foreground" role="status">Offline · showing saved copy</span>;
  }
  if (chat.sync === "failed") {
    return (
      <span className="ml-2.5 flex shrink-0 items-center gap-1 text-xs text-warning" role="status">
        Couldn't sync ·
        <Button variant="link" size="sm" className="h-auto px-0 text-xs" onClick={() => chat.retrySync()}>Retry</Button>
      </span>
    );
  }
  return null;
}
