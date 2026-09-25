'use client';

import { createContext, useContext, useEffect, useReducer, type ReactNode } from 'react';

import type { FeedEntry, RelayStatus, ReplayEntry, ReplayMeta, ReplaySummary } from './types';

/**
 * live       connected to the relay, messages arrive as Jev labels them
 * replay     the relay is off, out of budget or unset: a recorded real session plays instead
 * offline    neither is available
 */
export type FeedMode = 'connecting' | 'live' | 'replay' | 'offline';

interface State {
  mode: FeedMode;
  status: RelayStatus | null;
  replay: ReplayMeta | null;
  /** What the relay measured while recording the replay. */
  summary: ReplaySummary | null;
  entries: FeedEntry[];
  /** Labels seen since the page opened. */
  counts: Record<string, number>;
  total: number;
}

type Action =
  | { type: 'hello'; status: RelayStatus; recent: FeedEntry[] }
  | { type: 'status'; status: RelayStatus }
  | { type: 'entry'; entry: FeedEntry }
  | { type: 'replay'; meta: ReplayMeta | null; summary: ReplaySummary | null }
  | { type: 'offline' };

const MAX_ENTRIES = 60;
const initial: State = { mode: 'connecting', status: null, replay: null, summary: null, entries: [], counts: {}, total: 0 };

function count(entries: readonly FeedEntry[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of entries) counts[entry.label] = (counts[entry.label] ?? 0) + 1;
  return counts;
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'hello':
      return {
        ...state,
        mode: 'live',
        status: action.status,
        replay: null,
        summary: null,
        entries: action.recent.slice(-MAX_ENTRIES),
        counts: count(action.recent),
        total: action.recent.length,
      };
    case 'status':
      return { ...state, status: action.status };
    case 'entry':
      return {
        ...state,
        entries: [...state.entries, action.entry].slice(-MAX_ENTRIES),
        counts: { ...state.counts, [action.entry.label]: (state.counts[action.entry.label] ?? 0) + 1 },
        total: state.total + 1,
      };
    case 'replay':
      return { ...initial, mode: 'replay', replay: action.meta, summary: action.summary };
    case 'offline':
      return { ...initial, mode: 'offline' };
  }
}

const RelayContext = createContext<State>(initial);

export function useRelay(): State {
  return useContext(RelayContext);
}

/** How long to wait for the relay before playing the replay instead. */
const CONNECT_TIMEOUT_MS = 6_000;
/** Close the feed when the tab has been hidden this long, so the relay can leave Twitch. */
const HIDDEN_CLOSE_MS = 30_000;

export function RelayProvider({ url, children }: { url: string; children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initial);

  useEffect(() => {
    let source: EventSource | undefined;
    let stopReplay: (() => void) | undefined;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    let hiddenTimer: ReturnType<typeof setTimeout> | undefined;
    let live = false;
    let disposed = false;

    const closeSource = () => {
      clearTimeout(connectTimer);
      source?.close();
      source = undefined;
      live = false;
    };

    const fallBack = () => {
      closeSource();
      if (stopReplay || disposed) return;
      stopReplay = () => {};
      void playReplay(dispatch).then((stop) => {
        if (disposed) stop();
        else stopReplay = stop;
      });
    };

    const connect = () => {
      if (!url) return fallBack();
      const feed = new EventSource(`${url}/feed`);
      source = feed;
      connectTimer = setTimeout(() => {
        if (!live) fallBack();
      }, CONNECT_TIMEOUT_MS);

      feed.addEventListener('hello', (event) => {
        const data = JSON.parse((event as MessageEvent<string>).data) as { status: RelayStatus; recent: FeedEntry[] };
        if (data.status.state === 'budget' || data.status.state === 'offline') return fallBack();
        clearTimeout(connectTimer);
        live = true;
        stopReplay?.();
        stopReplay = undefined;
        dispatch({ type: 'hello', ...data });
      });
      feed.addEventListener('message', (event) => {
        dispatch({ type: 'entry', entry: JSON.parse((event as MessageEvent<string>).data) as FeedEntry });
      });
      feed.addEventListener('status', (event) => {
        const status = JSON.parse((event as MessageEvent<string>).data) as RelayStatus;
        if (status.state === 'budget' || status.state === 'offline') return fallBack();
        dispatch({ type: 'status', status });
      });
      // Before the first hello an error means the relay is unreachable. After it, EventSource
      // reconnects on its own and the relay says hello again.
      feed.addEventListener('error', () => {
        if (!live) fallBack();
      });
    };

    const onVisibility = () => {
      clearTimeout(hiddenTimer);
      if (document.hidden) {
        hiddenTimer = setTimeout(() => {
          if (source) closeSource();
        }, HIDDEN_CLOSE_MS);
      } else if (!source && !stopReplay) {
        connect();
      }
    };

    document.addEventListener('visibilitychange', onVisibility);
    connect();
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisibility);
      clearTimeout(hiddenTimer);
      closeSource();
      stopReplay?.();
    };
  }, [url]);

  return <RelayContext.Provider value={state}>{children}</RelayContext.Provider>;
}

/** Play public/replay.jsonl at its recorded pace, looping. Resolves to a stop function. */
async function playReplay(dispatch: (action: Action) => void): Promise<() => void> {
  let lines: unknown[];
  try {
    const response = await fetch('/replay.jsonl');
    if (!response.ok) throw new Error(String(response.status));
    lines = (await response.text())
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as unknown);
  } catch {
    dispatch({ type: 'offline' });
    return () => {};
  }

  const typed = (type: string) => lines.find((line) => (line as { type?: string }).type === type);
  const meta = (typed('meta') as ReplayMeta | undefined) ?? null;
  const summary = (typed('summary') as ReplaySummary | undefined) ?? null;
  const entries = lines.filter((line) => (line as { type?: string }).type === undefined) as ReplayEntry[];
  if (entries.length === 0) {
    dispatch({ type: 'offline' });
    return () => {};
  }
  dispatch({ type: 'replay', meta, summary });

  let loop = 0;
  let index = 0;
  const emit = (entry: ReplayEntry) => {
    const { t: _offset, ...rest } = entry;
    dispatch({ type: 'entry', entry: { ...rest, id: `${rest.id}~${loop}`, at: Date.now() } });
  };
  // Start with a screenful so the panel never looks empty.
  const prefill = Math.min(12, entries.length);
  for (; index < prefill; index++) emit(entries[index] as ReplayEntry);
  let origin = performance.now() - (entries[prefill - 1] as ReplayEntry).t;

  const timer = setInterval(() => {
    const elapsed = performance.now() - origin;
    while (index < entries.length && (entries[index] as ReplayEntry).t <= elapsed) emit(entries[index++] as ReplayEntry);
    if (index >= entries.length) {
      loop++;
      index = 0;
      origin = performance.now() + 2_000 - (entries[0] as ReplayEntry).t;
    }
  }, 100);
  return () => clearInterval(timer);
}
