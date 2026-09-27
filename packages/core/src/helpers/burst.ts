import { toMs, type Duration } from "../duration.js";

export interface BurstOptions<E> {
  /** How many triggers inside the window make a burst. */
  count: number;
  /** The sliding window, e.g. "30s". */
  within: Duration;
  /** Count each key once, e.g. `(e) => e.item.author?.id` for distinct people. */
  distinctBy?: (event: E) => string | undefined;
  /** Quiet period after a burst fires. Defaults to `within`. */
  cooldown?: Duration;
  now?: () => number;
}

export interface Burst<E> {
  events: E[];
  first: E;
  last: E;
}

/**
 * Wrap a handler so it runs only when an outcome fires `count` times within a window.
 * Jev judges each message; code does the counting.
 *
 * The count lives in this process, so use it with live streams in a worker (`start()`), not
 * with checks from the cron route, where each request starts from zero.
 *
 * @example
 * ```ts
 * chat.on("streamIssue", burst({ count: 5, within: "30s", distinctBy: (e) => e.item.author?.id },
 *   () => alertStreamer("Chat says the stream is broken")));
 * ```
 */
export function burst<E>(options: BurstOptions<E>, handler: (burst: Burst<E>) => unknown): (event: E) => unknown {
  const windowMs = toMs(options.within);
  const cooldownMs = options.cooldown === undefined ? windowMs : toMs(options.cooldown);
  const now = options.now ?? Date.now;
  let entries: Array<{ at: number; key: string | undefined; event: E }> = [];
  let quietUntil = 0;

  return function burstHandler(event: E) {
    const at = now();
    if (at < quietUntil) return;
    entries = entries.filter((entry) => at - entry.at <= windowMs);
    const key = options.distinctBy?.(event);
    if (key !== undefined) entries = entries.filter((entry) => entry.key !== key);
    entries.push({ at, key, event });
    if (entries.length < options.count) return;

    const events = entries.map((entry) => entry.event);
    entries = [];
    quietUntil = at + cooldownMs;
    return handler({ events, first: events[0] as E, last: events[events.length - 1] as E });
  };
}
