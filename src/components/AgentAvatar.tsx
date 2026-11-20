import { cn } from "@/lib/utils";

export const RUNNER_LABELS: Record<string, string> = { codex: "Codex", claude: "Claude Code", pi: "Pi" };

export const runnerLabel = (runner?: string) => (runner ? RUNNER_LABELS[runner] ?? runner : "Agent");

const COLORS: Record<string, string> = { claude: "bg-[#d97757]", codex: "bg-[#202024] dark:bg-[#3a3a40]", pi: "bg-[#7c3aed]" };

/** The agent's mark: its program's initial on its color. */
export function AgentAvatar({ runner, size = "md", className }: { runner?: string; size?: "sm" | "md" | "lg"; className?: string }) {
  const letter = runner === "codex" ? "X" : (runnerLabel(runner)[0] ?? "A").toUpperCase();
  return (
    <span
      aria-hidden
      className={cn(
        "grid shrink-0 place-items-center font-bold text-white",
        size === "sm" && "size-3.5 rounded-[4px] text-[8px]",
        size === "md" && "size-5 rounded-md text-[10.5px]",
        size === "lg" && "size-[30px] rounded-lg text-[13px]",
        COLORS[runner ?? ""] ?? "bg-accent",
        className,
      )}
    >
      {letter}
    </span>
  );
}
