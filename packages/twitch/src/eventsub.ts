import { needsSignIn, type SourceContext } from "jev-events";
import { chatFacts, ignoredChat, rolesFromBadges, type ChatIgnoreOptions, type TwitchChatItem } from "jev-events/public";

import { TwitchAuthError } from "./auth.js";
import { TwitchApiError } from "./helix.js";
import type { TwitchSession } from "./session.js";

/** A message on an EventSub WebSocket. */
export interface EventSubMessage {
  metadata: { message_id: string; message_type: string; message_timestamp: string; subscription_type?: string };
  payload: {
    session?: { id: string; status?: string; keepalive_timeout_seconds: number | null; reconnect_url: string | null };
    subscription?: { id?: string; type: string; status: string };
    event?: ChatMessageEvent;
  };
}

/** The part of a `channel.chat.message` event that becomes a chat item. */
export interface ChatMessageEvent {
  broadcaster_user_id: string;
  broadcaster_user_login: string;
  chatter_user_id: string;
  chatter_user_login: string;
  chatter_user_name: string;
  message_id: string;
  message: { text: string };
  message_type: string;
  badges: Array<{ set_id: string }>;
  cheer: { bits: number } | null;
  reply: { parent_user_name: string; parent_message_body: string } | null;
}

/** Convert an EventSub `channel.chat.message` event into a chat item. */
export function itemFromEventSub(event: ChatMessageEvent, timestamp: string): TwitchChatItem {
  const firstMessage = event.message_type === "user_intro";
  const reply = event.reply ? { author: event.reply.parent_user_name, text: event.reply.parent_message_body } : undefined;
  const facts = chatFacts(firstMessage, reply);
  return {
    id: event.message_id,
    text: event.message.text,
    author: {
      id: event.chatter_user_id,
      name: event.chatter_user_name,
      login: event.chatter_user_login,
      roles: rolesFromBadges(event.badges.map((badge) => badge.set_id)),
    },
    at: new Date(timestamp),
    channel: event.broadcaster_user_login,
    channelId: event.broadcaster_user_id,
    firstMessage,
    ...(reply ? { reply } : {}),
    ...(event.cheer?.bits ? { bits: event.cheer.bits } : {}),
    ...(facts ? { facts } : {}),
    raw: event,
  };
}

const SEEN_LIMIT = 1_000;
/** Until Twitch says otherwise in its welcome. */
const DEFAULT_KEEPALIVE_S = 10;
/** Twitch wants apps to check their tokens every hour. */
const VALIDATE_MS = 60 * 60_000;
const MAX_BACKOFF_MS = 30_000;

/** What Twitch's close codes mean, for when it closes without saying. */
const CLOSE_REASONS: Record<number, string> = {
  4000: "internal server error",
  4001: "client sent inbound traffic",
  4002: "client failed ping-pong",
  4003: "connection unused",
  4004: "reconnect grace time expired",
  4005: "network timeout",
  4006: "network error",
  4007: "invalid reconnect",
};

function closedWhy({ code, reason }: { code: number; reason: string }): string {
  const why = reason || CLOSE_REASONS[code];
  return why ? `closed (${code}: ${why})` : `closed (${code})`;
}

/**
 * Read the channel's chat over EventSub until the source stops: subscribe when Twitch welcomes the
 * connection, reconnect when it drops or goes quiet, move when Twitch asks, and check the token
 * every hour. Resolves once chat is subscribed, and rejects when that first subscription fails.
 */
export function readChat(ctx: SourceContext<TwitchChatItem, TwitchSession>, ignore?: ChatIgnoreOptions): Promise<void> {
  const { session, signal, log } = ctx;
  if (signal.aborted) return Promise.resolve();
  const url = session.helix.auth.endpoints.eventsub;
  const seen = new Set<string>();
  /** Every open connection, with what closes it. */
  const sockets = new Map<WebSocket, () => void>();
  /** The connection chat is read from. While moving, the old one stays open until the new one is welcomed. */
  let current: WebSocket | undefined;
  let keepalive = DEFAULT_KEEPALIVE_S;
  let attempt = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let validation: ReturnType<typeof setInterval> | undefined;

  const subscribe = async (sessionId: string): Promise<void> => {
    try {
      await session.helix.call("POST", "/eventsub/subscriptions", {
        body: {
          type: "channel.chat.message",
          version: "1",
          condition: { broadcaster_user_id: session.broadcasterId, user_id: session.userId },
          transport: { method: "websocket", session_id: sessionId },
        },
      });
    } catch (error) {
      if (error instanceof TwitchApiError && error.status === 409) return; // Already subscribed.
      if (error instanceof TwitchApiError && error.status === 429) {
        throw new Error(
          `Twitch allows 3 chat connections per account and app, and ${session.login} is already using them (${error.detail}). Stop another monitor or jev-events watch that reads chat as ${session.login}, then try again.`,
          { cause: error },
        );
      }
      throw error;
    }
  };

  /** Connect and subscribe, or when Twitch asked to move, connect to where it said (subscriptions move along). */
  const open = (address: string, migrating: boolean): Promise<void> =>
    new Promise((resolve, reject) => {
      const socket = new WebSocket(address);
      let settled = false;
      let welcomed = false;
      let watchdog: ReturnType<typeof setTimeout> | undefined;

      // Twitch sends something at least every `keepalive` seconds. Silence for longer means the
      // connection is dead, even when it looks open.
      const arm = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => shut(`went quiet for ${keepalive}s`), keepalive * 1000 + Math.min(5_000, keepalive * 500));
      };
      const shut = (why: string) => {
        if (!sockets.has(socket)) return;
        sockets.delete(socket);
        clearTimeout(watchdog);
        socket.close();
        if (!settled) {
          settled = true;
          reject(new Error(`Twitch's chat connection ${why} before chat was subscribed.`));
          return;
        }
        if (socket !== current) return;
        current = undefined;
        if (signal.aborted) return;
        log.warn(`twitch: the chat connection ${why}. Reconnecting.`);
        reconnect();
      };
      sockets.set(socket, () => shut("stopped"));
      arm();

      socket.addEventListener("message", (message) => {
        let data: EventSubMessage;
        try {
          data = JSON.parse(String(message.data)) as EventSubMessage;
        } catch {
          return;
        }
        if (!sockets.has(socket)) return;
        arm();
        const id = data.metadata?.message_id;
        if (id) {
          // Twitch sends each message at least once, and again with the same ID when unsure.
          if (seen.has(id)) return;
          seen.add(id);
          if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value as string);
        }

        switch (data.metadata?.message_type) {
          case "session_welcome": {
            const welcome = data.payload.session;
            if (welcomed || !welcome?.id) return;
            welcomed = true;
            if (welcome.keepalive_timeout_seconds) {
              keepalive = welcome.keepalive_timeout_seconds;
              arm();
            }
            // Subscribe within 10 seconds, or Twitch closes the connection (4003).
            (migrating ? Promise.resolve() : subscribe(welcome.id)).then(
              () => {
                if (settled) return;
                settled = true;
                attempt = 0;
                clearTimeout(retry);
                retry = undefined;
                const previous = current;
                current = socket;
                if (previous) sockets.get(previous)?.();
                resolve();
              },
              (error: unknown) => {
                if (settled) return;
                settled = true;
                sockets.get(socket)?.();
                reject(error);
              },
            );
            return;
          }
          case "session_reconnect": {
            const next = data.payload.session?.reconnect_url;
            if (!next || socket !== current) return;
            log.info("twitch: Twitch asked to move the chat connection. Moving.");
            open(next, true).catch((error: unknown) => {
              // The old connection keeps going for 30 seconds, then closes, and a fresh one replaces it.
              if (!signal.aborted) log.warn("twitch: couldn't move the chat connection:", error);
            });
            return;
          }
          case "revocation":
            ctx.fail(revoked(data.payload.subscription?.status, session), { fatal: true });
            return;
          case "notification": {
            const type = data.metadata.subscription_type ?? data.payload.subscription?.type;
            const event = data.payload.event;
            // The account's own messages, such as replies from twitch.reply(), aren't judged.
            if (type !== "channel.chat.message" || !event || event.chatter_user_id === session.userId) return;
            const item = itemFromEventSub(event, data.metadata.message_timestamp);
            if (!ignoredChat(item, ignore)) void ctx.emit(item);
            return;
          }
        }
      });
      socket.addEventListener("close", (event) => shut(closedWhy(event)));
    });

  const reconnect = () => {
    if (retry || signal.aborted) return;
    const delay = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** attempt++);
    log.info(`twitch: reconnecting to chat in ${Math.round(delay / 1000)}s.`);
    retry = setTimeout(() => {
      retry = undefined;
      if (signal.aborted) return;
      open(url, false).catch((error: unknown) => {
        if (signal.aborted) return;
        // A sign-in problem stops the source; anything else is reported, and tried again later.
        ctx.fail(error);
        if (!needsSignIn(error)) reconnect();
      });
    }, delay);
  };

  signal.addEventListener(
    "abort",
    () => {
      clearTimeout(retry);
      clearInterval(validation);
      for (const stop of [...sockets.values()]) stop();
    },
    { once: true },
  );

  return open(url, false).then(() => {
    if (signal.aborted) return;
    // A revoked token shows up here, and a network hiccup is just reported.
    validation = setInterval(() => {
      session.helix.auth.validate().catch((error: unknown) => {
        if (!signal.aborted) ctx.fail(error);
      });
    }, VALIDATE_MS);
  });
}

/** Why Twitch stopped a chat subscription, in words. */
function revoked(status: string | undefined, session: TwitchSession): Error {
  const { login, channel } = session;
  switch (status) {
    case "authorization_revoked":
      return new TwitchAuthError(`${login} took back the app's access on Twitch, so it can't read #${channel}'s chat anymore (authorization_revoked).`);
    case "user_removed":
      return new Error(
        channel === login
          ? `The account ${login} no longer exists on Twitch (user_removed).`
          : `The account ${login} or the channel #${channel} no longer exists on Twitch (user_removed).`,
      );
    case "chat_user_banned":
      return new Error(`${login} is banned from #${channel}'s chat, so it can't read it anymore (chat_user_banned).`);
    case "version_removed":
      return new Error("Twitch retired this chat subscription (version_removed). Update @jev-events/twitch.");
    default:
      return new Error(`Twitch stopped sending #${channel}'s chat (${status ?? "revoked"}).`);
  }
}
