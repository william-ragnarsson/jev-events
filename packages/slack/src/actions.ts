import { defineAction, type Action, type TriggeredEvent } from "jev-events";

import { SlackApiError, type SlackParams } from "./api.js";
import { conversationLabel, type SlackConversation } from "./directory.js";
import type { SlackMessageItem } from "./item.js";
import type { SlackMessagesSource, SlackSession } from "./messages.js";

type Event = TriggeredEvent<SlackMessageItem>;

/** Fixed text, or text made from what fired. Slack formatting (*bold*, <@U123>) works. */
export type Text = string | ((event: Event) => string);

export interface ReplyOptions {
  /** Also post the reply in the channel, not only in the thread. Default false. */
  broadcast?: boolean;
}

/** Reply to the message: in its thread in a channel, or right in the conversation in a DM. */
export function reply(text: Text, options: ReplyOptions = {}): Action<"slack", SlackMessageItem> {
  return defineAction<"slack", SlackMessageItem, SlackMessagesSource>({
    platform: "slack",
    name: "reply",
    describe: (event) =>
      `${inConversation(event.item) ? "reply" : "reply in the thread"} to ${event.item.author.name}: "${preview(render(text, event))}"`,
    async run(event, source) {
      const session = sessionOf(source);
      const { item } = event;
      await call(session, "chat.postMessage", {
        channel: item.channel.id,
        thread_ts: inConversation(item) ? undefined : (item.threadTs ?? item.ts),
        reply_broadcast: options.broadcast && !inConversation(item) ? true : undefined,
        text: render(text, event),
      }, conversationLabel({ ...item.channel, member: true }));
    },
  });
}

/** Add an emoji reaction to the message, such as `react("eyes")`. */
export function react(emoji: string): Action<"slack", SlackMessageItem> {
  const name = emoji.trim().replace(/^:|:$/g, "");
  return defineAction<"slack", SlackMessageItem, SlackMessagesSource>({
    platform: "slack",
    name: "react",
    describe: (event) => `react with :${name}: to ${event.item.author.name}'s message`,
    async run(event, source) {
      const session = sessionOf(source);
      const { item } = event;
      try {
        await call(session, "reactions.add", { channel: item.channel.id, timestamp: item.ts, name }, conversationLabel({ ...item.channel, member: true }));
      } catch (error) {
        if (error instanceof SlackApiError && error.code === "already_reacted") return;
        throw error;
      }
    },
  });
}

/**
 * Post in another channel, such as an alerts channel. The default text says what fired, who wrote
 * the message and where, with a link to it.
 */
export function post(channel: string, text?: Text): Action<"slack", SlackMessageItem> {
  const target = channel.trim().replace(/^#/, "");
  let found: Promise<SlackConversation> | undefined;
  return defineAction<"slack", SlackMessageItem, SlackMessagesSource>({
    platform: "slack",
    name: "post",
    describe: (event) => `post in #${target}: "${preview(text === undefined ? alert(event) : render(text, event))}"`,
    async run(event, source) {
      const session = sessionOf(source);
      found ??= session.directory.find(target).catch((error: unknown) => {
        found = undefined;
        throw error;
      });
      const conversation = await found;
      await call(session, "chat.postMessage", { channel: conversation.id, text: text === undefined ? alert(event) : render(text, event) }, conversationLabel(conversation));
    },
  });
}

function sessionOf(source: SlackMessagesSource): SlackSession {
  const session = (source as Partial<SlackMessagesSource>).session;
  if (!session) throw new Error("Slack actions need the Slack source: slack.messages({ auth }).");
  return session;
}

/** Call Slack, saying how to add the app when it isn't in the conversation. */
async function call(session: SlackSession, method: string, params: SlackParams, where: string): Promise<void> {
  try {
    await session.api.call(method, params);
  } catch (error) {
    if (error instanceof SlackApiError && error.code === "not_in_channel") {
      throw new Error(`The app (@${session.user}) isn't in ${where}. In Slack, open ${where} and type: /invite @${session.user}`);
    }
    throw error;
  }
}

/** In a DM, a reply goes straight into the conversation, unless the message is already in a thread. */
function inConversation(item: SlackMessageItem): boolean {
  return item.channel.kind === "dm" && !item.inThread;
}

function render(text: Text, event: Event): string {
  return typeof text === "function" ? text(event) : text;
}

/** "*urgent* · Ann in #general: “Is prod down?”", then a link to the message. */
function alert(event: Event): string {
  const { item, trigger } = event;
  const where = conversationLabel({ ...item.channel, member: true });
  const quote = escape(preview(item.text, 300));
  const line = `*${escape(trigger.event)}* · ${escape(item.author.name)} in ${where}: “${quote}”`;
  return item.permalink ? `${line}\n<${item.permalink}|Open in Slack>` : line;
}

/** Slack reads &, < and > as markup. */
function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function preview(text: string, max = 80): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}
