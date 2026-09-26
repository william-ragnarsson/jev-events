import type { Author, Item, JsonValue } from "jev-events";

import { conversationLabel, type ConversationKind, type SlackConversation, type SlackUser } from "./directory.js";
import { mentionsIn, mrkdwnToText } from "./text.js";

/** Messages are capped at this many characters, so Jev reads what matters. */
export const MAX_TEXT_CHARS = 4_000;

/** A message as Slack sends it: a `message` event, or an entry of `conversations.history`. */
export interface SlackMessageEvent {
  type: "message";
  subtype?: string;
  /** Events carry it; `conversations.history` entries don't. */
  channel?: string;
  channel_type?: "channel" | "group" | "im" | "mpim";
  user?: string;
  bot_id?: string;
  /** A bot's name on `bot_message`s. */
  username?: string;
  bot_profile?: { name?: string };
  text?: string;
  ts: string;
  /** The thread's first message. On that message itself, it equals `ts`. */
  thread_ts?: string;
  team?: string;
  /** The sender's workspace, which differs from yours for people in a Slack Connect channel. */
  user_team?: string;
  files?: Array<{ id?: string; name?: string; title?: string; mimetype?: string }>;
  hidden?: boolean;
}

export type SlackChannel = Pick<SlackConversation, "id" | "name" | "kind">;

export interface SlackFile {
  name: string;
  /** MIME type, e.g. "application/pdf". */
  type?: string;
}

/** One Slack message, as the messages source emits it. */
export interface SlackMessageItem extends Item<SlackMessageEvent> {
  author: Author & {
    /** A single- or multi-channel guest. */
    guest: boolean;
    /** From another organization, through Slack Connect. */
    external: boolean;
    bot: boolean;
  };
  channel: SlackChannel;
  /** The message's timestamp, Slack's ID for it within the channel. */
  ts: string;
  /** For a reply in a thread: the `ts` of the thread's first message. */
  threadTs?: string;
  /** A reply in a thread, rather than a message in the channel itself. */
  inThread: boolean;
  /** IDs of the people it @-mentions. */
  mentions: string[];
  /** It @-mentions the app (or you, with a user token). */
  mentionsYou: boolean;
  /** It uses @here, @channel or @everyone. */
  mentionsEveryone: boolean;
  /** A link to the message in Slack. */
  permalink?: string;
  files: SlackFile[];
}

export interface MessageContext {
  channel: SlackChannel;
  /** Who posted it. Messages from bots without a user get a stand-in from `botAuthor`. */
  author: SlackUser;
  /** The connected app's user ID (or yours, with a user token). */
  me: string;
  /** Your workspace's ID, to tell people from other organizations apart. */
  teamId?: string;
  /** Your workspace's address, e.g. "https://acme.slack.com/", for permalinks. */
  url?: string;
  /** Names of the people and channels the text mentions, by ID. */
  names?: (id: string) => string | undefined;
}

/** Turn a Slack message into an item, with facts about where it was posted and by whom. */
export function messageItem(event: SlackMessageEvent, context: MessageContext): SlackMessageItem {
  const raw = event.text ?? "";
  const mentions = mentionsIn(raw);
  const files = (event.files ?? []).map((file) => ({
    name: file.name ?? file.title ?? "file",
    ...(file.mimetype ? { type: file.mimetype } : {}),
  }));
  const plain = mrkdwnToText(raw, context.names).trim();
  const text = truncate([plain, ...files.map((file) => `[file: ${file.name}]`)].filter(Boolean).join("\n"));
  const threadTs = event.thread_ts && event.thread_ts !== event.ts ? event.thread_ts : undefined;
  const inThread = threadTs !== undefined;
  const mentionsYou = mentions.users.includes(context.me);
  const external = context.author.external || Boolean(event.user_team && context.teamId && event.user_team !== context.teamId);
  const { channel, author } = context;

  const facts: Record<string, JsonValue> = { channel: conversationLabel({ ...channel, member: true }) };
  if (inThread) facts.inThread = true;
  if (mentionsYou) facts.mentionsYou = true;
  if (mentions.everyone) facts.mentionsEveryone = true;
  if (author.guest) facts.fromGuest = true;
  if (external) facts.fromOtherCompany = true;
  if (author.bot) facts.fromBot = true;
  if (files.length > 0) facts.files = files.map((file) => file.name);

  const permalink = context.url ? permalinkOf(context.url, channel.id, event.ts, threadTs) : undefined;
  return {
    id: `${channel.id}:${event.ts}`,
    text,
    author: {
      id: author.id,
      name: author.name,
      ...(author.roles.length > 0 ? { roles: author.roles } : {}),
      guest: author.guest,
      external,
      bot: author.bot,
    },
    at: new Date(Number(event.ts) * 1000),
    facts,
    raw: event,
    channel: { id: channel.id, ...(channel.name ? { name: channel.name } : {}), kind: channel.kind },
    ts: event.ts,
    ...(threadTs ? { threadTs } : {}),
    inThread,
    mentions: mentions.users,
    mentionsYou,
    mentionsEveryone: mentions.everyone,
    ...(permalink ? { permalink } : {}),
    files,
  };
}

/** The stand-in author for a message a bot or integration posted without a user. */
export function botAuthor(event: SlackMessageEvent): SlackUser {
  const name = event.bot_profile?.name ?? event.username ?? "bot";
  return { id: event.bot_id ?? "bot", name, guest: false, external: false, bot: true, roles: ["bot"] };
}

/** Slack's link to a message: https://acme.slack.com/archives/C123/p1712345678123456. */
export function permalinkOf(url: string, channel: string, ts: string, threadTs?: string): string {
  const base = `${url.replace(/\/*$/, "/")}archives/${channel}/p${ts.replace(".", "")}`;
  return threadTs ? `${base}?thread_ts=${threadTs}&cid=${channel}` : base;
}

/** Slack's `channel_type`, from a conversation's kind. */
export function channelTypeOf(kind: ConversationKind): NonNullable<SlackMessageEvent["channel_type"]> {
  return kind === "private" ? "group" : kind === "dm" ? "im" : kind === "group-dm" ? "mpim" : "channel";
}

function truncate(text: string, max = MAX_TEXT_CHARS): string {
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}
