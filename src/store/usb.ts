// Shared USB devices (mobd docs/usb-redirection.md). A share belongs to the app, not to a chat:
// it keeps running while chats, machines and the live view change, and ends when Mob quits. The
// session is created and released over mobd's API; the native side opens the device and carries
// it over the session's tunnel, reporting mobd's states as "usb-share" events.
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { authFetch } from "@/lib/auth";
import { usbError, type LocalDevice, type UsbSession, type UsbState } from "@/lib/usb";
import { log } from "@/store/log";

export interface Share {
  sessionId: string;
  machineId: string;
  base: string;
  busId: string;
  name: string;
  state: UsbState;
  reason?: string;
  localBusId?: string;
}

interface ShareEvent { sessionId: string; state: UsbState; reason?: string | null; localBusId?: string | null }

interface UsbStore {
  shares: Record<string, Share>;
  /** Shares `device` with the machine at `base` (address `addressId`, whose credential is used). */
  share: (machineId: string, addressId: string, base: string, device: LocalDevice) => Promise<void>;
  /** Releases a share: detached on the office computer, then the tunnel closes. Throws
   * `BusyError` while a drive from it is mounted there, unless `force`. */
  stop: (sessionId: string, force?: boolean) => Promise<void>;
  dismiss: (sessionId: string) => void;
}

/** The office computer still uses the device (a mounted drive). */
export class BusyError extends Error {}

export const useUsb = create<UsbStore>()((set, get) => {
  const update = (id: string, patch: Partial<Share>) => set((s) => (s.shares[id] ? { shares: { ...s.shares, [id]: { ...s.shares[id], ...patch } } } : s));

  if (isTauri()) {
    void listen<ShareEvent>("usb-share", ({ payload: e }) => {
      update(e.sessionId, { state: e.state, reason: e.reason ?? undefined, localBusId: e.localBusId ?? undefined });
      if (e.state === "failed") log(`USB share ${e.sessionId}: ${e.reason ?? "failed"}`, "error");
    });
  }

  return {
    shares: {},

    async share(machineId, addressId, base, device) {
      const res = await authFetch(base, `${base}/usb/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ busId: device.busId, name: device.name, vendorId: device.vendorId, productId: device.productId, serialNumber: device.serialNumber ?? undefined }),
      });
      if (!res.ok) throw new Error((await usbError(res)).message);
      const session = await res.json() as UsbSession;
      set((s) => ({ shares: { ...s.shares, [session.id]: { sessionId: session.id, machineId, base, busId: device.busId, name: device.name, state: session.state } } }));
      try {
        await invoke("usb_share", { addressId, baseUrl: base, sessionId: session.id, busId: device.busId });
      } catch (err) {
        // Opening the device or the tunnel failed here: end the session mobd made for it.
        update(session.id, { state: "failed", reason: String(err) });
        void authFetch(base, `${base}/usb/sessions/${session.id}`, { method: "DELETE" }).catch(() => {});
        throw new Error(String(err));
      }
    },

    async stop(sessionId, force = false) {
      const s = get().shares[sessionId];
      if (!s) return;
      const before = s.state;
      update(sessionId, { state: "disconnecting" });
      let res: Response;
      try {
        res = await authFetch(s.base, `${s.base}/usb/sessions/${sessionId}${force ? "?force=true" : ""}`, { method: "DELETE" });
      } catch (err) {
        // The office computer is unreachable: close the tunnel here; mobd detaches when it notices.
        log(`USB release over the API failed, closing the tunnel: ${String(err)}`, "error");
        await invoke("usb_stop", { sessionId }).catch(() => {});
        return;
      }
      if (!res.ok) {
        const e = await usbError(res);
        if (e.code === "usb_busy") {
          update(sessionId, { state: before });
          throw new BusyError(e.message);
        }
        if (res.status !== 404) {
          update(sessionId, { state: before });
          throw new Error(e.message);
        }
      }
      // mobd detached it and closes the tunnel; end it here too, should that not arrive.
      setTimeout(() => void invoke("usb_stop", { sessionId }).catch(() => {}), 5000);
    },

    dismiss(sessionId) {
      set((s) => {
        const { [sessionId]: _, ...rest } = s.shares;
        return { shares: rest };
      });
    },
  };
});
