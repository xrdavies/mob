import { ApiError, authFetch } from "../lib/auth.ts";
import { parseDesktops } from "../lib/desktops.ts";
import type { Desktops, Health, MachineSettings, Question, Queue, RunnerInfo, Session, SessionDetail, SettingsView, Upload } from "./types.ts";

async function getJSON<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const res = await authFetch(base, `${base}${path}`, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const { error, code } = data as { error?: string; code?: string };
    throw new ApiError(error || `HTTP ${res.status}`, res.status, code || undefined);
  }
  return data as T;
}

export const fetchHealth = (base: string) => getJSON<Health>(base, "/health");

export const fetchSettings = (base: string) => getJSON<SettingsView>(base, "/settings");

/** Replaces the machine settings; ApiError code "settings_changed" when another device saved first. */
export const saveSettings = (base: string, settings: MachineSettings) =>
  getJSON<SettingsView>(base, "/settings", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings),
  });

export const fetchQueue = (base: string) => getJSON<Queue>(base, "/queue");

export async function fetchArchived(base: string): Promise<Session[]> {
  return (await getJSON<{ sessions: Session[] }>(base, "/sessions?archived=true")).sessions;
}

/** A computer's conversations (not archived), for the sidebar of a computer that is not open. */
export async function fetchSessions(base: string): Promise<Session[]> {
  return (await getJSON<{ sessions: Session[] }>(base, "/sessions")).sessions ?? [];
}

export const fetchSessionDetail = (base: string, id: string) => getJSON<SessionDetail>(base, `/sessions/${encodeURIComponent(id)}`);

/** Renames, pins or archives a conversation on a computer that is not open (the open one goes through Chat). */
export const patchSessionAt = (base: string, id: string, patch: { title?: string; pinned?: boolean; archived?: boolean }) =>
  getJSON<Session>(base, `/sessions/${encodeURIComponent(id)}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
  });

export const deleteSessionAt = (base: string, id: string) =>
  getJSON<unknown>(base, `/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });

/** Answers a question or approval on any computer (Needs you). */
export const answerQuestion = (base: string, q: Question, reply: { answer?: string; approved?: boolean }) =>
  getJSON<Question>(base, `/tasks/${encodeURIComponent(q.taskId)}/questions/${encodeURIComponent(q.id)}/answer`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(reply),
  });

export async function uploadImage(base: string, file: File): Promise<Upload> {
  const form = new FormData();
  form.append("file", file, file.name || "image.png");
  return getJSON<Upload>(base, "/uploads", { method: "POST", body: form });
}

// Image URLs need the credential too: load them with useAuthedImage, not <img src>.
export const artifactUrl = (base: string, id: string) => `${base}/artifacts/${encodeURIComponent(id)}`;

// No cache-busting parameter: polling sends If-None-Match and an unchanged screen costs a 304.
// With conversation desktops, sessionId picks the conversation's desktop.
export const screenUrl = (base: string, maxWidth: number, quality = 65, sessionId?: string) =>
  `${base}/screen?maxWidth=${maxWidth}&quality=${quality}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}`;

export async function fetchDesktops(base: string): Promise<Desktops> {
  return parseDesktops(await getJSON<unknown>(base, "/desktops"));
}

/** Stops the conversation's running turn, then closes its desktop. */
export async function closeDesktop(base: string, sessionId: string): Promise<void> {
  await getJSON(base, `/desktops/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
}

/** Makes the conversation's browser profiles the seed for new conversations. */
export async function seedDesktop(base: string, sessionId: string): Promise<void> {
  await getJSON(base, `/desktops/${encodeURIComponent(sessionId)}/seed`, { method: "POST" });
}

/** The runner that will handle the next turn: the session's, else the default. */
export function runnerFor(health: Health | undefined, name?: string): RunnerInfo | undefined {
  const runners = health?.runners;
  if (!runners?.length) return undefined;
  return runners.find((r) => r.name === (name || health?.runner)) ?? runners.find((r) => r.default);
}

export function supports(health: Health | undefined, feature: string): boolean {
  return !!health && health.apiVersion >= 3 && !!health.features?.includes(feature);
}

/** mobd gives every conversation its own desktop (Linux): live view and snapshots name the conversation. */
export const sessionDesktops = (health: Health | undefined) => supports(health, "sessionDesktops");
