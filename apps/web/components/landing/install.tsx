'use client';

import { Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';

import { COPY } from './content';

/** The install command as plain text with a copy button, not another boxed button. */
export function InstallCommand() {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      aria-label={`Copy "${COPY.install}"`}
      onClick={() => {
        void navigator.clipboard?.writeText(COPY.install).then(
          () => setCopied(true),
          () => {},
        );
      }}
      className="group inline-flex h-11 items-center gap-2.5 font-mono text-[13.5px] text-[var(--muted)] transition-colors hover:text-[var(--fg)]"
    >
      <span className="text-[var(--accent)]">$</span>
      {COPY.install}
      {copied ? (
        <Check className="size-3.5 text-[var(--accent)]" />
      ) : (
        <Copy className="size-3.5 opacity-50 transition-opacity group-hover:opacity-100" />
      )}
      <span aria-live="polite" className="sr-only">
        {copied ? 'Copied' : ''}
      </span>
    </button>
  );
}
