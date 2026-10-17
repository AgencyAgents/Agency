import { marked, type Token, type Tokens } from "marked";
import { createMemo, createSignal, For, type JSX, Match, Switch } from "solid-js";
import { I, P } from "./icons.tsx";

/** Model text is untrusted: tokens become Solid nodes, never innerHTML. */
export function Markdown(props: { text: string }) {
  const tokens = createMemo(() => marked.lexer(props.text, { gfm: true }));
  return (
    <div class="md">
      <Blocks tokens={tokens()} />
    </div>
  );
}

function Blocks(props: { tokens: Token[] }) {
  return <For each={props.tokens}>{(t) => <Block token={t} />}</For>;
}

function Block(props: { token: Token }): JSX.Element {
  const t = props.token;
  switch (t.type) {
    case "paragraph":
      return (
        <p>
          <Inline tokens={(t as Tokens.Paragraph).tokens} />
        </p>
      );
    case "heading": {
      const h = t as Tokens.Heading;
      const body = <Inline tokens={h.tokens} />;
      return h.depth <= 1 ? (
        <h1>{body}</h1>
      ) : h.depth === 2 ? (
        <h2>{body}</h2>
      ) : h.depth === 3 ? (
        <h3>{body}</h3>
      ) : (
        <h4>{body}</h4>
      );
    }
    case "code":
      return <CodeBlock code={(t as Tokens.Code).text} lang={(t as Tokens.Code).lang ?? ""} />;
    case "blockquote":
      return (
        <blockquote>
          <Blocks tokens={(t as Tokens.Blockquote).tokens} />
        </blockquote>
      );
    case "list": {
      const list = t as Tokens.List;
      const items = (
        <For each={list.items}>
          {(item) => (
            <li>
              {item.task ? (
                <input type="checkbox" checked={item.checked} disabled style={{ margin: "0 6px 0 0" }} />
              ) : null}
              <Blocks tokens={item.tokens} />
            </li>
          )}
        </For>
      );
      return list.ordered ? (
        <ol start={typeof list.start === "number" ? list.start : 1}>{items}</ol>
      ) : (
        <ul>{items}</ul>
      );
    }
    case "table": {
      const table = t as Tokens.Table;
      return (
        <table>
          <thead>
            <tr>
              <For each={table.header}>
                {(cell) => (
                  <th>
                    <Inline tokens={cell.tokens} />
                  </th>
                )}
              </For>
            </tr>
          </thead>
          <tbody>
            <For each={table.rows}>
              {(row) => (
                <tr>
                  <For each={row}>
                    {(cell) => (
                      <td>
                        <Inline tokens={cell.tokens} />
                      </td>
                    )}
                  </For>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      );
    }
    case "hr":
      return <hr />;
    case "space":
      return null;
    case "text": {
      const text = t as Tokens.Text;
      return <p>{text.tokens ? <Inline tokens={text.tokens} /> : text.text}</p>;
    }
    default:
      return "raw" in t ? <p>{(t as { raw: string }).raw}</p> : null;
  }
}

function Inline(props: { tokens: Token[] | undefined }): JSX.Element {
  return (
    <For each={props.tokens ?? []}>
      {(t) => (
        <Switch fallback={"raw" in t ? (t as { raw: string }).raw : ""}>
          <Match when={t.type === "text"}>
            {(t as Tokens.Text).tokens ? (
              <Inline tokens={(t as Tokens.Text).tokens} />
            ) : (
              decode((t as Tokens.Text).text)
            )}
          </Match>
          <Match when={t.type === "strong"}>
            <strong>
              <Inline tokens={(t as Tokens.Strong).tokens} />
            </strong>
          </Match>
          <Match when={t.type === "em"}>
            <em>
              <Inline tokens={(t as Tokens.Em).tokens} />
            </em>
          </Match>
          <Match when={t.type === "del"}>
            <del>
              <Inline tokens={(t as Tokens.Del).tokens} />
            </del>
          </Match>
          <Match when={t.type === "codespan"}>
            <span class="code">{decode((t as Tokens.Codespan).text)}</span>
          </Match>
          <Match when={t.type === "br"}>
            <br />
          </Match>
          <Match when={t.type === "link"}>
            <Link href={(t as Tokens.Link).href}>
              <Inline tokens={(t as Tokens.Link).tokens} />
            </Link>
          </Match>
          <Match when={t.type === "escape"}>{(t as Tokens.Escape).text}</Match>
          <Match when={t.type === "html"}>{(t as Tokens.HTML).text}</Match>
        </Switch>
      )}
    </For>
  );
}

function Link(props: { href: string; children: JSX.Element }) {
  const safe = /^https?:\/\//i.test(props.href);
  return safe ? (
    <a href={props.href} target="_blank" rel="noreferrer">
      {props.children}
    </a>
  ) : (
    <span class="code">{props.children}</span>
  );
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};
function decode(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m] ?? m);
}

const LANGS: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  typescript: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  javascript: "JavaScript",
  json: "JSON",
  rs: "Rust",
  rust: "Rust",
  py: "Python",
  python: "Python",
  sh: "Shell",
  bash: "Shell",
  shell: "Shell",
  ps1: "PowerShell",
  powershell: "PowerShell",
  go: "Go",
  java: "Java",
  kt: "Kotlin",
  css: "CSS",
  html: "HTML",
  md: "Markdown",
  yaml: "YAML",
  yml: "YAML",
  toml: "TOML",
  sql: "SQL",
  diff: "Diff",
  c: "C",
  cpp: "C++",
};

export function CodeBlock(props: { code: string; lang: string }) {
  const [copied, setCopied] = createSignal(false);
  const copy = () => {
    void navigator.clipboard.writeText(props.code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  };
  return (
    <div class="cb">
      <div class="cb-head">
        <span style={{ flex: 1 }}>{LANGS[props.lang.toLowerCase()] ?? (props.lang || "Code")}</span>
        <button
          type="button"
          class="gh"
          onClick={copy}
          style={{ height: "26px", color: "var(--muted)", "font-size": "12px" }}
        >
          <I d={P.copy} size={13} sw={1.7} />
          {copied() ? "Copied" : "Copy"}
        </button>
      </div>
      <pre class="mono">{props.code}</pre>
    </div>
  );
}
