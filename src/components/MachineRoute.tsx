import { Route, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ProxyHint } from "@/components/ProxyHint";
import {
  ContextMenuItem, DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger,
} from "@/components/ui/menu";
import { useHealth } from "@/hooks/useMachine";
import { addressLabel, currentAddress, hostOf } from "@/lib/machines";
import { needsPairing, useApp, type Machine } from "@/store/app";

/** Whether the machine answers over the address in use: true, false, or null while not known. */
export function useReachable(machine: Machine): boolean | null {
  const { data, isError } = useHealth(machine);
  if (needsPairing(machine)) return null;
  return data ? true : isError ? false : null;
}

/** Another address to offer when the one in use does not answer or needs pairing. */
export function fallbackAddress(machine: Machine, reachable: boolean | null) {
  const a = currentAddress(machine);
  if (!a || (reachable !== false && !needsPairing(machine))) return undefined;
  return machine.addresses.find((x) => x.id !== a.id);
}

/** The route chip next to a machine with several addresses: shows the one in use, opens the choice. */
export function RouteChip({ machine }: { machine: Machine }) {
  const selectRoute = useApp((s) => s.selectRoute);
  const a = currentAddress(machine);
  if (machine.addresses.length < 2 || !a) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label={`Route to ${machine.name}: ${addressLabel(machine, a)}`}
          className="shrink-0 rounded border px-1 text-[10px] font-normal leading-4 text-muted-foreground hover:text-foreground">
          {addressLabel(machine, a)}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Reach {machine.name} over</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={a.id} onValueChange={(id) => selectRoute(machine.id, id)}>
          {machine.addresses.map((x) => (
            <DropdownMenuRadioItem key={x.id} value={x.id}>
              <span className="min-w-0">
                <span className="block">{addressLabel(machine, x)}</span>
                <span className="block truncate font-mono text-[11px] text-muted-foreground">{hostOf(x.url)}</span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** "Use LAN" / "Use Remote" items for a machine's context menu. */
export function RouteContextItems({ machine }: { machine: Machine }) {
  const { selectRoute, selectMachine } = useApp();
  const a = currentAddress(machine);
  if (machine.addresses.length < 2) return null;
  return machine.addresses.map((x) => (
    <ContextMenuItem key={x.id} disabled={x.id === a?.id} onSelect={() => { selectRoute(machine.id, x.id); selectMachine(machine.id); }}>
      <Route /> Use {addressLabel(machine, x)}{x.id === a?.id && " (in use)"}
    </ContextMenuItem>
  ));
}

/** Above the chat: the address in use does not answer (or needs pairing) and there is another. One click switches. */
export function RouteBanner({ machine }: { machine: Machine }) {
  const selectRoute = useApp((s) => s.selectRoute);
  const reachable = useReachable(machine);
  const a = currentAddress(machine);
  const other = fallbackAddress(machine, reachable);
  if (!a || !other) return null;
  return (
    <div role="status" className="mx-4 mt-2 flex items-center gap-2 rounded-lg border bg-panel px-3 py-2 text-xs">
      <WifiOff className="size-3.5 shrink-0 text-warning" />
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span>{addressLabel(machine, a)} {needsPairing(machine) ? "needs pairing" : "not reachable"}</span>
        {!needsPairing(machine) && <ProxyHint origin={a.url} />}
      </span>
      <Button size="sm" variant="secondary" onClick={() => selectRoute(machine.id, other.id)}>Use {addressLabel(machine, other)}</Button>
    </div>
  );
}
