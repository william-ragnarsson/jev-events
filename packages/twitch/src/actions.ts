import { defineAction, type TriggeredEvent } from "jev-events";
import type { TwitchChatItem } from "jev-events/public";

import type { TwitchChatSource, TwitchSession } from "./chat.js";

type Event = TriggeredEvent<TwitchChatItem>;
type Text = string | ((event: Event) => string);

const resolve = (text: Text, event: Event) => (typeof text === "function" ? text(event) : text);

function sessionOf(source: TwitchChatSource): TwitchSession {
  if (!source.session) throw new Error("Twitch actions need a signed-in source: twitch.chat(channel, { auth }).");
  return source.session;
}

/** What moderators see in the mod log, e.g. "jev-events: kind:hateful (93%)". */
function defaultReason(event: Event): string {
  const { trigger } = event;
  const confidence = trigger.probability === undefined ? "" : ` (${Math.round(trigger.probability * 100)}%)`;
  return `jev-events: ${trigger.event}${confidence}`;
}

function moderation(session: TwitchSession) {
  return { broadcaster_id: session.broadcasterId, moderator_id: session.botId };
}

/** Time the chatter out. Default 10 minutes. */
export function timeout(options: { seconds?: number; reason?: Text } = {}) {
  const seconds = options.seconds ?? 600;
  return defineAction<"twitch", TwitchChatItem, TwitchChatSource>({
    platform: "twitch",
    name: "twitch.timeout",
    describe: (e) => `timeout ${e.item.author.name} for ${seconds}s`,
    async run(e, source) {
      const session = sessionOf(source);
      await session.helix.call("POST", "/moderation/bans", {
        query: moderation(session),
        body: { data: { user_id: e.item.author.id, duration: seconds, reason: resolve(options.reason ?? defaultReason, e) } },
      });
    },
  });
}

/** Ban the chatter. Prefer `timeout` unless you are sure. */
export function ban(options: { reason?: Text } = {}) {
  return defineAction<"twitch", TwitchChatItem, TwitchChatSource>({
    platform: "twitch",
    name: "twitch.ban",
    describe: (e) => `ban ${e.item.author.name}`,
    async run(e, source) {
      const session = sessionOf(source);
      await session.helix.call("POST", "/moderation/bans", {
        query: moderation(session),
        body: { data: { user_id: e.item.author.id, reason: resolve(options.reason ?? defaultReason, e) } },
      });
    },
  });
}

/** Delete the message. */
export function deleteMessage() {
  return defineAction<"twitch", TwitchChatItem, TwitchChatSource>({
    platform: "twitch",
    name: "twitch.deleteMessage",
    describe: (e) => `delete the message from ${e.item.author.name}`,
    async run(e, source) {
      const session = sessionOf(source);
      await session.helix.call("DELETE", "/moderation/chat", { query: { ...moderation(session), message_id: e.item.id } });
    },
  });
}

/** Send the chatter a warning they must acknowledge before chatting again. */
export function warn(options: { reason?: Text } = {}) {
  return defineAction<"twitch", TwitchChatItem, TwitchChatSource>({
    platform: "twitch",
    name: "twitch.warn",
    describe: (e) => `warn ${e.item.author.name}`,
    async run(e, source) {
      const session = sessionOf(source);
      await session.helix.call("POST", "/moderation/warnings", {
        query: moderation(session),
        body: { data: { user_id: e.item.author.id, reason: resolve(options.reason ?? defaultReason, e) } },
      });
    },
  });
}

/** Reply to the message in chat, as the bot. */
export function reply(text: Text) {
  return defineAction<"twitch", TwitchChatItem, TwitchChatSource>({
    platform: "twitch",
    name: "twitch.reply",
    describe: (e) => `reply to ${e.item.author.name}: "${resolve(text, e)}"`,
    async run(e, source) {
      const session = sessionOf(source);
      await session.helix.call("POST", "/chat/messages", {
        body: { broadcaster_id: session.broadcasterId, sender_id: session.botId, message: resolve(text, e), reply_parent_message_id: e.item.id },
      });
    },
  });
}

/** Say something in chat, as the bot. */
export function say(text: Text) {
  return defineAction<"twitch", TwitchChatItem, TwitchChatSource>({
    platform: "twitch",
    name: "twitch.say",
    describe: (e) => `say "${resolve(text, e)}"`,
    async run(e, source) {
      const session = sessionOf(source);
      await session.helix.call("POST", "/chat/messages", {
        body: { broadcaster_id: session.broadcasterId, sender_id: session.botId, message: resolve(text, e) },
      });
    },
  });
}

/** Clip the last seconds of the stream, e.g. when chat goes wild. The channel must be live. */
export function clip() {
  return defineAction<"twitch", TwitchChatItem, TwitchChatSource>({
    platform: "twitch",
    name: "twitch.clip",
    describe: () => "create a clip",
    async run(_e, source) {
      const session = sessionOf(source);
      await session.helix.call("POST", "/clips", { query: { broadcaster_id: session.broadcasterId } });
    },
  });
}
