import type { ConnectedSource, ConnectionInfo, SourceContext } from "jev-events";

import { GraphApiError, isFatal, type GraphApi, type GraphPage } from "../api.js";
import type { MicrosoftUser } from "../oauth.js";
import { connectedApi, connectionOf, whoAmI } from "../session.js";
import { chatName, kindOf, messageText, teamsItem, type ChatInfo, type ChatMember, type ChatMessage, type GraphChat, type TeamsItem } from "./item.js";

/** What the Teams source and its actions use for one connection. */
export interface TeamsSession {
  api: GraphApi;
  user: MicrosoftUser;
  /** Chat names and members, looked up once per chat. */
  chats: ChatDirectory;
}

export type TeamsSource = ConnectedSource<TeamsItem, "teams", TeamsSession>;

export interface MessagesOptions {
  /**
   * Only these chats: by topic, by the other person's name or email for a one-on-one chat, or by id.
   * Default: every chat you're in.
   */
  chats?: readonly string[];
  /** Also emit this many of the latest messages already there on the first check. Default 0. */
  backfill?: number;
  /** Also judge messages from apps and bots. Your own messages are always skipped. Default false. */
  includeBots?: boolean;
}

/**
 * Where the last check left off: when the newest message read was written, by Microsoft's clock,
 * and the messages written shortly before it, which the next check lists again.
 */
export type TeamsCursor = {
  /** createdDateTime of the newest message read. The first check starts from the newest chat activity, or now. */
  since: string;
  /** [chatId/messageId, createdDateTime] of the messages already emitted near `since`. */
  recent: Array<[string, string]>;
  /** When the last check ran, by this machine's clock. */
  checkedAt: string;
};

type Context = SourceContext<TeamsItem, TeamsSession>;

interface Found {
  chat: GraphChat;
  message: ChatMessage;
  at: number;
}

/** Messages can show up in a chat a little after the time they say they were written, so each check looks this far back. */
const OVERLAP_MS = 2 * 60_000;
/** After a longer pause, older messages are skipped rather than read all at once. */
const MAX_PAUSE_MS = 24 * 60 * 60_000;
const CHAT_PAGE = 50;
const MAX_CHAT_PAGES = 5;
const MESSAGE_PAGE = 50;
const MAX_MESSAGE_PAGES = 4;
/** Backfill reads the latest messages of at most this many chats. */
const BACKFILL_CHATS = 10;
const PARALLEL = 4;
const MAX_RECENT = 1_000;
/** Chats remembered per connection. The oldest are forgotten first. */
const DIRECTORY_LIMIT = 500;

const CHAT_QUERY = {
  $expand: "lastMessagePreview",
  $orderby: "lastMessagePreview/createdDateTime desc",
  $top: CHAT_PAGE,
};

/**
 * New messages in the Teams chats you're in (one-on-one, group and meeting chats), in each connected
 * work or school account, checked every 10 seconds by default. The first check starts from now,
 * plus `backfill` recent messages. Channel posts aren't read.
 */
export function messages(options: MessagesOptions = {}): TeamsSource {
  const named = options.chats?.map((chat) => chat.trim()).filter(Boolean) ?? [];
  const id = named.length > 0 ? `teams:${named.join(",")}` : "teams:chats";
  return {
    id,
    platform: "teams",
    noun: "message",
    canAct: true,
    integration: "microsoft",
    defaults: { every: "10s" },
    async session(ctx) {
      const connection = connectionOf(ctx, id);
      const api = connectedApi(ctx, connection);
      const user = await whoAmI(connection, api);
      return { api, user, chats: new ChatDirectory(api, user.id) };
    },
    async check(ctx) {
      const personal = personalAccount(ctx.connection);
      if (personal) {
        // Stop reading this account, since retrying can't help. It isn't a sign-in problem: the same
        // connection still works for Outlook.
        ctx.fail(personal, { fatal: true });
        throw personal;
      }
      await new ChatSync(ctx, options, named).check();
    },
  };
}

/** Teams chats are only there for work and school accounts. */
function personalAccount(connection: ConnectionInfo | undefined): Error | undefined {
  if (connection?.facts?.personal !== true) return undefined;
  const who = typeof connection.facts.email === "string" ? connection.facts.email : (connection.label ?? "this account");
  return new Error(
    `Teams chats need a work or school account, and ${who} is a personal Microsoft account. Sign in with a work or school account: npx jev-events auth microsoft`,
  );
}

/** Chat names and members, looked up once per chat. */
export class ChatDirectory {
  readonly #api: GraphApi;
  readonly #me: string;
  readonly #chats = new Map<string, Promise<ChatInfo>>();

  constructor(api: GraphApi, me: string) {
    this.#api = api;
    this.#me = me;
  }

  /** The chat, its name and who's in it. */
  get(id: string): Promise<ChatInfo> {
    let info = this.#chats.get(id);
    if (info) {
      // Most recently used last, so the oldest is forgotten first.
      this.#chats.delete(id);
      this.#chats.set(id, info);
      return info;
    }
    info = this.#api.call<GraphChat>("GET", `/chats/${encodeURIComponent(id)}`, { query: { $expand: "members" } }).then(
      (chat) => chatInfo(chat, chat.members ?? [], this.#me),
      (error: unknown) => {
        this.#chats.delete(id);
        throw error;
      },
    );
    this.#chats.set(id, info);
    if (this.#chats.size > DIRECTORY_LIMIT) this.#chats.delete(this.#chats.keys().next().value as string);
    return info;
  }
}

/** A chat's name, kind and members. */
export function chatInfo(chat: GraphChat, members: ChatMember[], me: string): ChatInfo {
  return {
    id: chat.id,
    name: chatName(chat, members, me),
    kind: kindOf(chat.chatType),
    ...(chat.webUrl ? { link: chat.webUrl } : {}),
    ...(chat.tenantId ? { tenantId: chat.tenantId } : {}),
    members,
  };
}

/** One check of one connection's chats. */
class ChatSync {
  readonly #ctx: Context;
  readonly #options: MessagesOptions;
  readonly #named: Set<string> | undefined;
  readonly #warned = new Set<string>();

  constructor(ctx: Context, options: MessagesOptions, named: readonly string[]) {
    this.#ctx = ctx;
    this.#options = options;
    this.#named = named.length > 0 ? new Set(named.map((name) => name.toLowerCase())) : undefined;
  }

  get #api(): GraphApi {
    return this.#ctx.session.api;
  }

  async check(): Promise<void> {
    const cursor = await this.#ctx.cursor.get<TeamsCursor>();
    if (cursor?.since) await this.#readNew(cursor);
    else await this.#begin();
  }

  /** The first check: remember how far the chats go now, and emit the latest few messages. */
  async #begin(): Promise<void> {
    const startedAt = Date.now();
    const page = await this.#api.call<GraphPage<GraphChat>>("GET", "/me/chats", { query: CHAT_QUERY });
    const chats = (page.value ?? []).filter((chat) => !Number.isNaN(previewAt(chat)));
    let newest = chats.length > 0 ? Math.max(...chats.map(previewAt)) : startedAt;
    const recent = new Map<string, string>();

    const backfill = Math.max(0, Math.floor(this.#options.backfill ?? 0));
    if (backfill > 0) {
      const watched = await this.#watched(chats.slice(0, this.#named ? undefined : BACKFILL_CHATS));
      if (!watched) return;
      const found: Found[] = [];
      const read = await this.#eachChat(watched.slice(0, BACKFILL_CHATS), async (chat) => {
        for (const message of await this.#latest(chat, Math.min(MESSAGE_PAGE, backfill))) {
          const at = Date.parse(message.createdDateTime ?? "");
          if (Number.isNaN(at)) continue;
          newest = Math.max(newest, at);
          if (this.#usable(message)) found.push({ chat, message, at });
        }
      });
      if (!read) return;
      found.sort((a, b) => a.at - b.at);
      if (!(await this.#emitAll(found.slice(-backfill), recent))) return;
    }
    if (!(await this.#markRead(chats, newest, recent))) return;
    await this.#save(newest, recent);
  }

  /**
   * Remember the messages written in the moments up to `newest`: the next check looks back over them,
   * and they were there before the source started. False when the run stopped part-way.
   */
  async #markRead(chats: GraphChat[], newest: number, recent: Map<string, string>): Promise<boolean> {
    const from = newest - OVERLAP_MS;
    return this.#eachChat(
      chats.filter((chat) => previewAt(chat) > from),
      async (chat) => {
        try {
          for (const message of await this.#changed(chat, from)) {
            const at = Date.parse(message.createdDateTime ?? "");
            // Anything written after `newest` is news, for the next check.
            if (at > from && at <= newest) recent.set(keyOf(chat.id, message.id), message.createdDateTime as string);
          }
        } catch (error) {
          if (isFatal(error)) throw error;
          // At worst, a message from just before the start is judged as new.
          this.#warnOnce(`chat:${error instanceof GraphApiError ? error.status : "other"}`, `Couldn't read a Teams chat: ${(error as Error).message}`);
        }
      },
    );
  }

  /** Emit the messages written since the cursor, oldest first. */
  async #readNew(cursor: TeamsCursor): Promise<void> {
    const since = Date.parse(cursor.since);
    let from = since - OVERLAP_MS;
    const dayAgo = Date.now() - MAX_PAUSE_MS;
    if (Date.parse(cursor.checkedAt) < dayAgo && from < dayAgo) {
      this.#ctx.log.warn("Teams wasn't checked for over a day, so only messages from the last day are read.");
      from = dayAgo;
    }
    const recent = new Map(cursor.recent);
    // After a long pause, the next check carries on from where this one started reading.
    let newest = Math.max(since, from + OVERLAP_MS);
    let behind = false;

    const active = await this.#activeChats(from);
    const watched = active && (await this.#watched(active));
    if (!watched) return;
    const found: Found[] = [];
    const read = await this.#eachChat(watched, async (chat) => {
      try {
        for (const message of await this.#changed(chat, from)) {
          const at = Date.parse(message.createdDateTime ?? "");
          // Older messages that were edited, reacted to or deleted since.
          if (!(at > from)) continue;
          newest = Math.max(newest, at);
          if (!recent.has(keyOf(chat.id, message.id)) && this.#usable(message)) found.push({ chat, message, at });
        }
      } catch (error) {
        if (isFatal(error)) throw error;
        // Read this chat again next time, unless it's gone or closed to you.
        if (!(error instanceof GraphApiError && (error.status === 403 || error.status === 404))) behind = true;
        this.#warnOnce(`chat:${error instanceof GraphApiError ? error.status : "other"}`, `Couldn't read a Teams chat: ${(error as Error).message}`);
      }
    });
    if (!read) return;
    found.sort((a, b) => a.at - b.at);
    const emitted = await this.#emitAll(found, recent);
    // Stopped part-way, or a chat couldn't be read: the next check reads from the same point again,
    // skipping what was already emitted.
    await this.#save(emitted && !behind ? newest : since, recent);
  }

  /** Chats with a message written after `from`, newest first. */
  async #activeChats(from: number): Promise<GraphChat[] | undefined> {
    const active: GraphChat[] = [];
    let page = await this.#api.call<GraphPage<GraphChat>>("GET", "/me/chats", { query: CHAT_QUERY });
    for (let pages = 1; ; pages++) {
      let older = false;
      for (const chat of page.value ?? []) {
        const at = previewAt(chat);
        if (Number.isNaN(at)) continue;
        if (at > from) active.push(chat);
        else older = true;
      }
      const next = page["@odata.nextLink"];
      if (older || !next || pages >= MAX_CHAT_PAGES) break;
      if (this.#ctx.signal.aborted) return undefined;
      page = await this.#api.call<GraphPage<GraphChat>>("GET", next);
    }
    return active;
  }

  /** The chats the `chats` option names, or all of them. */
  async #watched(chats: GraphChat[]): Promise<GraphChat[] | undefined> {
    const named = this.#named;
    if (!named) return chats;
    const watched: GraphChat[] = [];
    const read = await this.#eachChat(chats, async (chat) => {
      if (isNamed(await this.#info(chat), named, this.#ctx.session.user.id)) watched.push(chat);
    });
    // Keep the newest first.
    return read ? chats.filter((chat) => watched.includes(chat)) : undefined;
  }

  /** Messages in the chat written or changed after `from`, most recently changed first. */
  async #changed(chat: GraphChat, from: number): Promise<ChatMessage[]> {
    const messages: ChatMessage[] = [];
    let page = await this.#api.call<GraphPage<ChatMessage>>("GET", messagesOf(chat.id), {
      query: {
        $top: MESSAGE_PAGE,
        $orderby: "lastModifiedDateTime desc",
        $filter: `lastModifiedDateTime gt ${new Date(from).toISOString()}`,
      },
    });
    for (let pages = 1; ; pages++) {
      messages.push(...(page.value ?? []));
      const next = page["@odata.nextLink"];
      if (!next || pages >= MAX_MESSAGE_PAGES || this.#ctx.signal.aborted) break;
      page = await this.#api.call<GraphPage<ChatMessage>>("GET", next);
    }
    return messages;
  }

  /** The latest messages in the chat, for backfill. A chat that can't be read is skipped. */
  async #latest(chat: GraphChat, count: number): Promise<ChatMessage[]> {
    try {
      const page = await this.#api.call<GraphPage<ChatMessage>>("GET", messagesOf(chat.id), {
        query: { $top: count, $orderby: "createdDateTime desc" },
      });
      return page.value ?? [];
    } catch (error) {
      if (isFatal(error)) throw error;
      this.#warnOnce("latest", `Couldn't read the latest messages in a Teams chat: ${(error as Error).message}`);
      return [];
    }
  }

  /** Someone saying something: not a chat event, a deleted message, your own, or (by default) a bot's. */
  #usable(message: ChatMessage): boolean {
    if ((message.messageType ?? "message") !== "message" || message.deletedDateTime) return false;
    const user = message.from?.user;
    if (user) {
      if (user.id === this.#ctx.session.user.id) return false;
    } else if (!message.from?.application || !this.#options.includeBots) {
      return false;
    }
    return Boolean(messageText(message) || message.attachments?.some((attachment) => attachment.contentType === "reference"));
  }

  /** Emit in order. False when the run stopped part-way. */
  async #emitAll(found: Found[], recent: Map<string, string>): Promise<boolean> {
    for (const { chat, message } of found) {
      if (this.#ctx.signal.aborted) return false;
      await this.#emit(chat, message);
      recent.set(keyOf(chat.id, message.id), message.createdDateTime as string);
    }
    return !this.#ctx.signal.aborted;
  }

  async #emit(chat: GraphChat, message: ChatMessage): Promise<void> {
    try {
      const info = await this.#info(chat);
      await this.#ctx.emit(teamsItem(message, { chat: info, me: this.#ctx.session.user.id }));
    } catch (error) {
      if (isFatal(error)) throw error;
      this.#ctx.fail(error);
    }
  }

  /** The chat with its members; without them when they can't be read. */
  async #info(chat: GraphChat): Promise<ChatInfo> {
    try {
      return await this.#ctx.session.chats.get(chat.id);
    } catch (error) {
      if (isFatal(error)) throw error;
      this.#warnOnce("members", `Couldn't read who's in a Teams chat: ${(error as Error).message}`);
      return chatInfo(chat, [], this.#ctx.session.user.id);
    }
  }

  /** Run `task` for each chat, a few at a time. False when the run stopped part-way. */
  async #eachChat(chats: readonly GraphChat[], task: (chat: GraphChat) => Promise<void>): Promise<boolean> {
    for (let i = 0; i < chats.length; i += PARALLEL) {
      if (this.#ctx.signal.aborted) return false;
      await Promise.all(chats.slice(i, i + PARALLEL).map(task));
    }
    return !this.#ctx.signal.aborted;
  }

  async #save(newest: number, recent: Map<string, string>): Promise<void> {
    const keepFrom = newest - OVERLAP_MS;
    const kept = [...recent]
      .filter(([, at]) => Date.parse(at) >= keepFrom)
      .sort((a, b) => Date.parse(a[1]) - Date.parse(b[1]))
      .slice(-MAX_RECENT);
    await this.#ctx.cursor.set({
      since: new Date(newest).toISOString(),
      recent: kept,
      checkedAt: new Date().toISOString(),
    } satisfies TeamsCursor);
  }

  #warnOnce(key: string, message: string): void {
    if (this.#warned.has(key)) return;
    this.#warned.add(key);
    this.#ctx.log.warn(message);
  }
}

const messagesOf = (chatId: string) => `/chats/${encodeURIComponent(chatId)}/messages`;
const keyOf = (chatId: string, messageId: string) => `${chatId}/${messageId}`;
const previewAt = (chat: GraphChat) => Date.parse(chat.lastMessagePreview?.createdDateTime ?? "");

/** Whether the `chats` option names this chat: its id, its name, or the other person in a one-on-one chat. */
function isNamed(chat: ChatInfo, named: ReadonlySet<string>, me: string): boolean {
  if (named.has(chat.id.toLowerCase()) || named.has(chat.name.toLowerCase())) return true;
  if (chat.kind !== "dm") return false;
  return chat.members.some(
    (member) =>
      member.userId !== me &&
      ((member.email && named.has(member.email.toLowerCase())) || (member.displayName && named.has(member.displayName.toLowerCase()))),
  );
}
