import { app } from "./app.js";
import { fromEnv } from "./auth.js";
import { accept, decline, maybe, respond } from "./calendar/actions.js";
import { events, invites } from "./calendar/source.js";
import { archive, categorize, draftReply, flag, markRead, move, trash } from "./outlook/actions.js";
import { inbox } from "./outlook/source.js";
import { react, reply } from "./teams/actions.js";
import { messages } from "./teams/source.js";

/**
 * Outlook mail, Outlook Calendar and Microsoft Teams for Jev Events.
 *
 * @example
 * ```ts
 * const mail = monitor({ source: microsoft.outlook.inbox(), questions: { kind: recipes.email.kind } });
 * mail.on("kind:newsletter", microsoft.outlook.archive());
 *
 * const chats = monitor({ source: microsoft.teams.messages(), questions: { needsAnswer: recipes.team.needsAnswer } });
 * chats.on("needsAnswer", { min: 0.8 }, microsoft.teams.react("👀"));
 *
 * export const jev = runtime({ monitors: [mail, chats], store, apps: [microsoft.app()] });
 * ```
 */
export const microsoft = {
  /** Your app registration, so users can connect their Microsoft accounts. */
  app,
  /** One account of your own from MICROSOFT_CLIENT_ID and MICROSOFT_REFRESH_TOKEN. */
  fromEnv,
  outlook: { inbox, trash, archive, move, flag, markRead, categorize, draftReply },
  calendar: { events, invites, respond, accept, decline, maybe },
  teams: { messages, reply, react },
} as const;

export { app, type MicrosoftApp, type MicrosoftAppOptions } from "./app.js";
export {
  exchangeCode,
  PERSONAL_TENANT,
  signInUrl,
  toNewConnection,
  type ExchangeOptions,
  type MicrosoftUser,
  type SignedIn,
  type SignInUrlOptions,
} from "./oauth.js";
export { connectedApi } from "./session.js";

export { archive, categorize, draftReply, flag, markRead, move, trash } from "./outlook/actions.js";
export { inbox, type InboxOptions, type OutlookCursor, type OutlookSession, type OutlookSource } from "./outlook/source.js";
export { describeEmail, outlookItem, type Importance, type OutlookItem, type OutlookItemContext } from "./outlook/item.js";
export { bodyText, type Attachment, type EmailAddress, type GraphAttachment, type OutlookMessage } from "./outlook/message.js";
export { findFolder, WELL_KNOWN_FOLDERS } from "./outlook/folders.js";

export { accept, decline, maybe, respond, type Answer, type RespondOptions } from "./calendar/actions.js";
export {
  events,
  invites,
  isPendingInvite,
  type EventsOptions,
  type OutlookCalendarCursor,
  type OutlookCalendarSession,
  type OutlookCalendarSource,
} from "./calendar/source.js";
export {
  describeEvent,
  outlookCalendarItem,
  type Attendee,
  type EventChange,
  type GraphEvent,
  type OutlookCalendarItem,
  type OutlookCalendarItemContext,
  type Rsvp,
} from "./calendar/item.js";

export { react, reply } from "./teams/actions.js";
export { ChatDirectory, messages, type MessagesOptions, type TeamsCursor, type TeamsSession, type TeamsSource } from "./teams/source.js";
export {
  chatLabel,
  messageText,
  teamsItem,
  type ChatInfo,
  type ChatKind,
  type ChatMember,
  type ChatMessage,
  type GraphChat,
  type TeamsChat,
  type TeamsItem,
  type TeamsItemContext,
} from "./teams/item.js";

export {
  CALENDAR_SCOPE,
  CHAT_SCOPE,
  DEFAULT_SCOPES,
  expandScopes,
  fromEnv,
  MAIL_SCOPE,
  MicrosoftAuthError,
  SCOPES,
  withTokens,
  type MicrosoftAuth,
  type MicrosoftTokens,
} from "./auth.js";
export { authorize, SETUP_STEPS, type AuthorizeOptions, type MicrosoftAccount } from "./authorize.js";
export { GraphApi, GraphApiError, type GraphPage, type GraphRequest } from "./api.js";
export { People, protectedBecause, PUBLIC_DOMAINS, type Person, type ProtectOptions } from "./protect.js";
export { htmlToText, stripQuoted } from "./text.js";
export { cli } from "./cli.js";
