import { useState, type ReactNode } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

/** Only explicit HTTP(S) destinations are sent to the system browser. */
function webUrl(href: string | undefined): string | null {
  if (!href || !/^https?:\/\//i.test(href) || /[\u0000-\u001f\u007f-\u009f]/.test(href)) return null;
  try {
    const url = new URL(href);
    return url.username || url.password ? null : url.href;
  } catch {
    return null;
  }
}

export function MarkdownLink({ href, children }: { href?: string; children: ReactNode }) {
  const [error, setError] = useState("");
  const url = webUrl(href);
  return <>
    <a href={href} target="_blank" rel="noreferrer" onClick={url && isTauri() ? (event) => {
      event.preventDefault();
      setError("");
      void openUrl(url).catch((err) => {
        setError(`Could not open link: ${err instanceof Error ? err.message : String(err)}`);
      });
    } : undefined}>{children}</a>
    {error && <span role="alert" className="ml-2 text-xs text-danger">{error}</span>}
  </>;
}
