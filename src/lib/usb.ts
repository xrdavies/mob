// USB sharing (mobd docs/usb-redirection.md): pure helpers for the USB dialog, testable without UI.

/** A device on this computer (Rust usb_devices). */
export interface LocalDevice {
  busId: string;
  name: string;
  manufacturer?: string | null;
  vendorId: number;
  productId: number;
  serialNumber?: string | null;
  /** Why it cannot be shared from this computer. */
  unavailable?: string | null;
  shared: boolean;
}

export type UsbState = "connecting" | "connected" | "disconnecting" | "disconnected" | "failed";

/** A session as mobd shows it. */
export interface UsbSession {
  id: string;
  device: { busId: string; name?: string; vendorId?: number; productId?: number; serialNumber?: string };
  state: UsbState;
  reason?: string;
  localBusId?: string;
}

export interface UsbImporter {
  backend: string;
  ready: boolean;
  detail?: string;
}

export const ids = (vendorId: number, productId: number) =>
  `${vendorId.toString(16).padStart(4, "0")}:${productId.toString(16).padStart(4, "0")}`;

/** The device line under a name: manufacturer and IDs. */
export function deviceDetail(d: Pick<LocalDevice, "manufacturer" | "vendorId" | "productId">): string {
  return [d.manufacturer, ids(d.vendorId, d.productId)].filter(Boolean).join(" · ");
}

export function stateLabel(state: UsbState, localBusId?: string): string {
  switch (state) {
    case "connecting": return "Connecting…";
    case "connected": return localBusId ? `Shared · ${localBusId} on the office computer` : "Shared";
    case "disconnecting": return "Stopping…";
    case "disconnected": return "Stopped";
    case "failed": return "Failed";
  }
}

export const active = (state: UsbState) => state === "connecting" || state === "connected" || state === "disconnecting";

/** Why a device's Share button is off, or "" when it can be shared. */
export function shareBlocker(d: LocalDevice, importer?: UsbImporter): string {
  if (d.shared) return "Already shared";
  if (d.unavailable) return d.unavailable;
  if (importer && !importer.ready) return "The office computer cannot import USB devices yet";
  return "";
}

/** mobd's error body: its message and code, e.g. usb_busy for a drive still mounted there. */
export async function usbError(res: Response): Promise<{ message: string; code?: string }> {
  try {
    const body = await res.json() as { error?: string; code?: string };
    return { message: body.error || `mobd answered ${res.status}`, code: body.code };
  } catch {
    return { message: `mobd answered ${res.status}` };
  }
}
