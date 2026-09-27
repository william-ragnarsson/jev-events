import { app } from "./app.js";
import { fromEnv } from "./auth.js";
import { accept, decline, maybe, respond } from "./calendar/actions.js";
import { events, invites } from "./calendar/source.js";
import { archive, draftReply, label, markRead, star, trash } from "./gmail/actions.js";
import { inbox } from "./gmail/source.js";

/**
 * Gmail and Google Calendar for Jev Events.
 *
 * @example
 * ```ts
 * const mail = monitor({ source: google.gmail.inbox(), questions: { kind: recipes.email.kind } });
 * mail.on("kind:newsletter", google.gmail.archive());
 *
 * const invites = monitor({ source: google.calendar.invites(), questions: { important: recipes.calendar.important } });
 * invites.on("important", { min: 0.85 }, google.calendar.respond("accepted"));
 *
 * export const jev = runtime({ monitors: [mail, invites], store, apps: [google.app()] });
 * ```
 */
export const google = {
  /** Your OAuth client, so users can connect their Google accounts. */
  app,
  /** One account of your own from GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN. */
  fromEnv,
  gmail: { inbox, trash, archive, markRead, star, label, draftReply },
  calendar: { events, invites, respond, accept, decline, maybe },
} as const;

export { app, expandScopes, type GoogleApp, type GoogleAppOptions } from "./app.js";
export { exchangeCode, signInUrl, toNewConnection, type ExchangeOptions, type SignedIn, type SignInUrlOptions } from "./oauth.js";
export { connectedApi } from "./session.js";

export { archive, draftReply, label, markRead, star, trash } from "./gmail/actions.js";
export { inbox, type GmailCursor, type GmailSession, type GmailSource, type InboxOptions } from "./gmail/source.js";
export { describeEmail, gmailItem, type GmailCategory, type GmailItem, type GmailItemContext } from "./gmail/item.js";
export {
  bodyText,
  parseAddresses,
  stripQuoted,
  type Attachment,
  type EmailAddress,
  type GmailMessage,
  type GmailPart,
} from "./gmail/message.js";

export { accept, decline, maybe, respond, type Answer, type RespondOptions } from "./calendar/actions.js";
export { events, invites, type CalendarCursor, type CalendarSession, type CalendarSource, type EventsOptions } from "./calendar/source.js";
export {
  calendarItem,
  describeEvent,
  type Attendee,
  type CalendarAttendee,
  type CalendarEvent,
  type CalendarItem,
  type CalendarItemContext,
  type EventChange,
  type Rsvp,
} from "./calendar/item.js";

export {
  CALENDAR_SCOPE,
  DEFAULT_SCOPES,
  fromEnv,
  GMAIL_SCOPE,
  GoogleAuthError,
  SCOPES,
  withTokens,
  type GoogleAuth,
  type GoogleTokens,
} from "./auth.js";
export { authorize, SETUP_STEPS, type AuthorizeOptions, type GoogleIdentity } from "./authorize.js";
export { GoogleApi, GoogleApiError, type GoogleRequest } from "./api.js";
export { People, protectedBecause, PUBLIC_DOMAINS, type Person, type ProtectOptions } from "./protect.js";
export { htmlToText } from "./text.js";
export { cli } from "./cli.js";
