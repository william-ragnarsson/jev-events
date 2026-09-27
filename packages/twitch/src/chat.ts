import type { ConnectedSource } from "jev-events";
import { isProtectedChatter, type ChatIgnoreOptions, type TwitchChatItem } from "jev-events/public";

import { readChat } from "./eventsub.js";
import { openSession, type TwitchSession } from "./session.js";

export type TwitchChatSource = ConnectedSource<TwitchChatItem, "twitch", TwitchSession>;

export interface TwitchChatOptions {
  /** The channel to read, such as "mychannel". Default: each connected account's own channel. */
  channel?: string;
  /** Messages to skip before judging. By default "!commands" and well-known bots. */
  ignore?: ChatIgnoreOptions;
}

/**
 * New chat messages in a Twitch channel, read as each connected account over EventSub. The
 * actions, such as `twitch.timeout()`, run as that account, which has to be a moderator in the
 * channel (`/mod <account>`) unless it's the account's own.
 *
 * With no channel, each account reads its own channel's chat. Broadcasters connect, and each one's
 * chat is watched. To read a channel without signing in, use `twitchChat()` from `jev-events/public`.
 */
export function chat(options?: TwitchChatOptions): TwitchChatSource;
export function chat(channel: string, options?: Omit<TwitchChatOptions, "channel">): TwitchChatSource;
export function chat(first?: string | TwitchChatOptions, more: Omit<TwitchChatOptions, "channel"> = {}): TwitchChatSource {
  const options: TwitchChatOptions = typeof first === "string" ? { ...more, channel: first } : (first ?? {});
  const channel = options.channel === undefined ? undefined : channelName(options.channel);
  const id = channel ? `twitch:chat:${channel}` : "twitch:chat";
  return {
    id,
    platform: "twitch",
    noun: "message",
    canAct: true,
    integration: "twitch",
    // Chat moves fast: judge what's still on screen, with the last few messages as context.
    defaults: { maxLagMs: 10_000, recent: 3 },
    session: (ctx) => openSession(ctx, id, channel),
    async start(ctx) {
      await readChat(ctx, options.ignore);
      // Chat has no history to read, so a run() is done once it's listening.
      ctx.end();
    },
    isProtected: isProtectedChatter,
  };
}

function channelName(channel: string): string {
  const login = channel.trim().replace(/^#/, "").toLowerCase();
  if (!/^[a-z0-9_]{1,25}$/.test(login)) throw new TypeError(`"${channel}" is not a valid Twitch channel name.`);
  return login;
}
