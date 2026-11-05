import { Info } from "lucide-react";
import type { ChatMessage, CollabRequest, Delivery, Session, Task } from "@/api/types";
import { useChat } from "@/hooks/useChat";
import { agentLabel, agentShortLabel, deliveryBody, deliveryLabel, deliverySender, mentionSegments, parseDelivery } from "@/lib/collab";
import { cn } from "@/lib/utils";
import { Markdown } from "./Markdown";

// Collaboration in the timeline: other agents speak on the left with their own name and colour, like
// people in a group chat; only what the user typed sits on the right.

const RUNNER_LABELS: Record<string, string> = { codex: "Codex", claude: "Claude Code", pi: "Pi" };

/** A stable hue for an agent, so the same agent keeps its colour everywhere. */
function hue(id: string): number {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

export function AgentAvatar({ id, label, className }: { id: string; label: string; className?: string }) {
  const initial = label.match(/[\p{L}\p{N}]/u)?.[0]?.toUpperCase() ?? "?";
  return (
    <span
      aria-hidden
      className={cn("flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white", className)}
      style={{ background: `hsl(${hue(id)} 55% 48%)` }}
    >
      {initial}
    </span>
  );
}

/** An agent's name as a link to its conversation; "(deleted)" agents are plain text. */
function AgentLink({ session, fallback }: { session?: Session; fallback: string }) {
  const chat = useChat();
  if (!session) return <span className="max-w-[60%] truncate font-medium text-foreground/80">{fallback}</span>;
  return (
    <button type="button" title={agentLabel(session)} onClick={() => void chat.open(session.id)}
      className="max-w-[60%] truncate font-medium text-foreground/80 hover:underline">
      {agentShortLabel(session)}
    </button>
  );
}

/** A user's text with @mentions of other conversations shown as chips that open them. */
export function MentionText({ text }: { text: string }) {
  const chat = useChat();
  return (
    <>
      {mentionSegments(text, chat.sessions, chat.sessionId).map((seg, i) =>
        seg.session ? (
          <button
            key={i}
            type="button"
            title={`Open ${seg.session.title}`}
            onClick={() => void chat.open(seg.session!.id)}
            className="rounded bg-accent-soft px-1 font-medium text-accent hover:underline"
          >
            {seg.text}
          </button>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  );
}

type Part = { senderId: string | null; name: string; label: string; body: string; context?: string; request?: CollabRequest };

/** What a collab turn carried, from mobd's structured deliveries, else from its labelled prompt. */
function parts(task: Task | undefined, message: ChatMessage, requests: CollabRequest[], sessions: Session[]): Part[] {
  const deliveries: Delivery[] = task?.origin?.deliveries ?? [];
  if (deliveries.length) {
    return deliveries.map((d) => {
      const r = requests.find((x) => x.id === d.requestId);
      const sender = r ? deliverySender(d, r) : null;
      const session = sessions.find((s) => s.id === sender);
      const saved = r && sender ? (sender === r.from ? r.fromName : r.toName) : "Mob";
      return {
        senderId: sender, name: session ? agentShortLabel(session) : saved, label: deliveryLabel(d, r), body: d.text,
        context: d.kind !== "request" && r ? r.text : undefined, request: r,
      };
    });
  }
  return parseDelivery(message.content).map((p) => ({
    senderId: p.from === "Mob" ? null : p.from, name: p.from, label: "", body: deliveryBody(p.body),
  }));
}

export function PeerMessage({ task, message }: { task?: Task; message: ChatMessage }) {
  const chat = useChat();
  const list = parts(task, message, chat.requests, chat.sessions);
  if (list.length === 0) {
    return <div className="whitespace-pre-wrap pl-9 text-[13px] text-muted-foreground">{message.content}</div>;
  }
  return (
    <div className="grid gap-3">
      {list.map((p, i) => {
        if (!p.senderId) {
          return (
            <div key={i} className="flex items-start gap-2 pl-9 text-xs text-muted-foreground">
              <Info className="mt-0.5 size-3.5 shrink-0" />
              <span className="min-w-0">
                {p.context && <>Request “<span className="text-foreground/80">{p.context}</span>”: </>}
                {p.body}
              </span>
            </div>
          );
        }
        const session = chat.sessions.find((s) => s.id === p.senderId);
        const h = hue(p.senderId);
        return (
          <div key={i} className="flex gap-3">
            <AgentAvatar id={p.senderId} label={p.name} className="mt-0.5" />
            <div className="min-w-0 flex-1">
              <div className="mb-1 flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
                <AgentLink session={session} fallback={p.name} />
                {session?.runner && <span>{RUNNER_LABELS[session.runner] ?? session.runner}</span>}
                {p.label && <span>· {p.label}</span>}
              </div>
              <div
                className="rounded-lg border-l-2 px-3.5 py-2"
                style={{ borderColor: `hsl(${h} 55% 48%)`, background: `hsl(${h} 60% 50% / 0.07)` }}
              >
                <Markdown text={p.body} />
              </div>
              {p.context && <p className="mt-1 truncate text-[11px] text-muted-foreground">Re: {p.context}</p>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
