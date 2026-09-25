import { ban, clip, deleteMessage, reply, say, timeout, warn } from "./actions.js";
import { fromEnv, fromFile, withTokens } from "./auth.js";
import { chat } from "./chat.js";

/**
 * Twitch for Jev Events.
 *
 * @example
 * ```ts
 * const chat = listen(twitch.chat("mychannel", { auth: twitch.auth.fromFile() }), { hateful: recipes.chat.hateful });
 * chat.on("hateful", { min: 0.85 }, twitch.timeout({ seconds: 600 }));
 * ```
 */
export const twitch = {
  chat,
  timeout,
  ban,
  deleteMessage,
  warn,
  reply,
  say,
  clip,
  auth: { fromFile, fromEnv, withTokens },
} as const;

export { ban, chat, clip, deleteMessage, reply, say, timeout, warn };
export {
  authorize,
  DEFAULT_SCOPES,
  fromEnv,
  fromFile,
  JEV_EVENTS_CLIENT_ID,
  withTokens,
  type AuthorizeOptions,
  type TwitchAuth,
  type TwitchIdentity,
  type TwitchTokens,
} from "./auth.js";
export { itemFromEventSub, type TwitchChatOptions, type TwitchChatSource, type TwitchSession } from "./chat.js";
export { Helix, TwitchApiError, type HelixRequest } from "./helix.js";
export type { TwitchAuthor, TwitchChatItem } from "jev-events/public";
