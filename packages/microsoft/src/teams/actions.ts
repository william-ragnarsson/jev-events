import { defineAction, type ActionContext, type TriggeredEvent } from "jev-events";

import type { TeamsItem } from "./item.js";
import type { TeamsSession } from "./source.js";

type Event = TriggeredEvent<TeamsItem>;
type Text = string | ((event: Event) => string);

const resolve = (text: Text, event: Event) => (typeof text === "function" ? text(event) : text);

/** Teams' own reaction names, for people used to them. Any emoji works too. */
const REACTIONS: Record<string, string> = { like: "👍", heart: "❤️", laugh: "😆", surprised: "😮", sad: "😢", angry: "😡" };

function sessionOf(ctx: ActionContext<TeamsSession>): TeamsSession {
  if (!ctx.session?.api) throw new Error("Teams actions run on items from microsoft.teams.messages().");
  return ctx.session;
}

const chatPath = (e: Event) => `/chats/${encodeURIComponent(e.item.chat.id)}/messages`;

/** Post a message in the chat, as you. The text is sent as plain text. */
export function reply(text: Text) {
  return defineAction<"teams", TeamsItem, TeamsSession>({
    platform: "teams",
    name: "teams.reply",
    describe: (e) => `reply to ${e.item.author.name} in ${e.item.chat.name}`,
    async run(e, ctx) {
      const content = resolve(text, e).trim();
      if (!content) throw new Error("The reply is empty, so nothing was posted.");
      await sessionOf(ctx).api.call("POST", chatPath(e), { body: { body: { contentType: "text", content } } });
    },
  });
}

/** React to the message, as you: an emoji such as "👍", or like, heart, laugh, surprised, sad or angry. */
export function react(emoji: string) {
  const reaction = REACTIONS[emoji.trim().toLowerCase()] ?? emoji.trim();
  if (!reaction) throw new Error('react() takes an emoji, such as react("👍").');
  return defineAction<"teams", TeamsItem, TeamsSession>({
    platform: "teams",
    name: "teams.react",
    describe: (e) => `react ${reaction} to ${e.item.author.name}'s message in ${e.item.chat.name}`,
    async run(e, ctx) {
      await sessionOf(ctx).api.call("POST", `${chatPath(e)}/${encodeURIComponent(e.item.messageId)}/setReaction`, {
        body: { reactionType: reaction },
      });
    },
  });
}
