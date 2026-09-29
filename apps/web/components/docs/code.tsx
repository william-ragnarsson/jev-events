'use client';

import { type ComponentProps, Fragment, useEffect, useRef, useState } from 'react';

import { markedChars, segments } from '@/lib/docs-code';

/**
 * The docs' three kinds of code: a panel with a file name for code, a box for commands to run, and
 * a grey box for what they print. `Pre` picks one from the fence's language and title; the builder
 * draws its generated files with `CodeLines`, in the same lines.
 */

const SHELL = new Set(['bash', 'sh', 'shell', 'shellscript', 'zsh', 'console']);
const OUTPUT = new Set(['txt', 'text', 'plaintext', 'plain']);
const LANGUAGES: Record<string, string> = {
  ts: 'TypeScript',
  tsx: 'TypeScript',
  typescript: 'TypeScript',
  js: 'JavaScript',
  json: 'JSON',
  html: 'HTML',
  css: 'CSS',
  yaml: 'YAML',
  dotenv: '.env',
};

/**
 * Puts `text` on the clipboard. Text still on its way is handed over as a promise, inside the
 * click, since Safari refuses a write that starts after it.
 */
function write(text: string | Promise<string>): Promise<void> {
  if (typeof text === 'string') return navigator.clipboard.writeText(text);
  if (typeof ClipboardItem === 'undefined') return text.then((value) => navigator.clipboard.writeText(value));
  const blob = text.then((value) => new Blob([value], { type: 'text/plain' }));
  return navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
}

/**
 * Copies `text()` and says "Copied" for two seconds, or with `hold`, until `reset` changes, such as
 * the code it copies.
 */
export function CopyButton({
  text,
  label = 'Copy',
  className = 'docs-copy',
  reset,
  hold = false,
}: {
  text: () => string | Promise<string>;
  label?: string;
  className?: string;
  reset?: unknown;
  hold?: boolean;
}) {
  const [result, setResult] = useState<{ ok: boolean; reset: unknown } | null>(null);
  // What was copied has changed, so it no longer says Copied, even if it changes back.
  if (result && result.reset !== reset) setResult(null);

  useEffect(() => {
    if (!result || (result.ok && hold)) return;
    const timer = setTimeout(() => setResult(null), 2000);
    return () => clearTimeout(timer);
  }, [result, hold]);

  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        const copying = reset;
        let written: Promise<void>;
        try {
          written = write(text());
        } catch (error) {
          written = Promise.reject(error);
        }
        written.then(
          () => setResult({ ok: true, reset: copying }),
          () => setResult({ ok: false, reset: copying }),
        );
      }}
    >
      <span aria-live="polite">{result ? (result.ok ? 'Copied' : "Couldn't copy") : label}</span>
    </button>
  );
}

type PreProps = ComponentProps<'pre'> & { title?: string; 'data-lang'?: string };

/** Every fence in the docs, and every snippet. */
export function Pre({ title, 'data-lang': lang = 'plaintext', children }: PreProps) {
  const ref = useRef<HTMLPreElement>(null);
  const copy = () => ref.current?.textContent ?? '';

  if (!title && OUTPUT.has(lang)) {
    return <pre className="docs-output">{children}</pre>;
  }

  if (!title && SHELL.has(lang)) {
    return (
      <div className="docs-cmd">
        <pre ref={ref}>{children}</pre>
        <CopyButton text={copy} />
      </div>
    );
  }

  return (
    <div className="docs-panel">
      <div className="docs-panel-bar">
        <span className="docs-file">{title ?? LANGUAGES[lang] ?? lang}</span>
        <CopyButton text={copy} />
      </div>
      <pre ref={ref} tabIndex={0}>
        {children}
      </pre>
    </div>
  );
}

/** Where a line's comment starts: `//` outside a string, at the start or after a space. */
function commentStart(line: string, lang: string): number {
  if ((lang === 'dotenv' || SHELL.has(lang)) && line.trimStart().startsWith('#')) return 0;
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quote) {
      if (char === '\\') i++;
      else if (char === quote) quote = '';
    } else if (char === '"' || char === "'" || char === '`') {
      quote = char;
    } else if (char === '/' && line[i + 1] === '/' && (i === 0 || /\s/.test(line[i - 1]))) {
      return i;
    }
  }
  return -1;
}

/**
 * Code drawn in the browser, for the builder: the same lines as a highlighted fence, with comments
 * in grey and each of `marks` in blue.
 */
export function CodeLines({ code, lang, marks = [] }: { code: string; lang: string; marks?: string[] }) {
  const lines = code.split('\n');
  return (
    <code>
      {lines.map((line, index) => {
        const start = commentStart(line, lang);
        const comment = Array.from({ length: line.length }, (_, at) => start !== -1 && at >= start);
        return (
          <Fragment key={index}>
            <span className="line">
              {segments(line, comment, markedChars(line, marks)).map((segment, s) => {
                const parts = segment.parts.map((part, p) =>
                  part.comment ? (
                    <span key={p} className="code-comment">
                      {part.text}
                    </span>
                  ) : (
                    part.text
                  ),
                );
                return segment.marked ? (
                  <mark key={s} className="code-mark">
                    {parts}
                  </mark>
                ) : (
                  <Fragment key={s}>{parts}</Fragment>
                );
              })}
            </span>
            {index < lines.length - 1 ? '\n' : null}
          </Fragment>
        );
      })}
    </code>
  );
}
