// A tiny TypeScript highlighter with per-line focus and inlay hints, colored by the --tok-* variables
// in landing.css.
import type { CSSProperties, ReactNode } from 'react';

type Kind = 'kw' | 'str' | 'com' | 'fn' | 'num' | 'key' | 'punc' | 'id' | 'ws';

const KEYWORDS = new Set(['import', 'from', 'const', 'await', 'null', 'true', 'false', 'export', 'function', 'return', 'async', 'new']);
const TOKEN = /(\/\/.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\d+(?:\.\d+)?)|([A-Za-z_$][\w$]*)|(\s+)|(.)/gm;

function tokenize(line: string): Array<{ kind: Kind; text: string }> {
  const out: Array<{ kind: Kind; text: string }> = [];
  for (const m of line.matchAll(TOKEN)) {
    const [text, com, str, num, id, ws] = m;
    if (com) out.push({ kind: 'com', text });
    else if (str) out.push({ kind: 'str', text });
    else if (num) out.push({ kind: 'num', text });
    else if (id) {
      const rest = line.slice((m.index ?? 0) + text.length);
      if (KEYWORDS.has(id)) out.push({ kind: 'kw', text });
      else if (/^\s*\(/.test(rest)) out.push({ kind: 'fn', text });
      else if (/^\s*:/.test(rest) && !/^\s*::/.test(rest)) out.push({ kind: 'key', text });
      else out.push({ kind: 'id', text });
    } else if (ws) out.push({ kind: 'ws', text });
    else out.push({ kind: 'punc', text });
  }
  return out;
}

/** Indents a wrapped line's continuation four columns past where its code starts, deeper than a nested line. */
function hanging(line: string): CSSProperties {
  const hang = line.length - line.trimStart().length + 4;
  return { paddingLeft: `${hang}ch`, textIndent: `-${hang}ch` };
}

const COLOR: Record<Kind, string | undefined> = {
  kw: 'var(--tok-kw)',
  str: 'var(--tok-str)',
  com: 'var(--tok-com)',
  fn: 'var(--tok-fn)',
  num: 'var(--tok-num)',
  key: 'var(--tok-key)',
  punc: 'var(--tok-punc)',
  id: 'var(--tok-id)',
  ws: undefined,
};

export function CodeLines({
  code,
  active = [],
  inlays = {},
  lineNumbers = true,
  className,
  style,
  lineClassName = '',
  activeClassName = '',
  dimOpacity = 0.32,
  only,
  wrap = false,
}: {
  code: string;
  active?: number[];
  inlays?: Record<number, ReactNode>;
  lineNumbers?: boolean;
  className?: string;
  style?: CSSProperties;
  lineClassName?: string;
  activeClassName?: string;
  dimOpacity?: number;
  /** Render just these 1-based lines (an excerpt), with a ⋯ row for each gap. */
  only?: number[];
  /** Wrap long lines instead of letting them run off the edge, indenting the continuation. */
  wrap?: boolean;
}) {
  const lines = code.split('\n');
  const focusing = active.length > 0 && !only;
  return (
    <pre className={className} style={style}>
      <code className="block">
        {lines.map((line, i) => {
          const n = i + 1;
          const on = active.includes(n);
          if (only && !only.includes(n)) {
            return only.includes(n + 1) && only.some((m) => m < n) ? (
              <span key={n} className="flex select-none" style={{ color: 'var(--tok-ln)' }}>
                {lineNumbers && <span className="w-8 shrink-0 pr-3 text-right">⋯</span>}
              </span>
            ) : null;
          }
          return (
            <span
              key={n}
              className={`relative flex transition-[opacity,background-color] duration-500 ${lineClassName} ${on ? activeClassName : ''}`}
              style={{ opacity: focusing && !on ? dimOpacity : 1 }}
            >
              {lineNumbers && (
                <span className="w-8 shrink-0 pr-3 text-right select-none" style={{ color: 'var(--tok-ln)' }}>
                  {n}
                </span>
              )}
              <span className={wrap ? 'min-w-0 break-words whitespace-pre-wrap' : 'whitespace-pre'} style={wrap ? hanging(line) : undefined}>
                {line.length === 0 ? ' ' : tokenize(line).map((t, j) => (
                  <span key={j} style={{ color: COLOR[t.kind] }}>
                    {t.text}
                  </span>
                ))}
                {inlays[n]}
              </span>
            </span>
          );
        })}
      </code>
    </pre>
  );
}
