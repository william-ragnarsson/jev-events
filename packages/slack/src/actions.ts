import { defineAction, type Action, type ActionContext, type TriggeredEvent } from "jev-events";

import { SlackApiError, type SlackParams } from "./api.js";
import { conversationLabel, type SlackConversation } from "./directory.js";
import type { SlackMessageItem } from "./item.js";
import type { SlackSession } from "./messages.js";

type Event = TriggeredEvent<SlackMessageItem>;
type SlackAction = Action<"slack", SlackMessageItem, SlackSession>;

/** Fixed text, or text made from what fired. Slack formatting (*bold*, <@U123>) works. */
export type Text = string | ((event: Event) => string);

export interface ReplyOptions {
  /** Also post the reply in the channel, not only in the thread. Default false. */
  broadcast?: boolean;
}

/** Reply to the message: in its thread in a channel, or right in the conversation in a DM. */
export function reply(text: Text, options: ReplyOptions = {}): SlackAction {
  return defineAction<"slack", SlackMessageItem, SlackSession>({
    platform: "slack",
    name: "slack.reply",
    describe: (event) =>
      `${inConversation(event.item) ? "reply" : "reply in the thread"} to ${event.item.author.name}: "${preview(render(text, event))}"`,
    async run(event, ctx) {
      const { item } = event;
      await call(
        sessionOf(ctx),
        "chat.postMessage",
        {
          channel: item.channel.id,
          thread_ts: inConversation(item) ? undefined : (item.threadTs ?? item.ts),
          reply_broadcast: options.broadcast && !inConversation(item) ? true : undefined,
          text: render(text, event),
        },
        conversationLabel({ ...item.channel, member: true }),
      );
    },
  });
}

/** Add an emoji reaction to the message, such as `react("eyes")`. */
export function react(emoji: string): SlackAction {
  const name = emoji.trim().replace(/^:|:$/g, "");
  return defineAction<"slack", SlackMessageItem, SlackSession>({
    platform: "slack",
    name: "slack.react",
    describe: (event) => `react with :${name}: to ${event.item.author.name}'s message`,
    async run(event, ctx) {
      const { item } = event;
      try {
        await call(sessionOf(ctx), "reactions.add", { channel: item.channel.id, timestamp: item.ts, name }, conversationLabel({ ...item.channel, member: true }));
      } catch (error) {
        if (error instanceof SlackApiError && error.code === "already_reacted") return;
        throw error;
      }
    },
  });
}

/**
 * Post in another channel of the same workspace, such as an alerts channel. The default text says
 * what fired, who wrote the message and where, with a link to it.
 */
export function post(channel: string, text?: Text): SlackAction {
  const target = channel.trim().replace(/^#/, "");
  /** The channel in each workspace, looked up once. */
  const found = new WeakMap<SlackSession, Promise<SlackConversation>>();
  return defineAction<"slack", SlackMessageItem, SlackSession>({
    platform: "slack",
    name: "slack.post",
    describe: (event) => `post in #${target}: "${preview(text === undefined ? alert(event) : render(text, event))}"`,
    async run(event, ctx) {
      const session = sessionOf(ctx);
      let conversation = found.get(session);
      if (!conversation) {
        conversation = session.directory.find(target);
        found.set(session, conversation);
        conversation.catch(() => found.delete(session));
      }
      const where = await conversation;
      await call(session, "chat.postMessage", { channel: where.id, text: text === undefined ? alert(event) : render(text, event) }, conversationLabel(where));
    },
  });
}

function sessionOf(ctx: ActionContext<SlackSession>): SlackSession {
  if (!ctx.session?.api) throw new Error("Slack actions run on items from slack.messages().");
  return ctx.session;
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
