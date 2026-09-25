import type { Source, SourceContext } from "jev-events";
import {
  chatFacts,
  ignoredChat,
  isProtectedChatter,
  rolesFromBadges,
  twitchChat,
  type TwitchChatItem,
  type TwitchPublicChatOptions,
} from "jev-events/public";

import type { TwitchAuth } from "./auth.js";
import { Helix } from "./helix.js";

export interface TwitchSession {
  helix: Helix;
  broadcasterId: string;
  /** The signed-in bot account; actions run as this user. */
  botId: string;
  botLogin: string;
}

export interface TwitchChatSource extends Source<TwitchChatItem, "twitch"> {
  readonly channel: string;
  /** Set once an authenticated source has started. Actions use it. */
  readonly session: TwitchSession | undefined;
}

export interface TwitchChatOptions extends TwitchPublicChatOptions {
  /**
   * Sign in to read chat through EventSub and run moderation actions, e.g. `twitch.auth.fromFile()`.
   * Without it, chat is read anonymously and actions only work in dry-run.
   */
  auth?: TwitchAuth;
  /** Default "wss://eventsub.wss.twitch.tv/ws". */
  eventsubUrl?: string;
}

/** Live chat for a channel. */
export function chat(channel: string, options: TwitchChatOptions = {}): TwitchChatSource {
  const login = channel.replace(/^#/, "").toLowerCase();
  if (!options.auth) {
    const anonymous = twitchChat(login, options);
    return { ...anonymous, channel: login, session: undefined, start: (ctx) => anonymous.start(ctx) };
  }

  const auth = options.auth;
  let session: TwitchSession | undefined;
  return {
    id: `twitch:chat:${login}`,
    platform: "twitch",
    noun: "message",
    canAct: true,
    channel: login,
    defaults: { maxLagMs: 10_000, recent: 3 },
    isProtected: isProtectedChatter,
    get session() {
      return session;
    },
    async start(ctx) {
      const helix = new Helix(auth);
      const identity = await auth.identity();
      if (!identity.scopes.includes("user:read:chat")) {
        throw new Error(`The Twitch token for ${identity.login} lacks the user:read:chat scope. Sign in again: npx jev-events auth twitch`);
      }
      const broadcaster = await helix.userByLogin(login);
      if (!broadcaster) throw new Error(`There's no Twitch channel called "${login}".`);
      session = { helix, broadcasterId: broadcaster.id, botId: identity.userId, botLogin: identity.login };
      await eventSubChat(ctx, session, options);
    },
  };
}

interface EventSubMessage {
  metadata: { message_id: string; message_type: string; message_timestamp: string; subscription_type?: string };
  payload: {
    session?: { id: string; keepalive_timeout_seconds: number | null; reconnect_url: string | null };
    subscription?: { type: string; status: string };
    event?: ChatMessageEvent;
  };
}

interface ChatMessageEvent {
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

/**
 * Keep an EventSub WebSocket session subscribed to the channel's chat: welcome → subscribe,
 * keepalive watchdog, server-requested reconnects, and fresh reconnects with backoff.
 */
function eventSubChat(ctx: SourceContext<TwitchChatItem>, session: TwitchSession, options: TwitchChatOptions): Promise<void> {
  const baseUrl = options.eventsubUrl ?? "wss://eventsub.wss.twitch.tv/ws";
  const seen = new Set<string>();
  let current: WebSocket | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;

  const subscribe = (sessionId: string) =>
    session.helix.call("POST", "/eventsub/subscriptions", {
      body: {
        type: "channel.chat.message",
        version: "1",
        condition: { broadcaster_user_id: session.broadcasterId, user_id: session.botId },
        transport: { method: "websocket", session_id: sessionId },
      },
    });

  const open = (url: string, migrating: boolean): Promise<void> =>
    new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      let welcomed = false;

      const arm = (seconds: number | null | undefined) => {
        if (watchdog) clearTimeout(watchdog);
        if (!seconds) return;
        watchdog = setTimeout(() => {
          ctx.log.warn("twitch eventsub: keepalive missed, reconnecting");
          socket.close();
        }, (seconds + 5) * 1000);
      };

      socket.addEventListener("message", (message) => {
        let data: EventSubMessage;
        try {
          data = JSON.parse(String(message.data)) as EventSubMessage;
        } catch {
          return;
        }
        if (seen.has(data.metadata.message_id)) return;
        seen.add(data.metadata.message_id);
        if (seen.size > 1000) seen.delete(seen.values().next().value as string);
        if (socket === current || !welcomed) arm(data.payload.session?.keepalive_timeout_seconds ?? 10);

        switch (data.metadata.message_type) {
          case "session_welcome": {
            const sessionId = data.payload.session?.id;
            if (!sessionId) return;
            welcomed = true;
            const previous = current;
            current = socket;
            arm(data.payload.session?.keepalive_timeout_seconds);
            const ready = migrating ? Promise.resolve() : subscribe(sessionId);
            ready.then(
              () => {
                attempt = 0;
                previous?.close();
                resolve();
              },
              (error: unknown) => {
                socket.close();
                reject(error);
              },
            );
            break;
          }
          case "session_reconnect": {
            const reconnectUrl = data.payload.session?.reconnect_url;
            if (reconnectUrl) open(reconnectUrl, true).catch((error: unknown) => ctx.fail(error));
            break;
          }
          case "revocation":
            ctx.fail(new Error(`Twitch revoked the chat subscription (${data.payload.subscription?.status}). Sign in again: npx jev-events auth twitch`), {
              fatal: true,
            });
            break;
          case "notification": {
            const event = data.payload.event;
            if (!event || event.chatter_user_id === session.botId) return;
            const item = itemFromEventSub(event, data.metadata.message_timestamp);
            if (!ignoredChat(item, options.ignore)) ctx.emit(item);
            break;
          }
        }
      });

      socket.addEventListener("close", () => {
        if (!welcomed) {
          reject(new Error("Twitch EventSub closed before the session started."));
          return;
        }
        if (socket !== current || ctx.signal.aborted) return;
        if (watchdog) clearTimeout(watchdog);
        const delay = Math.min(30_000, 1_000 * 2 ** attempt++);
        ctx.log.info(`twitch eventsub: disconnected, reconnecting in ${Math.round(delay / 1000)}s`);
        setTimeout(() => {
          if (!ctx.signal.aborted) open(baseUrl, false).catch((error: unknown) => ctx.fail(error));
        }, delay);
      });
    });

  ctx.signal.addEventListener("abort", () => {
    if (watchdog) clearTimeout(watchdog);
    current?.close();
  });
  return open(baseUrl, false);
}
