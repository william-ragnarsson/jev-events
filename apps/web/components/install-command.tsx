'use client';

import { Check, Copy } from 'lucide-react';
import { useState } from 'react';

import { cn } from '@/lib/cn';

export function InstallCommand({ command, className }: { command: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(command).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1_500);
        });
      }}
      className={cn(
        'group inline-flex h-11 max-w-full items-center gap-3 rounded-lg border bg-fd-card px-4 font-mono text-sm shadow-sm transition-colors hover:bg-fd-accent',
        className,
      )}
      aria-label={`Copy "${command}"`}
    >
      <span className="text-fd-muted-foreground select-none">$</span>
      <span className="truncate">{command}</span>
      {copied ? (
        <Check className="size-4 shrink-0 text-signal" />
      ) : (
        <Copy className="size-4 shrink-0 text-fd-muted-foreground transition-colors group-hover:text-fd-foreground" />
      )}
    </button>
  );
}
