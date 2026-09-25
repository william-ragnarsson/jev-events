// The live relay's wire format. The source of truth is apps/live-relay/src/relay.ts;
// apps/web/test/relay-types.test.ts fails if these drift apart.

export type RelayState = "idle" | "connecting" | "live" | "budget" | "offline";

export interface FeedEntry {
  id: string;
  user: string;
  text: string | null;
  label: string;
  p: number;
  hateful: number;
  latencyMs: number;
  cached: boolean;
  at: number;
}

export interface StreamInfo {
  channel: string;
  game?: string;
  viewers?: number;
}

export interface RelayStatus {
  state: RelayState;
  stream: StreamInfo | null;
  watching: number;
  chatPerSecond: number;
  judgedPerSecond: number;
  today: { judged: number; inputTokens: number; spendUsd: number; budgetUsed: number };
  latencyMs: { p50: number | null; p95: number | null };
  model: string | null;
  since: number | null;
}

/** First line of public/replay.jsonl, written by `npm run record` in apps/live-relay. */
export interface ReplayMeta {
  type: "meta";
  recordedAt: string;
  channel: string | null;
  model: string | null;
}

/** Last line of the replay: what the relay measured while recording. */
export interface ReplaySummary {
  type: "summary";
  durationMs: number;
  judged: number;
  inputTokens: number;
  spendUsd: number;
  latencyMs: { p50: number | null; p95: number | null };
}

export type ReplayEntry = FeedEntry & { t: number };
