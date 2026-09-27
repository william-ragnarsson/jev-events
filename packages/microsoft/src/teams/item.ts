import type { Author, Item, JsonValue } from "jev-events";

import { htmlToText, truncate } from "../text.js";

/** Someone in a Teams message: who wrote it, or who it mentions. */
export interface ChatIdentity {
  id?: string | null;
  displayName?: string | null;
  /** "aadUser" for people in a directory, "anonymousGuest", "federatedUser" and others. */
  userIdentityType?: string | null;
  /** Their organization's directory. */
  tenantId?: string | null;
}

export interface ChatAttachment {
  id?: string | null;
  /** "reference" for a shared file, "messageReference" for a quoted message, a card type for bots. */
  contentType?: string | null;
  contentUrl?: string | null;
  content?: string | null;
  name?: string | null;
}

export interface ChatMention {
  id?: number;
  mentionText?: string | null;
  mentioned?: {
    user?: ChatIdentity | null;
    /** An @mention of the whole chat. */
    conversation?: { id?: string | null; displayName?: string | null } | null;
    tag?: { id?: string | null; displayName?: string | null } | null;
  } | null;
}

/** A Teams chat message as Microsoft Graph returns it. */
export interface ChatMessage {
  id: string;
  /** "message" for what people write; chat events and system messages are skipped. */
  messageType?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string | null;
  lastEditedDateTime?: string | null;
  deletedDateTime?: string | null;
  chatId?: string | null;
  subject?: string | null;
  importance?: "normal" | "high" | "urgent" | string | null;
  webUrl?: string | null;
  from?: {
    user?: ChatIdentity | null;
    application?: { id?: string | null; displayName?: string | null } | null;
  } | null;
  body?: { contentType?: "html" | "text" | string; content?: string | null } | null;
  attachments?: ChatAttachment[] | null;
  mentions?: ChatMention[] | null;
}

/** Someone in a chat, as Graph lists its members. */
export interface ChatMember {
  userId?: string | null;
  displayName?: string | null;
  email?: string | null;
  /** "owner", or "guest" for someone from outside the organization invited in. */
  roles?: string[] | null;
  tenantId?: string | null;
}

/** A Teams chat as Microsoft Graph lists it. */
export interface GraphChat {
  id: string;
  /** Group and meeting chats can have one; one-on-one chats never do. */
  topic?: string | null;
  chatType?: "oneOnOne" | "group" | "meeting" | string;
  webUrl?: string | null;
  tenantId?: string | null;
  lastMessagePreview?: { id?: string; createdDateTime?: string; isDeleted?: boolean; messageType?: string } | null;
  members?: ChatMember[] | null;
}

export type ChatKind = "dm" | "group" | "meeting";

/** Where a message was written. */
export interface TeamsChat {
  id: string;
  /** The chat's topic, else who's in it: "Ann Lee", or "Ann Lee, Bo Chen and 3 others". */
  name: string;
  kind: ChatKind;
  /** Opens the chat in Teams. */
  link?: string;
}

/** What the source knows about a chat and its members, to build items. */
export interface ChatInfo extends TeamsChat {
  /** The chat's organization. */
  tenantId?: string;
  members: ChatMember[];
}

/** One Teams chat message, as the messages source emits it. */
export interface TeamsItem extends Item<ChatMessage> {
  author: Author & {
    /** Invited in from outside your organization. */
    guest: boolean;
    /** From another organization. */
    external: boolean;
    /** Posted by an app or bot rather than a person. */
    bot: boolean;
  };
  chat: TeamsChat;
  /** The message's id within the chat, for replies and reactions. */
  messageId: string;
  /** Names of the people it @mentions. */
  mentions: string[];
  /** It @mentions you. */
  mentionsYou: boolean;
  /** It @mentions everyone in the chat. */
  mentionsEveryone: boolean;
  /** "high" or "urgent" when the sender marked it so. */
  importance: "normal" | "high" | "urgent";
  /** Names of the files shared with it. */
  files: string[];
  /** The message it quotes, for a reply to an earlier one. */
  replyTo?: { id: string; from?: string; preview?: string };
  /** Opens the message in Teams. */
  link?: string;
}

export interface TeamsItemContext {
  chat: ChatInfo;
  /** The signed-in account's user id. */
  me: string;
}

const QUOTE_CHARS = 200;

/** Turn a Graph chat message into an item, with facts about the chat and who wrote it. */
export function teamsItem(message: ChatMessage, context: TeamsItemContext): TeamsItem {
  const { chat, me } = context;
  const attachments = message.attachments ?? [];
  const files = attachments.filter((a) => a.contentType === "reference" && a.name).map((a) => a.name as string);
  const replyTo = quoted(attachments);
  const body = messageText(message);
  const text = truncate([body, ...files.map((name) => `[file: ${name}]`)].filter(Boolean).join("\n"));

  const mentioned = message.mentions ?? [];
  const mentions = [
    ...new Set(mentioned.map((m) => m.mentioned?.user?.displayName ?? undefined).filter((name): name is string => Boolean(name))),
  ];
  const mentionsYou = mentioned.some((m) => m.mentioned?.user?.id === me);
  const mentionsEveryone = mentioned.some((m) => Boolean(m.mentioned?.conversation));
  const importance = message.importance === "high" || message.importance === "urgent" ? message.importance : "normal";

  const user = message.from?.user;
  const app = message.from?.application;
  const member = user?.id ? chat.members.find((m) => m.userId === user.id) : undefined;
  const bot = !user && Boolean(app);
  const guest = Boolean(member?.roles?.includes("guest")) || user?.userIdentityType === "anonymousGuest";
  const theirTenant = user?.tenantId ?? member?.tenantId ?? undefined;
  const external = Boolean(theirTenant && chat.tenantId && theirTenant !== chat.tenantId) || user?.userIdentityType === "federatedUser";
  const name = user?.displayName ?? member?.displayName ?? app?.displayName ?? "Someone";

  const facts: Record<string, JsonValue> = { chat: chatLabel(chat) };
  if (mentionsYou) facts.mentionsYou = true;
  if (mentionsEveryone) facts.mentionsEveryone = true;
  if (importance !== "normal") facts.importance = importance;
  if (replyTo) facts.replyingTo = replyTo.from ? `${replyTo.from}: ${replyTo.preview ?? ""}`.trim() : (replyTo.preview ?? "an earlier message");
  if (guest) facts.fromGuest = true;
  if (external) facts.fromOtherCompany = true;
  if (bot) facts.fromBot = true;
  if (files.length > 0) facts.files = files;

  const link = message.webUrl ?? undefined;
  return {
    id: `${chat.id}/${message.id}`,
    text,
    author: {
      id: user?.id ?? app?.id ?? "unknown",
      name,
      ...(bot ? { roles: ["bot"] } : guest ? { roles: ["guest"] } : {}),
      guest,
      external,
      bot,
    },
    at: new Date(message.createdDateTime ?? Date.now()),
    facts,
    raw: message,
    chat: { id: chat.id, name: chat.name, kind: chat.kind, ...(chat.link ? { link: chat.link } : {}) },
    messageId: message.id,
    mentions,
    mentionsYou,
    mentionsEveryone,
    importance,
    files,
    ...(replyTo ? { replyTo } : {}),
    ...(link ? { link } : {}),
  };
}

/** How Jev sees where it was written: "Ann Lee (direct message)" or "Launch plan (group chat)". */
export function chatLabel(chat: Pick<TeamsChat, "name" | "kind">): string {
  const kind = chat.kind === "dm" ? "direct message" : chat.kind === "meeting" ? "meeting chat" : "group chat";
  return `${chat.name} (${kind})`;
}

/** The message as plain text: @mentions as "@Name", emoji as themselves, tags stripped. */
export function messageText(message: Pick<ChatMessage, "body">): string {
  const content = message.body?.content ?? "";
  if (message.body?.contentType !== "html") return content.trim();
  const html = content
    .replace(/<at\b[^>]*>([\s\S]*?)<\/at\s*>/gi, "@$1")
    .replace(/<emoji\b[^>]*?\balt\s*=\s*"([^"]*)"[^>]*>(?:\s*<\/emoji\s*>)?/gi, "$1")
    .replace(/<attachment\b[^>]*>(?:\s*<\/attachment\s*>)?/gi, "");
  return htmlToText(html);
}

/** The chat's kind from Graph's `chatType`. */
export function kindOf(chatType: GraphChat["chatType"]): ChatKind {
  return chatType === "oneOnOne" ? "dm" : chatType === "meeting" ? "meeting" : "group";
}

/**
 * A chat's name: its topic, else the people in it other than you. One-on-one chats are named after
 * the other person.
 */
export function chatName(chat: Pick<GraphChat, "topic" | "chatType">, members: readonly ChatMember[], me: string): string {
  const topic = chat.topic?.trim();
  if (topic && chat.chatType !== "oneOnOne") return topic;
  const others = members.filter((member) => member.userId !== me).map((member) => member.displayName?.trim() || member.email || "someone");
  if (others.length === 0) return topic || (chat.chatType === "oneOnOne" ? "a direct message" : "a group chat");
  if (others.length <= 3) return others.length === 1 ? (others[0] as string) : `${others.slice(0, -1).join(", ")} and ${others.at(-1)}`;
  return `${others.slice(0, 2).join(", ")} and ${others.length - 2} others`;
}

/** The message a reply quotes, from its "messageReference" attachment. */
function quoted(attachments: readonly ChatAttachment[]): TeamsItem["replyTo"] {
  const reference = attachments.find((a) => a.contentType === "messageReference");
  if (!reference?.id) return undefined;
  let content: { messagePreview?: string; messageSender?: { user?: { displayName?: string | null } | null } } = {};
  try {
    content = JSON.parse(reference.content ?? "{}") as typeof content;
  } catch {
    // A quote without readable details is still a reply.
  }
  const preview = content.messagePreview?.trim();
  const from = content.messageSender?.user?.displayName ?? undefined;
  return {
    id: reference.id,
    ...(from ? { from } : {}),
    ...(preview ? { preview: truncate(preview, QUOTE_CHARS) } : {}),
  };
}
