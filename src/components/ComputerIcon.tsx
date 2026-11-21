import { Laptop, Monitor, Server } from "lucide-react";
import { isLocal } from "@/lib/machines";
import type { Machine } from "@/store/app";

/** A computer's icon, the same everywhere: this computer a laptop, a Linux one a server, others a monitor. */
export function ComputerIcon({ machine, className }: { machine: Machine; className?: string }) {
  const Icon = isLocal(machine) ? Laptop : /linux/i.test(machine.name) ? Server : Monitor;
  return <Icon className={className} aria-label={isLocal(machine) ? "This computer" : undefined} />;
}
