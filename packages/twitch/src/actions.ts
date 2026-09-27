import { defineAction, type Action, type ActionContext, type TriggeredEvent } from "jev-events";
import type { TwitchChatItem } from "jev-events/public";

import { TwitchApiError, type HelixRequest } from "./helix.js";
import type { TwitchSession } from "./session.js";

type Event = TriggeredEvent<TwitchChatItem>;
type TwitchAction = Action<"twitch", TwitchChatItem, TwitchSession>;

/** Fixed text, or text made from what fired. */
export type Text = string | ((event: Event) => string);

export interface TimeoutOptions {
  /** How long, from 1 second to 1,209,600 (two weeks). Default 600, ten minutes. */
  seconds?: number;
  /** What moderators see in the mod log. Default: what fired, such as "jev-events: hateful (93%)". */
  reason?: Text;
}

export interface ReasonOptions {
  /** Default: what fired, such as "jev-events: hateful (93%)". */
  reason?: Text;
}

/** Twitch's limit for chat messages and reasons. */
const MAX_TEXT = 500;
const MAX_TIMEOUT_S = 1_209_600;

/** Time the chatter out, as the signed-in account. Default ten minutes. */
export function timeout(options: TimeoutOptions = {}): TwitchAction {
  const seconds = options.seconds ?? 600;
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_TIMEOUT_S) {
    throw new RangeError("A Twitch timeout lasts 1 to 1,209,600 seconds (two weeks).");
  }
  return defineAction<"twitch", TwitchChatItem, TwitchSession>({
    platform: "twitch",
    name: "twitch.timeout",
    describe: (event) => `timeout ${event.item.author.name} for ${seconds}s`,
    async run(event, ctx) {
      await banUser(sessionOf(ctx), event, { duration: seconds, reason: render(options.reason ?? defaultReason, event) });
    },
  });
}

/** Ban the chatter, as the signed-in account. Prefer `timeout()` unless you're sure. */
export function ban(options: ReasonOptions = {}): TwitchAction {
  return defineAction<"twitch", TwitchChatItem, TwitchSession>({
    platform: "twitch",
    name: "twitch.ban",
    describe: (event) => `ban ${event.item.author.name}`,
    async run(event, ctx) {
      await banUser(sessionOf(ctx), event, { reason: render(options.reason ?? defaultReason, event) });
    },
  });
}

/** Delete the message, as the signed-in account. */
export function deleteMessage(): TwitchAction {
  return defineAction<"twitch", TwitchChatItem, TwitchSession>({
    platform: "twitch",
    name: "twitch.deleteMessage",
    describe: (event) => `delete the message from ${event.item.author.name}`,
    async run(event, ctx) {
      const session = sessionOf(ctx);
      try {
        await moderate(session, "DELETE", "/moderation/chat", { query: { ...moderation(session), message_id: event.item.id } });
      } catch (error) {
        // Already deleted, such as by another moderator.
        if (error instanceof TwitchApiError && error.status === 404) return;
        throw error;
      }
    },
  });
}

/** Warn the chatter, as the signed-in account. They have to acknowledge it before chatting again. */
export function warn(options: ReasonOptions = {}): TwitchAction {
  return defineAction<"twitch", TwitchChatItem, TwitchSession>({
    platform: "twitch",
    name: "twitch.warn",
    describe: (event) => `warn ${event.item.author.name}`,
    async run(event, ctx) {
      const session = sessionOf(ctx);
      await moderate(session, "POST", "/moderation/warnings", {
        query: moderation(session),
        body: { data: { user_id: event.item.author.id, reason: render(options.reason ?? defaultReason, event) } },
      });
    },
  });
}

/** Reply to the message in chat, as the signed-in account. */
export function reply(text: Text): TwitchAction {
  return defineAction<"twitch", TwitchChatItem, TwitchSession>({
    platform: "twitch",
    name: "twitch.reply",
    describe: (event) => `reply to ${event.item.author.name}: "${render(text, event)}"`,
    async run(event, ctx) {
      await send(sessionOf(ctx), render(text, event), event.item.id);
    },
  });
}

/** Say something in chat, as the signed-in account. */
export function say(text: Text): TwitchAction {
  return defineAction<"twitch", TwitchChatItem, TwitchSession>({
    platform: "twitch",
    name: "twitch.say",
    describe: (event) => `say "${render(text, event)}"`,
    async run(event, ctx) {
      await send(sessionOf(ctx), render(text, event));
    },
  });
}

/** Clip the last seconds of the stream, as the signed-in account, such as when chat goes wild. The channel has to be live. */
export function clip(): TwitchAction {
  return defineAction<"twitch", TwitchChatItem, TwitchSession>({
    platform: "twitch",
    name: "twitch.clip",
    describe: () => "create a clip",
    async run(_event, ctx) {
      const session = sessionOf(ctx);
      try {
        const { data } = await session.helix.call<{ data: Array<{ id: string; edit_url: string }> }>("POST", "/clips", {
          query: { broadcaster_id: session.broadcasterId },
        });
        const made = data[0];
        if (made) ctx.log.info(`twitch: clipped #${session.channel}: ${made.edit_url}`);
      } catch (error) {
        if (error instanceof TwitchApiError && error.status === 404) throw new Error(`Can't clip #${session.channel}: it isn't live.`, { cause: error });
        throw error;
      }
    },
  });
}

function sessionOf(ctx: ActionContext<TwitchSession>): TwitchSession {
  const session = ctx.session as TwitchSession | undefined;
  if (!session?.helix) throw new Error("Twitch actions run on items from twitch.chat().");
  return session;
}

/** At most 500 characters, which is what Twitch takes. */
function render(text: Text, event: Event): string {
  const full = typeof text === "function" ? text(event) : text;
  const characters = [...full];
  return characters.length > MAX_TEXT ? `${characters.slice(0, MAX_TEXT - 1).join("")}…` : full;
}

/** What moderators see in the mod log, such as "jev-events: hateful (93%)". */
function defaultReason(event: Event): string {
  const { trigger } = event;
  const confidence = trigger.probability === undefined ? "" : ` (${Math.round(trigger.probability * 100)}%)`;
  return `jev-events: ${trigger.event}${confidence}`;
}

function moderation(session: TwitchSession) {
  return { broadcaster_id: session.broadcasterId, moderator_id: session.userId };
}

/** Call a moderation endpoint, saying how to make the account a moderator when it isn't one. */
async function moderate(session: TwitchSession, method: "POST" | "DELETE", path: string, request: HelixRequest): Promise<void> {
  try {
    await session.helix.call(method, path, request);
  } catch (error) {
    if (error instanceof TwitchApiError && error.status === 403) {
      throw new Error(
        `${session.login} isn't a moderator in #${session.channel}. The broadcaster can make it one by typing in chat: /mod ${session.login}`,
        { cause: error },
      );
    }
    throw error;
  }
}

async function banUser(session: TwitchSession, event: Event, data: { duration?: number; reason: string }): Promise<void> {
  try {
    await moderate(session, "POST", "/moderation/bans", { query: moderation(session), body: { data: { user_id: event.item.author.id, ...data } } });
  } catch (error) {
    // Banned already, such as by another moderator.
    if (error instanceof TwitchApiError && error.status === 400 && /already banned/i.test(error.detail)) return;
    throw error;
  }
}

async function send(session: TwitchSession, message: string, replyTo?: string): Promise<void> {
  const { data } = await session.helix.call<{ data: Array<{ is_sent: boolean; drop_reason?: { code?: string; message?: string } | null }> }>(
    "POST",
    "/chat/messages",
    {
      body: {
        broadcaster_id: session.broadcasterId,
        sender_id: session.userId,
        message,
        ...(replyTo ? { reply_parent_message_id: replyTo } : {}),
      },
    },
  );
  const sent = data[0];
  if (sent && !sent.is_sent) {
    const why = (sent.drop_reason?.message ?? sent.drop_reason?.code ?? "no reason given").replace(/[.\s]+$/, "");
    throw new Error(`Twitch didn't send the message to #${session.channel}: ${why}.`);
  }
}
