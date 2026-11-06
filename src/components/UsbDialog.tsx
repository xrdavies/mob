// USB devices: share one plugged into this computer with the office computer, see and stop shares.
// mobd docs/usb-redirection.md. A share outlives this dialog and chat changes; quitting Mob ends it.
import { useEffect, useState } from "react";
import { RefreshCw, TriangleAlert, Usb, X } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import type { Health } from "@/api/types";
import { supports } from "@/api/client";
import { isTauri } from "@/components/TitleBar";
import { Spinner } from "@/components/StatusIcon";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Tooltip } from "@/components/ui/tooltip";
import { authFetch } from "@/lib/auth";
import { currentAddress } from "@/lib/machines";
import { active, deviceDetail, shareBlocker, stateLabel, type LocalDevice, type UsbImporter } from "@/lib/usb";
import { cn } from "@/lib/utils";
import { baseUrl, type Machine } from "@/store/app";
import { BusyError, useUsb, type Share } from "@/store/usb";

const message = (e: unknown) => String(e instanceof Error ? e.message : e);

export function UsbDialog({ machine, health, open, onOpenChange }: { machine: Machine; health?: Health; open: boolean; onOpenChange: (open: boolean) => void }) {
  const base = baseUrl(machine);
  const supported = supports(health, "usbRedirection");
  const allShares = useUsb((s) => s.shares);
  const shares = Object.values(allShares).filter((s) => s.machineId === machine.id);
  const shareDevice = useUsb((s) => s.share);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState<string>();

  const importer = useQuery({
    queryKey: ["usb", base],
    enabled: open && !!base && supported,
    queryFn: async () => {
      const res = await authFetch(base, `${base}/usb`);
      if (!res.ok) throw new Error(`mobd answered ${res.status}`);
      return (await res.json() as { importer: UsbImporter }).importer;
    },
  });
  const devices = useQuery({
    queryKey: ["usb-devices"],
    enabled: open && isTauri,
    queryFn: () => invoke<LocalDevice[]>("usb_devices"),
  });
  // A share starting or ending changes which devices show as shared.
  const activeCount = Object.values(allShares).filter((s) => active(s.state)).length;
  useEffect(() => {
    if (open && isTauri) void devices.refetch();
  }, [activeCount, open]); // eslint-disable-line react-hooks/exhaustive-deps

  const share = async (d: LocalDevice) => {
    const address = currentAddress(machine);
    if (!address) return;
    setError("");
    setStarting(d.busId);
    try {
      await shareDevice(machine.id, address.id, base, d);
    } catch (e) {
      setError(message(e));
    } finally {
      setStarting(undefined);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[580px] p-5">
        <div className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent"><Usb className="size-4.5" /></span>
          <div className="min-w-0">
            <DialogTitle>USB devices</DialogTitle>
            <DialogDescription className="mt-0.5">
              Share a device plugged into this computer with {machine.name}. Its tools and drivers then use it as if it were plugged in there.
            </DialogDescription>
          </div>
        </div>

        {!isTauri ? (
          <p className="mt-4 rounded-lg bg-panel p-3 text-[13px] text-muted-foreground">Sharing USB devices needs the Mob desktop app.</p>
        ) : !supported ? (
          <p className="mt-4 rounded-lg bg-panel p-3 text-[13px] text-muted-foreground">Update mobd on {machine.name} to share USB devices with it.</p>
        ) : (
          <>
            {importer.data && !importer.data.ready && (
              <div className="mt-4 flex gap-2.5 rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs">
                <TriangleAlert className="mt-px size-3.5 shrink-0 text-warning" />
                <p>{machine.name} can't use shared USB devices yet: {importer.data.detail}</p>
              </div>
            )}
            {importer.isError && <p className="mt-4 text-xs text-danger">Couldn't ask {machine.name}: {message(importer.error)}</p>}

            {shares.length > 0 && (
              <section className="mt-4">
                <p className="mb-1.5 text-xs font-medium text-muted-foreground">Shared now</p>
                <div className="grid gap-1.5">{shares.map((s) => <ShareRow key={s.sessionId} share={s} />)}</div>
              </section>
            )}

            <section className="mt-4">
              <div className="mb-1.5 flex items-center">
                <p className="flex-1 text-xs font-medium text-muted-foreground">On this computer</p>
                <Button variant="ghost" size="icon-sm" aria-label="Refresh devices" onClick={() => void devices.refetch()}>
                  <RefreshCw className={cn(devices.isFetching && "animate-spin")} />
                </Button>
              </div>
              <div className="max-h-[44vh] overflow-y-auto rounded-lg border">
                {devices.isLoading && <p className="p-3 text-xs text-muted-foreground">Looking for USB devices…</p>}
                {devices.isError && <p className="p-3 text-xs text-danger">{message(devices.error)}</p>}
                {devices.data?.length === 0 && <p className="p-3 text-xs text-muted-foreground">No USB devices are plugged into this computer.</p>}
                {devices.data?.map((d) => {
                  const blocker = shareBlocker(d, importer.data);
                  return (
                    <div key={d.busId} className={cn("flex items-center gap-3 border-b px-3 py-2 last:border-b-0", d.unavailable && "opacity-60")}>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-medium">{d.name}</p>
                        <p className="truncate text-[11px] text-muted-foreground">{d.unavailable ?? deviceDetail(d)}</p>
                      </div>
                      {d.shared ? (
                        <span className="text-xs text-muted-foreground">Shared</span>
                      ) : (
                        <Tooltip content={blocker || `Share with ${machine.name}`}>
                          <span>
                            <Button size="sm" variant="secondary" disabled={!!blocker || !!starting} onClick={() => void share(d)}>
                              {starting === d.busId && <Spinner className="size-3" />} Share
                            </Button>
                          </span>
                        </Tooltip>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>

            {error && <p role="alert" className="mt-3 text-xs text-danger">{error}</p>}
            <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
              While shared, only {machine.name} can use the device. Eject a drive on this computer before sharing it. Sharing stops when you
              quit Mob, unplug the device or lose the connection; a write or firmware flash in progress may then be cut off.
            </p>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ShareRow({ share: s }: { share: Share }) {
  const stop = useUsb((x) => x.stop);
  const dismiss = useUsb((x) => x.dismiss);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const release = async (force: boolean) => {
    setError("");
    try {
      await stop(s.sessionId, force);
      setBusy("");
    } catch (e) {
      if (e instanceof BusyError) setBusy(e.message);
      else setError(message(e));
    }
  };
  const ended = !active(s.state);
  return (
    <div className="rounded-lg border bg-panel px-3 py-2">
      <div className="flex items-center gap-3">
        {s.state === "connecting" || s.state === "disconnecting" ? <Spinner className="size-3.5" /> : (
          <span className={cn("size-2 shrink-0 rounded-full", s.state === "connected" ? "bg-success" : s.state === "failed" ? "bg-danger" : "bg-muted-foreground/40")} />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium">{s.name}</p>
          <p className={cn("truncate text-[11px]", s.state === "failed" ? "text-danger" : "text-muted-foreground")} title={s.reason}>
            {stateLabel(s.state, s.localBusId)}{s.reason && s.reason !== "released" ? `: ${s.reason}` : ""}
          </p>
        </div>
        {ended ? (
          <Button variant="ghost" size="icon-sm" aria-label="Dismiss" onClick={() => dismiss(s.sessionId)}><X /></Button>
        ) : (
          <Button variant="secondary" size="sm" disabled={s.state === "disconnecting"} onClick={() => void release(false)}>Stop sharing</Button>
        )}
      </div>
      {busy && (
        <div className="mt-2 flex items-start gap-2 text-xs">
          <TriangleAlert className="mt-px size-3.5 shrink-0 text-warning" />
          <p className="flex-1">{busy}. Unmount it on the office computer, or detach it anyway: writes not yet saved there can be lost.</p>
          <Button variant="danger" size="sm" onClick={() => void release(true)}>Detach anyway</Button>
        </div>
      )}
      {error && <p className="mt-1.5 text-xs text-danger">{error}</p>}
    </div>
  );
}
