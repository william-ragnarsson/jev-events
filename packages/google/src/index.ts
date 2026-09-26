import { fromEnv, fromFile, withTokens } from "./auth.js";
import { accept, decline, maybe } from "./calendar/actions.js";
import { events } from "./calendar/source.js";
import { archive, draftReply, label, markRead, star, trash } from "./gmail/actions.js";
import { inbox } from "./gmail/source.js";

/**
 * Gmail and Google Calendar for Jev Events.
 *
 * @example
 * ```ts
 * const auth = google.auth.fromFile(); // saved by: npx jev-events auth google
 *
 * const mail = listen(google.gmail.inbox({ auth }), { kind: recipes.email.kind });
 * mail.on("kind:newsletter", google.gmail.archive());
 *
 * const calendar = listen(google.calendar.events({ auth }), { important: recipes.calendar.important });
 * calendar.on("important", { min: 0.8 }, (event) => notify(event.item.title));
 * ```
 */
export const google = {
  gmail: { inbox, trash, archive, markRead, star, label, draftReply },
  calendar: { events, accept, decline, maybe },
  auth: { fromFile, fromEnv, withTokens },
} as const;

export { archive, draftReply, label, markRead, star, trash } from "./gmail/actions.js";
export { inbox, type GmailSession, type GmailSource, type InboxOptions } from "./gmail/source.js";
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

export { accept, decline, maybe, type RespondOptions } from "./calendar/actions.js";
export { events, type CalendarSession, type CalendarSource, type EventsOptions } from "./calendar/source.js";
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
  fromFile,
  GMAIL_SCOPE,
  GoogleAuthError,
  withTokens,
  type GoogleAuth,
  type GoogleTokens,
} from "./auth.js";
export { authorize, SETUP_STEPS, type AuthorizeOptions, type GoogleIdentity } from "./authorize.js";
export { GoogleApi, GoogleApiError, type GoogleRequest } from "./api.js";
export { People, protectedBecause, PUBLIC_DOMAINS, type Person, type ProtectOptions } from "./protect.js";
export { htmlToText } from "./text.js";
export { cli } from "./cli.js";
