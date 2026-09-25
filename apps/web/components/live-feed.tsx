'use client';

import { Radio } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';

import { cn } from '@/lib/cn';
import { useRelay, type FeedMode } from './relay/relay-provider';
import type { FeedEntry, RelayStatus, ReplayMeta } from './relay/types';

export const LABELS = ['question', 'hype', 'joke', 'backseat', 'spam', 'other', 'hateful'] as const;

export const LABEL_STYLES: Record<string, string> = {
  question: 'text-sky-700 bg-sky-500/10 ring-sky-500/25 dark:text-sky-300',
  hype: 'text-amber-700 bg-amber-500/10 ring-amber-500/25 dark:text-amber-300',
  joke: 'text-fuchsia-700 bg-fuchsia-500/10 ring-fuchsia-500/25 dark:text-fuchsia-300',
  backseat: 'text-violet-700 bg-violet-500/10 ring-violet-500/25 dark:text-violet-300',
  spam: 'text-orange-700 bg-orange-500/10 ring-orange-500/25 dark:text-orange-300',
  other: 'text-fd-muted-foreground bg-fd-muted ring-fd-border',
  hateful: 'text-red-700 bg-red-500/10 ring-red-500/30 dark:text-red-300',
};

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat('en');

export function formatUsd(value: number): string {
  if (value === 0) return '$0';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(value < 1 ? 3 : 2)}`;
}

export function LabelChip({ label, p, className }: { label: string; p?: number; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center justify-between gap-1.5 rounded-md px-1.5 font-mono text-[11px] ring-1 ring-inset',
        LABEL_STYLES[label] ?? LABEL_STYLES.other,
        className,
      )}
    >
      <span>{label}</span>
      {p !== undefined && <span className="tabular-nums opacity-70">{Math.round(p * 100)}%</span>}
    </span>
  );
}

/** The landing page centerpiece: a public Twitch chat, labeled by Jev as it happens. */
export function LiveFeed() {
  const { mode, status, replay, entries, counts, total } = useRelay();
  const [filter, setFilter] = useState<string | null>(null);
  const newestFirst = useMemo(
    () => (filter ? entries.filter((entry) => entry.label === filter) : entries).slice().reverse(),
    [entries, filter],
  );

  return (
    <div className="relative">
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-x-10 -inset-y-12 -z-10 rounded-[3rem] bg-signal-soft blur-3xl"
      />
      <figure className="relative overflow-hidden rounded-2xl border bg-fd-card shadow-2xl shadow-black/10 dark:shadow-black/60">
        <Header mode={mode} status={status} replay={replay} />
        {(mode === 'live' || mode === 'replay') && (
          <Legend counts={counts} total={total} filter={filter} onFilter={setFilter} />
        )}
        <div className="relative h-[360px] sm:h-[420px]">
          {mode === 'connecting' && <Skeleton />}
          {mode === 'offline' && <Offline />}
          {(mode === 'live' || mode === 'replay') && entries.length === 0 && (
            <Listening channel={status?.stream?.channel} />
          )}
          {(mode === 'live' || mode === 'replay') && entries.length > 0 && (
            <ol
              aria-label="Labeled chat messages"
              className="flex h-full flex-col-reverse gap-px overflow-y-auto overscroll-contain p-2 [scrollbar-width:thin]"
            >
              {newestFirst.map((entry) => (
                <Row key={entry.id} entry={entry} />
              ))}
              {newestFirst.length === 0 && (
                <li className="m-auto text-sm text-fd-muted-foreground">No {filter} messages yet.</li>
              )}
            </ol>
          )}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-10 bg-gradient-to-b from-fd-card to-transparent"
          />
        </div>
        <Footer mode={mode} status={status} replay={replay} />
      </figure>
    </div>
  );
}

function Header({ mode, status, replay }: { mode: FeedMode; status: RelayStatus | null; replay: ReplayMeta | null }) {
  const stream = status?.stream;
  return (
    <div className="flex items-center gap-3 border-b px-4 py-3 text-xs">
      <ModeBadge mode={mode} />
      <div className="min-w-0 flex-1 truncate text-fd-muted-foreground">
        {mode === 'live' && stream && (
          <>
            <span className="font-medium text-fd-foreground">#{stream.channel}</span>
            {stream.game && <> · {stream.game}</>}
            {stream.viewers !== undefined && <> · {compact.format(stream.viewers)} viewers</>}
          </>
        )}
        {mode === 'live' && !stream && 'Finding a busy public chat…'}
        {mode === 'replay' && (
          <>
            Recorded{replay?.channel ? <> in <span className="font-medium text-fd-foreground">#{replay.channel}</span></> : ''}
            {replay?.recordedAt && <> on {new Date(replay.recordedAt).toLocaleDateString('en', { month: 'short', day: 'numeric' })}</>}
          </>
        )}
        {mode === 'connecting' && 'Connecting to a public Twitch chat…'}
        {mode === 'offline' && 'Public Twitch chat, labeled by Jev'}
      </div>
      {mode === 'live' && status?.latencyMs.p50 != null && (
        <span className="shrink-0 font-mono text-fd-muted-foreground tabular-nums">
          p50 <span className="text-fd-foreground">{status.latencyMs.p50} ms</span>
        </span>
      )}
    </div>
  );
}

function ModeBadge({ mode }: { mode: FeedMode }) {
  const styles: Record<FeedMode, { text: string; dot: string; label: string }> = {
    live: { text: 'text-red-600 dark:text-red-400', dot: 'bg-red-500 animate-live', label: 'Live' },
    replay: { text: 'text-fd-muted-foreground', dot: 'bg-fd-muted-foreground', label: 'Replay' },
    connecting: { text: 'text-fd-muted-foreground', dot: 'bg-fd-muted-foreground animate-live', label: 'Connecting' },
    offline: { text: 'text-fd-muted-foreground', dot: 'bg-fd-muted-foreground/50', label: 'Resting' },
  };
  const style = styles[mode];
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1.5 font-semibold tracking-wider uppercase', style.text)}>
      <span className={cn('size-1.5 rounded-full text-red-500', style.dot)} />
      {style.label}
    </span>
  );
}

function Legend({
  counts,
  total,
  filter,
  onFilter,
}: {
  counts: Record<string, number>;
  total: number;
  filter: string | null;
  onFilter: (label: string | null) => void;
}) {
  const chip = (active: boolean) =>
    cn(
      'inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border px-2.5 font-mono text-[11px] transition-colors',
      active ? 'border-fd-foreground/30 bg-fd-accent text-fd-foreground' : 'text-fd-muted-foreground hover:text-fd-foreground',
    );
  return (
    <div className="flex gap-1.5 overflow-x-auto border-b px-3 py-2 [scrollbar-width:none]" role="toolbar" aria-label="Filter by label">
      <button type="button" aria-pressed={filter === null} className={chip(filter === null)} onClick={() => onFilter(null)}>
        all <span className="tabular-nums opacity-60">{whole.format(total)}</span>
      </button>
      {LABELS.map((label) => (
        <button
          key={label}
          type="button"
          aria-pressed={filter === label}
          className={chip(filter === label)}
          onClick={() => onFilter(filter === label ? null : label)}
        >
          <span className={cn('size-1.5 rounded-full', DOT[label])} />
          {label} <span className="tabular-nums opacity-60">{whole.format(counts[label] ?? 0)}</span>
        </button>
      ))}
    </div>
  );
}

const DOT: Record<string, string> = {
  question: 'bg-sky-500',
  hype: 'bg-amber-500',
  joke: 'bg-fuchsia-500',
  backseat: 'bg-violet-500',
  spam: 'bg-orange-500',
  other: 'bg-fd-muted-foreground',
  hateful: 'bg-red-500',
};

function Row({ entry }: { entry: FeedEntry }) {
  return (
    <li className="grid animate-feed-in grid-cols-[6.5rem_minmax(0,1fr)] items-start gap-x-3 rounded-lg px-2 py-1.5 hover:bg-fd-accent/40 sm:grid-cols-[7rem_minmax(0,1fr)_auto]">
      <LabelChip label={entry.label} p={entry.p} className="mt-px w-full" />
      <p className="line-clamp-3 text-[13px] leading-5 break-words">
        <span className="mr-2 font-mono text-[11px] text-fd-muted-foreground">{entry.user}</span>
        {entry.text === null ? (
          <span className="redacted rounded px-2 py-0.5 text-[11px] font-medium text-red-700 dark:text-red-300">
            hidden by Jev
          </span>
        ) : (
          entry.text
        )}
      </p>
      <span className="hidden pt-0.5 font-mono text-[11px] text-fd-muted-foreground tabular-nums sm:block">
        {entry.cached ? 'cached' : `${entry.latencyMs} ms`}
      </span>
    </li>
  );
}

function Skeleton() {
  return (
    <ul aria-hidden className="flex h-full flex-col justify-end gap-2.5 p-4">
      {[62, 88, 45, 74, 92, 55, 80, 38, 68].map((width, index) => (
        <li key={index} className="flex items-center gap-3">
          <span className="skeleton animate-shimmer h-5 w-24 rounded-md" />
          <span className="skeleton animate-shimmer h-3.5 rounded" style={{ width: `${width}%` }} />
        </li>
      ))}
    </ul>
  );
}

/** Connected, but chat hasn't said anything labeled yet. */
function Listening({ channel }: { channel: string | undefined }) {
  return (
    <div className="relative h-full">
      <div className="opacity-40">
        <Skeleton />
      </div>
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-center">
        <p className="text-sm font-medium">{channel ? `Listening to #${channel}…` : 'Finding a busy public chat…'}</p>
        <p className="text-xs text-fd-muted-foreground">Labels appear here as chat talks.</p>
      </div>
    </div>
  );
}

function Offline() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
      <Radio className="size-6 text-fd-muted-foreground" />
      <p className="font-medium">The live demo is resting</p>
      <p className="max-w-xs text-sm text-fd-muted-foreground">
        It reads a public Twitch chat only while someone is watching, within a daily budget. Try it on any channel from
        your terminal:
      </p>
      <code className="rounded-md border bg-fd-secondary px-3 py-1.5 font-mono text-xs">
        npx jev-events watch twitch:&lt;channel&gt;
      </code>
    </div>
  );
}

function Footer({ mode, status, replay }: { mode: FeedMode; status: RelayStatus | null; replay: ReplayMeta | null }) {
  let text: ReactNode = null;
  if (mode === 'live' && status) {
    text = (
      <>
        labeling <Num>{status.judgedPerSecond.toFixed(1)}</Num> of <Num>{status.chatPerSecond.toFixed(1)}</Num> msg/s ·{' '}
        <Num>{whole.format(status.today.judged)}</Num> today · <Num>{formatUsd(status.today.spendUsd)}</Num> spent today
      </>
    );
  } else if (mode === 'replay') {
    text = <>A real session labeled by {replay?.model ?? 'Jev'}. The live relay is resting.</>;
  } else if (mode === 'connecting') {
    text = 'Usernames are anonymized. Hateful messages are hidden before they reach you.';
  }
  return (
    <div className="flex items-center justify-between gap-3 border-t px-4 py-2.5 text-[11px] text-fd-muted-foreground">
      <span className="min-w-0 truncate">{text}</span>
      <a href="#relay" className="shrink-0 font-medium text-fd-foreground/80 hover:text-fd-foreground">
        How it works ↓
      </a>
    </div>
  );
}

function Num({ children }: { children: ReactNode }) {
  return <span className="font-mono text-fd-foreground tabular-nums">{children}</span>;
}
