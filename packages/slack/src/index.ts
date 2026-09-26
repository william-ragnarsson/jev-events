import { react, post, reply } from "./actions.js";
import { fromEnv, fromFile, withTokens } from "./auth.js";
import { messages } from "./messages.js";

/**
 * Slack for Jev Events.
 *
 * @example
 * ```ts
 * const auth = slack.auth.fromFile(); // saved by: npx jev-events auth slack
 *
 * const team = listen(slack.messages({ auth }), { needsAnswer: recipes.team.needsAnswer });
 * team.on("needsAnswer", { min: 0.8 }, slack.react("eyes"));
 * team.on("needsAnswer", { min: 0.8 }, slack.post("#support-queue"));
 * ```
 */
export const slack = {
  messages,
  reply,
  react,
  post,
  auth: { fromFile, fromEnv, withTokens },
} as const;

export { post, react, reply, type ReplyOptions, type Text } from "./actions.js";
export { messages, type Delivery, type MessagesOptions, type SlackMessagesSource, type SlackSession } from "./messages.js";
export {
  botAuthor,
  channelTypeOf,
  MAX_TEXT_CHARS,
  messageItem,
  permalinkOf,
  type MessageContext,
  type SlackChannel,
  type SlackFile,
  type SlackMessageEvent,
  type SlackMessageItem,
} from "./item.js";
export {
  conversationLabel,
  Directory,
  toConversation,
  toUser,
  type ApiConversation,
  type ApiUser,
  type ConversationKind,
  type SlackConversation,
  type SlackUser,
} from "./directory.js";
export { checkTokens, fromEnv, fromFile, SlackAuthError, withTokens, type SlackAuth, type SlackTokens } from "./auth.js";
export { authorize, MANIFEST, SETUP_STEPS, type AuthorizeOptions, type SlackWorkspace } from "./authorize.js";
export { isFatal, SlackApi, SlackApiError, type SlackApiOptions, type SlackParams, type SlackResponse } from "./api.js";
export { handleEventsRequest, slackSignature, type EventsApiOptions } from "./events-api.js";
export { socketMode, SocketModeError, type EventCallback, type SocketModeOptions } from "./socket.js";
export { mentionsIn, mrkdwnToText, type Mentions } from "./text.js";
export { cli } from "./cli.js";
