import { randomUUID } from "node:crypto";

import type { Author, Item, Source } from "../types.js";
import { parseIrcLine, type IrcMessage } from "./irc.js";
import { reconnecting } from "./socket.js";

export interface TwitchAuthor extends Author {
  login: string;
  roles: string[];
}

export interface TwitchChatItem extends Item {
  /** Channel login, lowercase. */
  channel: string;
  /** The broadcaster's user id. */
  channelId?: string;
  author: TwitchAuthor;
  /** The chatter's first message in this channel. */
  firstMessage: boolean;
  /** The message this one replies to. */
  reply?: { author: string; text: string };
  /** Bits cheered with this message. */
  bits?: number;
}

const PROTECTED_ROLES = new Set(["broadcaster", "moderator", "vip", "staff"]);

/** Map Twitch badge set ids to the roles Jev Events uses. */
export function rolesFromBadges(badges: Iterable<string>): string[] {
  const roles = new Set<string>();
  for (const badge of badges) {
    if (badge === "broadcaster") roles.add("broadcaster");
    else if (badge === "moderator" || badge === "lead_moderator") roles.add("moderator");
    else if (badge === "vip") roles.add("vip");
    else if (badge === "subscriber" || badge === "founder") roles.add("subscriber");
    else if (badge === "staff" || badge === "admin" || badge === "global_mod") roles.add("staff");
  }
  return [...roles];
}

/** Broadcaster, moderators, VIPs and Twitch staff are never acted on. */
export function isProtectedChatter(item: TwitchChatItem): boolean {
  return item.author.roles.some((role) => PROTECTED_ROLES.has(role));
}

/** Facts shown to Jev next to the text: first-time chatters and reply context help a lot. */
export function chatFacts(firstMessage: boolean, reply: TwitchChatItem["reply"]): Item["facts"] {
  if (!firstMessage && !reply) return undefined;
  return {
    ...(firstMessage ? { firstMessage: true } : {}),
    ...(reply ? { replyingTo: { author: reply.author, text: reply.text } } : {}),
  };
}

/** Turn an IRC PRIVMSG into a chat item. */
export function itemFromIrc(message: IrcMessage): TwitchChatItem | undefined {
  if (message.command !== "PRIVMSG") return undefined;
  const channel = (message.params[0] ?? "").replace(/^#/, "");
  let text = message.params[1] ?? "";
  const action = /^\u0001ACTION (.*)\u0001$/.exec(text);
  if (action) text = action[1] ?? "";

  const { tags } = message;
  const login = message.prefix?.split("!")[0] ?? tags.login ?? "";
  const badges = (tags.badges ?? "").split(",").filter(Boolean).map((badge) => badge.split("/")[0] ?? "");
  if (tags.mod === "1") badges.push("moderator");

  const firstMessage = tags["first-msg"] === "1";
  const reply =
    tags["reply-parent-msg-body"] !== undefined
      ? { author: tags["reply-parent-display-name"] ?? tags["reply-parent-user-login"] ?? "", text: tags["reply-parent-msg-body"] }
      : undefined;
  const facts = chatFacts(firstMessage, reply);
  const bits = tags.bits ? Number(tags.bits) : undefined;

  return {
    id: tags.id ?? randomUUID(),
    text,
    author: { id: tags["user-id"] ?? login, name: tags["display-name"] || login, login, roles: rolesFromBadges(badges) },
    at: new Date(Number(tags["tmi-sent-ts"]) || Date.now()),
    channel,
    ...(tags["room-id"] ? { channelId: tags["room-id"] } : {}),
    firstMessage,
    ...(reply ? { reply } : {}),
    ...(bits ? { bits } : {}),
    ...(facts ? { facts } : {}),
    raw: message,
  };
}

/** Chat bots whose messages are skipped by default. */
export const KNOWN_BOTS = [
  "nightbot",
  "streamelements",
  "fossabot",
  "moobot",
  "streamlabs",
  "wizebot",
  "sery_bot",
  "soundalerts",
  "botrixoficial",
  "kofistreambot",
  "pokemoncommunitygame",
];

export interface ChatIgnoreOptions {
  /** Skip "!commands". Default true. */
  commands?: boolean;
  /** Skip well-known chat bots, or your own list of logins. Default true. */
  bots?: boolean | readonly string[];
}

/** Decide whether a message should never reach Jev: commands and bots cost money and aren't chat. */
export function ignoredChat(item: TwitchChatItem, ignore: ChatIgnoreOptions = {}): boolean {
  if ((ignore.commands ?? true) && item.text.startsWith("!")) return true;
  const bots = ignore.bots ?? true;
  const list = bots === true ? KNOWN_BOTS : bots === false ? [] : bots;
  return list.includes(item.author.login.toLowerCase());
}

export interface TwitchPublicChatOptions {
  /** Messages to skip before judging. By default "!commands" and well-known bots. */
  ignore?: ChatIgnoreOptions;
  /** Default "wss://irc-ws.chat.twitch.tv:443". */
  endpoint?: string;
  /** How long to wait for the first join. Default 15 s. */
  joinTimeoutMs?: number;
}

/**
 * Read any public Twitch chat without logging in. Read-only: native actions need an
 * authenticated source from `@jev-events/twitch`, though dry-run works here too.
 */
export function twitchChat(channel: string, options: TwitchPublicChatOptions = {}): Source<TwitchChatItem, "twitch"> {
  const login = channel.replace(/^#/, "").toLowerCase();
  if (!/^[a-z0-9_]{1,25}$/.test(login)) throw new TypeError(`"${channel}" is not a valid Twitch channel name.`);
  const endpoint = options.endpoint ?? "wss://irc-ws.chat.twitch.tv:443";

  return {
    id: `twitch:chat:${login}`,
    platform: "twitch",
    noun: "message",
    canAct: false,
    defaults: { maxLagMs: 10_000, recent: 3 },
    isProtected: isProtectedChatter,
    start(ctx) {
      return reconnecting({
        url: endpoint,
        signal: ctx.signal,
        log: ctx.log,
        label: `twitch chat #${login}`,
        readyTimeoutMs: options.joinTimeoutMs ?? 15_000,
        onOpen(socket) {
          socket.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
          socket.send("PASS SCHMOOPIIE");
          socket.send(`NICK justinfan${Math.floor(10_000 + Math.random() * 89_999)}`);
          socket.send(`JOIN #${login}`);
        },
        onMessage(data, socket, ready) {
          for (const line of data.split("\r\n")) {
            const message = parseIrcLine(line);
            if (!message) continue;
            switch (message.command) {
              case "PING":
                socket.send(`PONG :${message.params[0] ?? "tmi.twitch.tv"}`);
                break;
              case "ROOMSTATE":
                ready();
                break;
              case "RECONNECT":
                socket.close();
                break;
              case "NOTICE":
                if (message.tags["msg-id"] === "msg_channel_suspended") {
                  ctx.fail(new Error(`#${login} is suspended or doesn't exist.`), { fatal: true });
                }
                break;
              case "PRIVMSG": {
                const item = itemFromIrc(message);
                if (item && !ignoredChat(item, options.ignore)) void ctx.emit(item);
                break;
              }
            }
          }
        },
        onError: (error) => ctx.fail(error),
      });
    },
  };
}
