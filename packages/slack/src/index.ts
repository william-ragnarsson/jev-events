import { post, react, reply } from "./actions.js";
import { app } from "./app.js";
import { fromEnv } from "./auth.js";
import { messages } from "./messages.js";

/**
 * Slack for Jev Events.
 *
 * @example
 * ```ts
 * const team = monitor({ source: slack.messages(), questions: { needsAnswer: recipes.team.needsAnswer } })
 *   .on("needsAnswer", { min: 0.8 }, slack.react("eyes"))
 *   .on("needsAnswer", { min: 0.8 }, slack.post("#support-queue"));
 *
 * await team.start(); // the workspace `npx jev-events auth slack` saved
 *
 * export const jev = runtime({ monitors: [team], store, apps: [slack.app()] });
 * ```
 */
export const slack = {
  /** Your Slack app, so people can add it to their workspaces and Slack can send events. */
  app,
  /** One workspace of your own from SLACK_BOT_TOKEN, plus SLACK_APP_TOKEN for Socket Mode. */
  fromEnv,
  messages,
  reply,
  react,
  post,
} as const;

export { app, type SlackApp, type SlackAppOptions } from "./app.js";
export { BOT_EVENTS, BOT_SCOPES } from "./scopes.js";
export { manifest, MANIFEST, manifestUrl, type ManifestOptions } from "./manifest.js";
export { post, react, reply, type ReplyOptions, type Text } from "./actions.js";
export { messages, type MessagesOptions, type SlackMessagesSource, type SlackSession } from "./messages.js";
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
export { checkTokens, fromEnv, SlackAuthError, tokensOf, type SlackTokens, type TokenNames } from "./auth.js";
export { authorize, SETUP_STEPS, type AuthorizeOptions, type SlackWorkspace } from "./authorize.js";
export { isFatal, SlackApi, SlackApiError, type SlackApiOptions, type SlackParams, type SlackResponse } from "./api.js";
export { handleEventsRequest, slackSignature, type EventsApiOptions } from "./events-api.js";
export {
  sharedSocket,
  socketMode,
  SocketModeError,
  teamsOf,
  type EventCallback,
  type SharedSocketOptions,
  type SocketModeOptions,
} from "./socket.js";
export { mentionsIn, mrkdwnToText, type Mentions } from "./text.js";
export { cli } from "./cli.js";
