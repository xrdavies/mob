import { CircleHelp, ShieldAlert } from "lucide-react";
import { WaitingIcon } from "@/components/StatusIcon";
import { useState, type ReactNode } from "react";
import type { Question } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useChat } from "@/hooks/useChat";
import { cn } from "@/lib/utils";

function Settled({ q, className }: { q: Question; className?: string }) {
  const approval = q.kind === "approval";
  let line: string;
  let tone = "text-muted-foreground";
  if (q.status === "answered" && approval) {
    line = q.approved ? "Approved" : "Denied";
    tone = q.approved ? "text-success" : "text-danger";
  } else if (q.status === "answered") {
    line = `You answered: ${q.answer}`;
  } else if (q.status === "expired") {
    line = approval ? "No answer in time · denied" : "No answer in time";
  } else {
    line = "Cancelled";
  }
  const Icon = approval ? ShieldAlert : CircleHelp;
  return (
    <div className={cn("ml-9 flex items-start gap-2.5 rounded-lg border px-3 py-2 text-[13px]", className)}>
      <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <p className="text-foreground/85">{q.text}</p>
        <p className={cn("mt-0.5 text-xs", tone)}>
          {line}
          {approval && q.status === "answered" && q.answer ? ` · “${q.answer}”` : ""}
        </p>
      </div>
    </div>
  );
}

export type Reply = { answer?: string; approved?: boolean };

/**
 * A decision the agent is waiting for, answered from the timeline, or from Needs you with onAnswer
 * (any computer).
 */
export function QuestionCard({ q, onAnswer, className, header, onScreen }: {
  q: Question;
  onAnswer?: (q: Question, reply: Reply) => Promise<boolean>;
  className?: string;
  /** Replaces the kind line, e.g. which conversation and computer asks. */
  header?: ReactNode;
  /** Shows the other computer's screen (approvals about what is on it). */
  onScreen?: () => void;
}) {
  const chat = useChat();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [replying, setReplying] = useState(false);
  if (q.status !== "pending") return <Settled q={q} className={className} />;

  const send = async (reply: Reply) => {
    setSending(true);
    await (onAnswer ?? ((x: Question, r: Reply) => chat.answer(x, r)))(q, reply);
    setSending(false);
  };
  const approval = q.kind === "approval";
  const options = q.options ?? [];
  const freeText = q.allowText || options.length === 0;

  return (
    <div className={cn("ml-9 rounded-xl border border-warning/45 bg-warning/[0.06] px-4 py-3", className)} role="group" aria-label="The agent is waiting for you">
      {header ?? (
        <p className="flex items-center gap-1.5 text-xs font-semibold text-warning">
          <WaitingIcon className="size-3" /> {approval ? "Approval needed" : "Question"}
        </p>
      )}
      <p className="mt-1 text-[14px] font-semibold leading-snug">{q.text}</p>
      {q.details && <p className="mt-0.5 whitespace-pre-wrap text-[13px] text-muted-foreground">{q.details}</p>}

      {approval ? (
        <div className="mt-3 grid gap-2">
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={sending} onClick={() => void send({ approved: true, answer: text.trim() || undefined })}>Approve</Button>
            <Button size="sm" variant="secondary" disabled={sending} onClick={() => void send({ approved: false, answer: text.trim() || undefined })}>Deny</Button>
            {!replying && <Button size="sm" variant="ghost" disabled={sending} onClick={() => setReplying(true)}>Reply…</Button>}
            {onScreen && <Button size="sm" variant="ghost" onClick={onScreen}>Look at the screen</Button>}
          </div>
          {replying && (
            <Input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Note for the agent, sent with Approve or Deny" disabled={sending} />
          )}
        </div>
      ) : (
        <div className="mt-3 grid gap-2">
          {options.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {options.map((o, i) => (
                <Button key={o} size="sm" variant={i === 0 ? "default" : "secondary"} disabled={sending} onClick={() => void send({ answer: o })}>
                  {o}
                </Button>
              ))}
              {onScreen && <Button size="sm" variant="ghost" onClick={onScreen}>Look at the screen</Button>}
            </div>
          )}
          {freeText && (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (text.trim()) void send({ answer: text.trim() });
              }}
            >
              <Input autoFocus={options.length === 0} value={text} onChange={(e) => setText(e.target.value)}
                placeholder={options.length ? "Or type another answer" : "Type your answer"} disabled={sending} />
              <Button type="submit" size="sm" className="h-9" disabled={sending || !text.trim()}>Send</Button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
