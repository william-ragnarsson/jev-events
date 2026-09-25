import type { Item, Source } from "../types.js";
import { reconnecting } from "./socket.js";

export interface BlueskyPostItem extends Item {
  did: string;
  rkey: string;
  /** at:// URI of the post. */
  uri: string;
  /** Link to the post on bsky.app. */
  url: string;
  langs: string[];
}

export interface BlueskyOptions {
  /** Only posts containing one of these words or phrases (case-insensitive). */
  keywords?: string[];
  /** Only posts tagged with one of these languages, e.g. ["en"]. */
  langs?: string[];
  /** Jetstream endpoint. Default "wss://jetstream2.us-east.bsky.network/subscribe". */
  endpoint?: string;
}

interface JetstreamEvent {
  did: string;
  time_us: number;
  kind: string;
  commit?: {
    operation: string;
    collection: string;
    rkey: string;
    record?: { text?: string; langs?: string[]; createdAt?: string; reply?: unknown };
  };
}

/**
 * Every new public Bluesky post, from the Jetstream firehose. No login needed. The firehose is
 * busy, so pass `keywords` or `langs`, or let the listener's rate limit sample it.
 */
export function bluesky(options: BlueskyOptions = {}): Source<BlueskyPostItem, "bluesky"> {
  const keywords = options.keywords?.map((keyword) => keyword.toLowerCase()).filter(Boolean);
  const langs = options.langs?.length ? new Set(options.langs) : undefined;
  const endpoint = options.endpoint ?? "wss://jetstream2.us-east.bsky.network/subscribe";
  let cursor: number | undefined;

  return {
    id: `bluesky:posts${keywords?.length ? `:${keywords.join(",")}` : ""}`,
    platform: "bluesky",
    noun: "post",
    canAct: false,
    defaults: { maxLagMs: 10_000 },
    start(ctx) {
      return reconnecting({
        url: () => {
          const url = new URL(endpoint);
          url.searchParams.set("wantedCollections", "app.bsky.feed.post");
          if (cursor) url.searchParams.set("cursor", String(cursor));
          return url.toString();
        },
        signal: ctx.signal,
        log: ctx.log,
        label: "bluesky jetstream",
        readyTimeoutMs: 15_000,
        idleTimeoutMs: 60_000,
        onOpen: () => undefined,
        onMessage(data, _socket, ready) {
          ready();
          let event: JetstreamEvent;
          try {
            event = JSON.parse(data) as JetstreamEvent;
          } catch {
            return;
          }
          cursor = event.time_us;
          const commit = event.commit;
          const text = commit?.record?.text;
          if (event.kind !== "commit" || commit?.operation !== "create" || !text) return;
          const postLangs = commit.record?.langs ?? [];
          if (langs && !postLangs.some((lang) => langs.has(lang))) return;
          if (keywords?.length) {
            const lower = text.toLowerCase();
            if (!keywords.some((keyword) => lower.includes(keyword))) return;
          }
          ctx.emit({
            id: `${event.did}/${commit.rkey}`,
            text,
            author: { id: event.did, name: event.did.replace(/^did:plc:/, "").slice(0, 10) },
            at: new Date(commit.record?.createdAt ?? event.time_us / 1000),
            did: event.did,
            rkey: commit.rkey,
            uri: `at://${event.did}/app.bsky.feed.post/${commit.rkey}`,
            url: `https://bsky.app/profile/${event.did}/post/${commit.rkey}`,
            langs: postLangs,
            ...(commit.record?.reply ? { facts: { isReply: true } } : {}),
          });
        },
        onError: (error) => ctx.log.debug(error.message),
      });
    },
  };
}
