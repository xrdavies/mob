import { Check, CircleHelp, Clock, ShieldAlert, X } from "lucide-react";
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
    line = approval ? "No answer in time — treated as denied" : "No answer in time";
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
export function QuestionCard({ q, onAnswer, className, header }: {
  q: Question;
  onAnswer?: (q: Question, reply: Reply) => Promise<boolean>;
  className?: string;
  /** Replaces the kind line, e.g. which conversation and computer asks. */
  header?: ReactNode;
}) {
  const chat = useChat();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
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
    <div className={cn("ml-9 rounded-xl border border-warning/40 bg-warning/5 p-3.5", className)} role="group" aria-label="The agent is waiting for you">
      <div className="flex items-start gap-2.5">
        {approval ? <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" /> : <CircleHelp className="mt-0.5 size-4 shrink-0 text-warning" />}
        <div className="min-w-0 flex-1">
          {header ?? (
            <p className="text-[11px] font-medium uppercase tracking-wide text-warning">
              {approval ? "Approval needed" : "The agent asks"}
            </p>
          )}
          <p className="mt-0.5 text-[14px] font-medium leading-snug">{q.text}</p>
          {q.details && <p className="mt-1 whitespace-pre-wrap text-[13px] text-muted-foreground">{q.details}</p>}
        </div>
        <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
          <Clock className="size-3" /> waiting
        </span>
      </div>

      {approval ? (
        <div className="mt-3 grid gap-2 pl-6.5">
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Optional note for the agent" disabled={sending} />
          <div className="flex gap-2">
            <Button disabled={sending} onClick={() => void send({ approved: true, answer: text.trim() || undefined })}>
              <Check /> Approve
            </Button>
            <Button variant="secondary" disabled={sending} className="text-danger hover:text-danger"
              onClick={() => void send({ approved: false, answer: text.trim() || undefined })}>
              <X /> Deny
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-3 grid gap-2 pl-6.5">
          {options.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {options.map((o) => (
                <Button key={o} variant="secondary" disabled={sending} onClick={() => void send({ answer: o })}>
                  {o}
                </Button>
              ))}
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
              <Button type="submit" disabled={sending || !text.trim()}>Send</Button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
