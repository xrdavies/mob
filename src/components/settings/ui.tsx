import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Settings' building blocks (docs/desktop-redesign, Settings): a page title, grouped rows in bordered
// lists, a label on the left and its control on the right. Hints only where they show state or
// prevent a mistake (D9).

export function Page({ title, children, action }: { title: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="grid min-w-0 content-start gap-5">
      <div className="flex min-h-8 items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate text-[17px] font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </div>
  );
}

export function Group({ title, action, children, footer }: { title?: ReactNode; action?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <section className="grid min-w-0 gap-1.5">
      {(title || action) && (
        <div className="flex items-center gap-2 px-1">
          <h3 className="min-w-0 flex-1 text-[12px] font-semibold text-muted-foreground">{title}</h3>
          {action}
        </div>
      )}
      <div className="grid min-w-0 divide-y rounded-[10px] border bg-background">{children}</div>
      {footer && <div className="px-1 text-[11.5px] text-muted-foreground">{footer}</div>}
    </section>
  );
}

export function Row({ label, detail, children, className }: { label: ReactNode; detail?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-h-11 min-w-0 items-center gap-3 px-3 py-2", className)}>
      <div className="grid min-w-0 flex-1">
        <span className="truncate text-[13px]">{label}</span>
        {detail && <span className="min-w-0 break-words text-[11.5px] text-muted-foreground">{detail}</span>}
      </div>
      {children !== undefined && <div className="flex shrink-0 items-center gap-1.5">{children}</div>}
    </div>
  );
}

/** A small segmented choice. */
export function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded-md border bg-panel p-0.5">
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} onClick={() => onChange(o.value)}
          className={cn("h-6 rounded px-2.5 text-[11.5px] font-medium transition-colors",
            value === o.value ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground")}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Dot({ tone }: { tone: "ok" | "warn" | "bad" | "off" }) {
  return (
    <span className={cn("inline-block size-2 shrink-0 rounded-full",
      tone === "ok" ? "bg-success" : tone === "warn" ? "bg-warning" : tone === "bad" ? "bg-danger" : "bg-muted-foreground/40")} />
  );
}

/** A two-step button for actions that interrupt something: the first press says what happens. */
export function ConfirmButton({ label, confirm, onConfirm, disabled, variant = "secondary", danger }: {
  label: ReactNode; confirm?: string; onConfirm: () => void; disabled?: boolean; variant?: "secondary" | "ghost"; danger?: boolean;
}) {
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    if (!asking) return;
    const t = setTimeout(() => setAsking(false), 5000);
    return () => clearTimeout(t);
  }, [asking]);
  const tone = danger ? "text-danger hover:text-danger" : asking ? "text-warning" : "";
  if (!confirm) return <Button size="sm" variant={variant} disabled={disabled} className={tone} onClick={onConfirm}>{label}</Button>;
  return (
    <Button size="sm" variant={asking ? "secondary" : variant} disabled={disabled} className={tone}
      onClick={() => (asking ? (setAsking(false), onConfirm()) : setAsking(true))}>
      {asking ? confirm : label}
    </Button>
  );
}

export const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
