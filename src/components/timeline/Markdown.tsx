import { Check, Copy } from "lucide-react";
import { memo, useEffect, useState, type ComponentProps } from "react";
import ReactMarkdown from "react-markdown";
import { MarkdownLink } from "./MarkdownLink";
import remarkGfm from "remark-gfm";

type Highlighter = Awaited<ReturnType<typeof import("shiki/core").createHighlighterCore>>;

// Languages agents commonly print; everything else renders as plain text.
const LANGS: Partial<Record<string, () => Promise<unknown>>> = {
  bash: () => import("shiki/langs/bash.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  swift: () => import("shiki/langs/swift.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  applescript: () => import("shiki/langs/applescript.mjs"),
};
const ALIASES: Record<string, string> = { sh: "bash", shell: "bash", zsh: "bash", console: "bash", js: "javascript", ts: "typescript", py: "python", yml: "yaml", md: "markdown", rs: "rust" };

let highlighter: Promise<Highlighter> | null = null;

function getHighlighter(): Promise<Highlighter> {
  highlighter ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
      import("shiki/core"),
      import("shiki/engine/javascript"),
    ]);
    return createHighlighterCore({
      themes: [import("shiki/themes/github-light.mjs"), import("shiki/themes/github-dark.mjs")],
      langs: [],
      engine: createJavaScriptRegexEngine(),
    });
  })();
  return highlighter;
}

async function highlight(code: string, lang: string): Promise<string> {
  const h = await getHighlighter();
  const name = ALIASES[lang] ?? lang;
  const loader = LANGS[name];
  if (loader && !h.getLoadedLanguages().includes(name)) {
    await h.loadLanguage((await loader() as { default: Parameters<Highlighter["loadLanguage"]>[0] }).default);
  }
  return h.codeToHtml(code, {
    lang: loader ? name : "text",
    themes: { light: "github-light", dark: "github-dark" },
    defaultColor: "light",
  });
}

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let live = true;
    void highlight(code, lang)
      .then((out) => live && setHtml(out))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [code, lang]);
  return (
    <div className="group/code relative my-2 overflow-hidden rounded-lg border bg-code">
      <div className="flex h-7 items-center justify-between border-b px-3 text-[11px] text-muted-foreground">
        <span>{lang || "text"}</span>
        <button
          type="button"
          className="flex items-center gap-1 rounded px-1 hover:text-foreground"
          onClick={() => {
            void navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {html ? (
        <div className="overflow-x-auto px-3 py-2.5 font-mono text-[12.5px] leading-relaxed" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="overflow-x-auto px-3 py-2.5 font-mono text-[12.5px] leading-relaxed">{code}</pre>
      )}
    </div>
  );
}

const components: ComponentProps<typeof ReactMarkdown>["components"] = {
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const match = /language-([\w+-]+)/.exec(className ?? "");
    const text = String(children ?? "");
    if (!match && !text.includes("\n")) return <code>{children}</code>;
    return <CodeBlock code={text.replace(/\n$/, "")} lang={match?.[1] ?? ""} />;
  },
  a: ({ children, href }) => <MarkdownLink href={href}>{children}</MarkdownLink>,
};

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="prose-mob">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
