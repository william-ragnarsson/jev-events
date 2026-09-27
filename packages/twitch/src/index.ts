import { ban, clip, deleteMessage, reply, say, timeout, warn } from "./actions.js";
import { app } from "./app.js";
import { fromEnv } from "./auth.js";
import { chat } from "./chat.js";

/**
 * Twitch for Jev Events.
 *
 * @example
 * ```ts
 * const mods = monitor({ source: twitch.chat(), questions: { hateful: recipes.chat.hateful } })
 *   .on("hateful", { min: 0.85 }, twitch.deleteMessage())
 *   .on("hateful", { min: 0.95 }, twitch.timeout({ seconds: 600 }));
 *
 * await mods.start(); // the account `npx jev-events auth twitch` saved, reading its own channel
 *
 * export const jev = runtime({ monitors: [mods], store, apps: [twitch.app()] });
 * ```
 */
export const twitch = {
  /** Your Twitch app, so people can connect their Twitch accounts. */
  app,
  /** One account of your own from TWITCH_CLIENT_ID and TWITCH_ACCESS_TOKEN, plus TWITCH_REFRESH_TOKEN. */
  fromEnv,
  chat,
  timeout,
  ban,
  deleteMessage,
  warn,
  reply,
  say,
  clip,
} as const;

export { ban, clip, deleteMessage, reply, say, timeout, warn, type ReasonOptions, type Text, type TimeoutOptions } from "./actions.js";
export { app, type TwitchApp, type TwitchAppOptions } from "./app.js";
export {
  DEFAULT_SCOPES,
  fromEnv,
  TwitchAuthError,
  withTokens,
  type TwitchAuth,
  type TwitchIdentity,
  type TwitchTokens,
} from "./auth.js";
export { authorize, SETUP_STEPS, type AuthorizeOptions, type TwitchAccount } from "./authorize.js";
export { chat, type TwitchChatOptions, type TwitchChatSource } from "./chat.js";
export { endpoints, type TwitchEndpoints } from "./endpoints.js";
export { itemFromEventSub, readChat, type ChatMessageEvent, type EventSubMessage } from "./eventsub.js";
export { Helix, TwitchApiError, type HelixMethod, type HelixRequest, type TwitchUser } from "./helix.js";
export { connectedAuth, openSession, type TwitchSession } from "./session.js";
export { cli } from "./cli.js";
export type { ChatIgnoreOptions, TwitchAuthor, TwitchChatItem } from "jev-events/public";
