'use client';

import { buttonVariants } from 'fumadocs-ui/components/ui/button';
import { Check, Copy } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';

import { cn } from '@/lib/cn';

/** Form controls shared by the code builder and the agent prompt. */

export const INPUT =
  'w-full rounded-md border bg-fd-background px-2 py-1.5 text-sm text-fd-foreground placeholder:text-fd-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring';

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (value: T) => void;
  options: readonly { value: T; label: string }[];
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex shrink-0 rounded-lg border bg-fd-background p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          onClick={() => onChange(option.value)}
          className={cn(
            'rounded-md px-3 py-1 text-sm font-medium transition-colors',
            option.value === value ? 'bg-fd-primary text-fd-primary-foreground' : 'text-fd-muted-foreground hover:text-fd-foreground',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Copies what `text` returns when clicked, and says so for a moment. */
export function CopyButton({ text, children }: { text: () => string; children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      className={buttonVariants({ variant: 'secondary', size: 'sm' })}
      onClick={() => void navigator.clipboard.writeText(text()).then(() => setCopied(true))}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      <span aria-live="polite">{copied ? 'Copied' : children}</span>
    </button>
  );
}
