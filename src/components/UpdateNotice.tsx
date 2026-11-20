import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useChat } from "@/hooks/useChat";
import { useUpdates } from "@/store/updates";

export function UpdateNotice() {
  const state = useUpdates();
  const chat = useChat();
  const [confirm, setConfirm] = useState(false);
  const busy = chat.busy || chat.submitting;
  useEffect(() => {
    if (isTauri()) void useUpdates.getState().check();
  }, []);
  if (!["available", "installing", "installed"].includes(state.phase) && !(state.phase === "error" && state.update)) return null;
  const progress = state.total ? `${Math.min(100, Math.round(state.downloaded / state.total * 100))}%` : `${Math.round(state.downloaded / 1024)} KB`;
  return (
    <>
      <div className="flex items-center justify-center gap-3 border-b bg-accent-soft px-4 py-2 text-xs" role="status" aria-live="polite">
        {state.phase === "available" && <>
          <span>Mob {state.update?.version} is available.{busy && " Finish the current turn before updating."}</span>
          <Button size="sm" disabled={busy} onClick={() => setConfirm(true)}>Update…</Button>
        </>}
        {state.phase === "installing" && <span>Installing update… {progress}</span>}
        {state.phase === "installed" && <span>{state.error || "Update installed. Restarting…"}</span>}
        {state.phase === "error" && <>
          <span>Update failed. Your current App is still available.</span>
          <Button size="sm" onClick={() => void state.check()}>Retry</Button>
        </>}
      </div>
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent className="max-w-md">
          <DialogTitle>Install Mob {state.update?.version}?</DialogTitle>
          <DialogDescription>Mob will restart after installation. Finish or copy any unsent text and attachments before continuing. Conversations stay on your computers.</DialogDescription>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirm(false)}>Later</Button>
            <Button disabled={busy || state.phase !== "available"} onClick={() => { setConfirm(false); void state.install(); }}>Install and restart</Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function UpdateSettings() {
  const state = useUpdates();
  if (!isTauri()) return <p className="text-muted-foreground">Updates are available in the desktop App.</p>;
  return <div className="mt-3 grid gap-2">
    {state.currentVersion && <p>Version {state.currentVersion}</p>}
    {state.phase === "disabled" && <p className="text-muted-foreground">Automatic updates are not configured in this development build.</p>}
    <Button className="w-fit" variant="secondary" disabled={["disabled", "checking", "installing", "installed"].includes(state.phase)} onClick={() => void state.check()}>
      {state.phase === "checking" ? "Checking…" : "Check for updates"}
    </Button>
    {state.phase === "current" && <p role="status">You’re up to date.</p>}
    {state.error && <p className="break-words text-xs text-danger" role="alert">{state.error}</p>}
    {state.phase === "available" && <p>Version {state.update?.version} is ready. Close Settings to install.</p>}
  </div>;
}
