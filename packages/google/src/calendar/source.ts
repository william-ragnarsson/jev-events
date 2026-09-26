import { createHash } from "node:crypto";

import { toMs, type Duration, type Source, type SourceContext } from "jev-events";

import { GoogleApi, GoogleApiError, isFatal } from "../api.js";
import type { GoogleAuth } from "../auth.js";
import { poll } from "../poll.js";
import { People, protectedBecause, type Person, type ProtectOptions } from "../protect.js";
import { calendarItem, describeEvent, type CalendarEvent, type CalendarItem, type EventChange } from "./item.js";

export interface CalendarSession {
  api: GoogleApi;
  /** The signed-in address. */
  me: string;
  calendarId: string;
  timeZone: string;
  people: People;
}

export interface CalendarSource extends Source<CalendarItem, "google-calendar"> {
  /** Set once the source has started. Actions use it. */
  readonly session: CalendarSession | undefined;
}

export interface EventsOptions {
  /** The signed-in account, e.g. `google.auth.fromFile()`. */
  auth: GoogleAuth;
  /** Which calendar. Default "primary", the account's own. */
  calendarId?: string;
  /** How often to check for changes. Default "30s". */
  every?: Duration;
  /** Also emit this many upcoming events when starting. Default 0. */
  backfill?: number;
  /**
   * Whose events native actions never answer, by organizer. Default: colleagues at your company and
   * people you've emailed before. `false` protects no one.
   */
  protect?: ProtectOptions | false;
}

interface EventsPage {
  items?: CalendarEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

/** Not meetings: skipped. */
const SKIPPED_TYPES = new Set(["workingLocation", "birthday"]);

/**
 * New and changed events on a calendar, checked every 30 seconds. Only upcoming events count, and
 * a change only counts when something Jev reads changed: RSVPs alone don't re-emit an event.
 */
export function events(options: EventsOptions): CalendarSource {
  const calendarId = options.calendarId ?? "primary";
  let session: CalendarSession | undefined;
  return {
    id: `google-calendar:${calendarId}`,
    platform: "google-calendar",
    noun: "event",
    canAct: true,
    describe: describeEvent,
    isProtected: (item) => item.protectedBecause ?? false,
    get session() {
      return session;
    },
    async start(ctx) {
      const api = new GoogleApi(options.auth);
      const primary = await api.calendar<{ id: string; timeZone?: string }>("GET", "/calendars/primary");
      let timeZone = primary.timeZone ?? "UTC";
      if (calendarId !== "primary") {
        const calendar = await api.calendar<{ timeZone?: string }>("GET", `/calendars/${encodeURIComponent(calendarId)}`);
        timeZone = calendar.timeZone ?? timeZone;
      }
      const me = primary.id.toLowerCase();
      session = { api, me, calendarId, timeZone, people: new People(api, me) };
      const sync = new CalendarSync(ctx, session, options);
      await sync.baseline();
      poll(ctx, toMs(options.every ?? "30s"), (first) => (first ? sync.backfill(options.backfill ?? 0) : sync.check()));
    },
  };
}

/** Follows a calendar with sync tokens, remembering what each upcoming event looked like. */
class CalendarSync {
  readonly #ctx: SourceContext<CalendarItem>;
  readonly #session: CalendarSession;
  readonly #options: EventsOptions;
  readonly #path: string;
  /** Event ID → fingerprint of what Jev reads. */
  readonly #known = new Map<string, string>();
  #syncToken = "";

  constructor(ctx: SourceContext<CalendarItem>, session: CalendarSession, options: EventsOptions) {
    this.#ctx = ctx;
    this.#session = session;
    this.#options = options;
    this.#path = `/calendars/${encodeURIComponent(session.calendarId)}/events`;
  }

  /** Remember every upcoming event as it is now, and where to pick up changes from. */
  async baseline(): Promise<void> {
    this.#known.clear();
    const timeMin = new Date().toISOString();
    let pageToken: string | undefined;
    let syncToken: string | undefined;
    do {
      const page = await this.#session.api.calendar<EventsPage>("GET", this.#path, { query: { timeMin, maxResults: 250, pageToken } });
      for (const event of page.items ?? []) {
        if (event.status !== "cancelled") this.#known.set(event.id, fingerprint(event));
      }
      pageToken = page.nextPageToken;
      syncToken = page.nextSyncToken ?? syncToken;
    } while (pageToken);
    if (!syncToken) throw new Error("Google Calendar didn't return a sync token, so changes can't be followed.");
    this.#syncToken = syncToken;
  }

  /** Emit the next `count` events, one per recurring series, soonest first. */
  async backfill(count: number): Promise<void> {
    if (count <= 0) return;
    const timeMin = new Date().toISOString();
    const series = new Set<string>();
    const upcoming: CalendarEvent[] = [];
    let pageToken: string | undefined;
    // Pages can come back short, and a daily series fills them with repeats, so read a few.
    for (let pages = 0; pages < 5 && upcoming.length < count; pages++) {
      const page = await this.#session.api.calendar<EventsPage>("GET", this.#path, {
        query: { timeMin, singleEvents: true, orderBy: "startTime", maxResults: Math.min(250, count * 5), pageToken },
      });
      for (const event of page.items ?? []) {
        if (upcoming.length >= count) break;
        if (event.status === "cancelled" || SKIPPED_TYPES.has(event.eventType ?? "default")) continue;
        if (event.recurringEventId) {
          if (series.has(event.recurringEventId)) continue;
          series.add(event.recurringEventId);
        }
        upcoming.push(event);
      }
      pageToken = page.nextPageToken;
      if (!pageToken) break;
    }
    for (const event of upcoming) {
      if (this.#ctx.signal.aborted) return;
      await this.#emit(event, "existing", { eventId: event.recurringEventId ?? event.id });
    }
  }

  /** Emit the events that are new or changed since the last check. */
  async check(): Promise<void> {
    const changed: CalendarEvent[] = [];
    let pageToken: string | undefined;
    let next: string | undefined;
    do {
      let page: EventsPage;
      try {
        page = await this.#session.api.calendar<EventsPage>("GET", this.#path, {
          query: { syncToken: this.#syncToken, pageToken, maxResults: 250 },
        });
      } catch (error) {
        if (!(error instanceof GoogleApiError && error.status === 410)) throw error;
        // Google expires sync tokens now and then. Start over from now.
        this.#ctx.log.warn("Google Calendar asked for a full resync, so changes made in the last moments may be skipped.");
        await this.baseline();
        return;
      }
      changed.push(...(page.items ?? []));
      pageToken = page.nextPageToken;
      next = page.nextSyncToken ?? next;
    } while (pageToken);
    for (const event of changed) {
      if (this.#ctx.signal.aborted) return;
      await this.#consider(event);
    }
    if (next) this.#syncToken = next;
  }

  async #consider(event: CalendarEvent): Promise<void> {
    if (event.status === "cancelled") {
      this.#known.delete(event.id);
      return;
    }
    if (SKIPPED_TYPES.has(event.eventType ?? "default")) return;
    const print = fingerprint(event);
    const before = this.#known.get(event.id);
    if (before === print) return; // only RSVPs or other details Jev doesn't read changed
    this.#known.set(event.id, print);
    try {
      let occurrence = event;
      if (event.recurrence?.length) {
        const next = await this.#session.api.calendar<EventsPage>("GET", `${this.#path}/${encodeURIComponent(event.id)}/instances`, {
          query: { timeMin: new Date().toISOString(), maxResults: 1 },
        });
        const first = next.items?.[0];
        if (!first) return; // the series has ended
        occurrence = first;
      }
      if (endOf(occurrence) <= Date.now()) return; // in the past
      await this.#emit(event, before === undefined ? "new" : "updated", { occurrence });
    } catch (error) {
      if (error instanceof GoogleApiError && error.status === 404) return; // deleted before we got to it
      if (isFatal(error)) throw error;
      this.#ctx.fail(error);
    }
  }

  async #emit(event: CalendarEvent, change: EventChange, extra: { eventId?: string; occurrence?: CalendarEvent }): Promise<void> {
    const { me, calendarId, timeZone, people } = this.#session;
    const address = (event.organizer ?? event.creator)?.email;
    let organizer: Person | undefined;
    let reason: string | undefined;
    const protect = this.#options.protect;
    if (address) {
      try {
        organizer = await people.about(address);
        if (event.organizer?.self) organizer = { ...organizer, you: true };
        reason = protectedBecause(organizer, protect, "you organized it");
      } catch (error) {
        // Can't tell whether you know them, so play safe: judge it, but don't act on it.
        this.#ctx.log.warn(`Couldn't check whether you've emailed ${address} before: ${(error as Error).message}`);
        reason = protect === false ? undefined : "couldn't check your Sent folder";
      }
    }
    if (this.#ctx.signal.aborted) return;
    this.#ctx.emit(
      calendarItem(event, {
        calendarId,
        me,
        timeZone,
        change,
        ...extra,
        ...(organizer ? { organizer } : {}),
        ...(reason ? { protectedBecause: reason } : {}),
      }),
    );
  }
}

/** A hash of what Jev reads about an event, to tell real changes from RSVPs. */
function fingerprint(event: CalendarEvent): string {
  const attendees = (event.attendees ?? []).map((a) => a.email?.toLowerCase() ?? "").sort();
  const parts = [
    event.summary ?? "",
    event.description ?? "",
    event.location ?? "",
    JSON.stringify(event.start ?? {}),
    JSON.stringify(event.end ?? {}),
    (event.recurrence ?? []).join("\n"),
    attendees.join(","),
    event.organizer?.email?.toLowerCase() ?? "",
    event.status ?? "",
  ];
  return createHash("sha1").update(JSON.stringify(parts)).digest("hex");
}

function endOf(event: CalendarEvent): number {
  const end = event.end ?? event.start;
  if (end?.dateTime) return new Date(end.dateTime).getTime();
  // All-day: the end date is exclusive. Give it the whole day in any time zone.
  if (end?.date) return new Date(`${end.date}T00:00:00Z`).getTime() + 14 * 3_600_000;
  return Number.POSITIVE_INFINITY;
}
