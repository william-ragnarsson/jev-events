/**
 * Public streams that need no login: great for demos, the CLI and trying ideas quickly.
 * All of them are read-only.
 */
export {
  chatFacts,
  ignoredChat,
  isProtectedChatter,
  KNOWN_BOTS,
  itemFromIrc,
  rolesFromBadges,
  twitchChat,
  type ChatIgnoreOptions,
  type TwitchAuthor,
  type TwitchChatItem,
  type TwitchPublicChatOptions,
} from "./twitch.js";
export { bluesky, type BlueskyOptions, type BlueskyPostItem } from "./bluesky.js";
export { parseIrcLine, type IrcMessage } from "./irc.js";
export { reconnecting, type ReconnectingOptions } from "./socket.js";
