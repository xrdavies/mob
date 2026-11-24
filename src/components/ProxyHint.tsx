import { useQuery } from "@tanstack/react-query";
import { PROXY_FAQ, PROXY_HINT, proxyBlocksTailnet, systemProxy } from "@/lib/proxy";
import { cn } from "@/lib/utils";

/**
 * Next to "not reachable" for a Tailscale address: when this computer's proxy does not leave
 * Tailscale alone, that is the likely cause (src/lib/proxy.ts). Renders nothing otherwise.
 */
export function ProxyHint({ origin, className }: { origin: string | undefined; className?: string }) {
  const { data } = useQuery({ queryKey: ["system-proxy"], queryFn: systemProxy, staleTime: 15_000, enabled: !!origin });
  if (!origin || !proxyBlocksTailnet(data, origin)) return null;
  return (
    <p className={cn("text-[11.5px] text-warning", className)}>
      {PROXY_HINT}{" "}
      <a href={PROXY_FAQ} target="_blank" rel="noreferrer" className="font-medium underline underline-offset-2">How ↗</a>
    </p>
  );
}
