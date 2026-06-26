import { Fragment, useMemo, type ReactNode } from "react";
import { parseMarkdown, type MdAlign, type MdInline } from "exfer-agent";
import { copyText } from "../lib/clipboard";

// Renders an agent message's markdown into the mobile design system. Parsing is
// shared (exfer-agent core, XSS-safe: no raw HTML, scheme-allowlisted links);
// styling lives in the `.md` scope in exfer.css so the agent chat reuses the
// app's type tokens instead of inline magic numbers. Memoized on the source.

// Addresses / tx-hashes the agent emits inline: 0x EVM addrs, bare 56-64-hex
// (exfer pubkeys / tx ids), and bech32-style xf… addresses. We turn each into a
// tappable copy chip so a long unreadable string becomes head6…tail6 + copy.
const ENTITY_RE = /\b(0x[0-9a-fA-F]{40}|[0-9a-fA-F]{56,64}|xf[0-9a-z]{20,})\b/g;

function EntityChip({ value }: { value: string }) {
  const short = value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-6)}` : value;
  return (
    <button
      type="button"
      className="md-chip mono"
      title={value}
      onClick={(e) => {
        e.stopPropagation();
        void copyText(value);
      }}
    >
      {short}
      <span className="md-chip-copy" aria-hidden="true">⧉</span>
    </button>
  );
}

// Split a plain text run on the entity regex, rendering matches as chips and the
// gaps as text. Non-matching text renders normally.
function renderText(text: string, keyBase: number): ReactNode {
  ENTITY_RE.lastIndex = 0;
  if (!ENTITY_RE.test(text)) return <Fragment key={keyBase}>{text}</Fragment>;
  ENTITY_RE.lastIndex = 0;
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = ENTITY_RE.exec(text)) !== null) {
    if (m.index > last) out.push(<Fragment key={`${keyBase}-t${k}`}>{text.slice(last, m.index)}</Fragment>);
    out.push(<EntityChip key={`${keyBase}-c${k}`} value={m[0]} />);
    last = m.index + m[0].length;
    k++;
  }
  if (last < text.length) out.push(<Fragment key={`${keyBase}-t${k}`}>{text.slice(last)}</Fragment>);
  return <Fragment key={keyBase}>{out}</Fragment>;
}

function renderInline(nodes: MdInline[]): ReactNode {
  return nodes.map((n, i) => {
    switch (n.t) {
      case "text":
        return renderText(n.v, i);
      case "strong":
        return <strong key={i}>{renderInline(n.c)}</strong>;
      case "em":
        return <em key={i}>{renderInline(n.c)}</em>;
      case "code":
        return (
          <code key={i} className="mono">
            {n.v}
          </code>
        );
      case "link":
        return (
          <a key={i} href={n.href} target="_blank" rel="noopener noreferrer">
            {renderInline(n.c)}
          </a>
        );
    }
  });
}

const alignOf = (a: MdAlign): "left" | "center" | "right" => (a === "center" ? "center" : a === "right" ? "right" : "left");

export function Markdown({ source }: { source: string }) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  return (
    <div className="md">
      {blocks.map((b, i) => {
        switch (b.t) {
          case "p":
            return <p key={i}>{renderInline(b.c)}</p>;
          case "h": {
            const Tag = (b.level <= 1 ? "h3" : b.level === 2 ? "h4" : "h5") as "h3" | "h4" | "h5";
            return <Tag key={i}>{renderInline(b.c)}</Tag>;
          }
          case "ul":
            return (
              <ul key={i}>
                {b.items.map((it, j) => (
                  <li key={j}>{renderInline(it)}</li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={i} start={b.start}>
                {b.items.map((it, j) => (
                  <li key={j}>{renderInline(it)}</li>
                ))}
              </ol>
            );
          case "code":
            return (
              <pre key={i} className="mono">
                <code>{b.v}</code>
              </pre>
            );
          case "table":
            return (
              <div key={i} className="md-table-wrap">
                <table>
                  <thead>
                    <tr>
                      {b.header.map((cell, j) => (
                        <th key={j} style={{ textAlign: alignOf(b.align[j] ?? null) }}>
                          {renderInline(cell)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((row, r) => (
                      <tr key={r}>
                        {row.map((cell, c) => (
                          <td key={c} style={{ textAlign: alignOf(b.align[c] ?? null) }}>
                            {renderInline(cell)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
        }
      })}
    </div>
  );
}
