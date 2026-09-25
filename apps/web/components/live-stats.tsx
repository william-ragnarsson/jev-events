'use client';

import { cn } from '@/lib/cn';
import { formatUsd } from './live-feed';
import { useRelay } from './relay/relay-provider';

const whole = new Intl.NumberFormat('en');

interface Stat {
  value: string;
  label: string;
}

/** Numbers the relay measured: right now when live, or while the replay was recorded. Never estimates. */
export function LiveStats() {
  const { mode, status, summary } = useRelay();
  let caption: string;
  let stats: Stat[];

  if (mode === 'live' && status) {
    caption = 'Measured by the live relay right now';
    stats = [
      { value: status.latencyMs.p50 === null ? '…' : `${status.latencyMs.p50} ms`, label: 'median time to a label' },
      { value: whole.format(status.today.judged), label: 'messages labeled today' },
      { value: formatUsd(status.today.spendUsd), label: 'spent on Jev today' },
      { value: `${status.judgedPerSecond.toFixed(1)}/s`, label: `labeled, of ${status.chatPerSecond.toFixed(1)}/s in chat` },
    ];
  } else if (mode === 'replay' && summary) {
    caption = 'Measured while the replay was recorded';
    stats = [
      { value: summary.latencyMs.p50 === null ? '–' : `${summary.latencyMs.p50} ms`, label: 'median time to a label' },
      { value: whole.format(summary.judged), label: `messages in ${Math.max(1, Math.round(summary.durationMs / 60_000))} minutes` },
      { value: formatUsd(summary.spendUsd), label: 'spent on Jev' },
      {
        value: summary.judged > 0 ? formatUsd((summary.spendUsd / summary.judged) * 1_000) : '–',
        label: 'per 1,000 messages',
      },
    ];
  } else if (mode === 'connecting') {
    caption = '';
    stats = [];
  } else {
    return null;
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
      <dl className="grid grid-cols-2 overflow-hidden rounded-2xl border bg-fd-card md:grid-cols-4">
        {(stats.length > 0 ? stats : Array.from({ length: 4 }, () => null)).map((stat, index) => (
          <div
            key={index}
            className={cn('flex flex-col gap-1 p-5 md:p-6', index % 2 === 1 && 'border-l', index > 1 && 'border-t md:border-t-0', index === 2 && 'md:border-l')}
          >
            {stat ? (
              <>
                <dt className="order-2 text-xs text-fd-muted-foreground">{stat.label}</dt>
                <dd className="order-1 font-mono text-2xl font-medium tracking-tight tabular-nums">{stat.value}</dd>
              </>
            ) : (
              <>
                <span className="skeleton animate-shimmer h-7 w-24 rounded" />
                <span className="skeleton animate-shimmer mt-1 h-3 w-32 rounded" />
              </>
            )}
          </div>
        ))}
      </dl>
      {caption && (
        <p className="mt-3 flex items-center gap-2 text-xs text-fd-muted-foreground">
          <span className={cn('size-1.5 rounded-full', mode === 'live' ? 'animate-live bg-red-500 text-red-500' : 'bg-fd-muted-foreground')} />
          {caption}
        </p>
      )}
    </div>
  );
}
