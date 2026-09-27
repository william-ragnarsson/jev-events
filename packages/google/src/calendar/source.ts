import { createHash } from "node:crypto";

import type { ConnectedSource, SourceContext } from "jev-events";

import { GoogleApiError, isFatal, type GoogleApi } from "../api.js";
import { People, protectedBecause, type Person, type ProtectOptions } from "../protect.js";
import { addressOf, connectedApi, connectionOf } from "../session.js";
import { calendarItem, describeEvent, type CalendarEvent, type CalendarItem, type EventChange } from "./item.js";

/** What the Calendar sources and their actions use for one connection. */
export interface CalendarSession {
  api: GoogleApi;
  /** The signed-in address. */
  me: string;
  calendarId: string;
  people: People;
}

export type CalendarSource = ConnectedSource<CalendarItem, "google-calendar", CalendarSession>;

export interface EventsOptions {
  /** Which calendar. Default "primary", the account's own. */
  calendarId?: string;
  /** Also emit this many upcoming events on the first check. Default 0. */
  backfill?: number;
  /**
   * Whose events native actions never answer, by organizer. Default: colleagues at your company and
   * people you've emailed before. `false` protects no one.
   */
  protect?: ProtectOptions | false;
}

/** Where the last check left off: Google's sync token, and what each upcoming event looked like. */
export type CalendarCursor = {
  syncToken: string;
  /** Event ID → a hash of what Jev reads, to tell real changes from RSVPs. */
  known: Record<string, string>;
};

interface EventsPage {
  items?: CalendarEvent[];
  /** The calendar's time zone. */
  timeZone?: string;
  nextPageToken?: string;
  nextSyncToken?: string;
}

/** Not meetings: skipped. */
const SKIPPED_TYPES = new Set(["workingLocation", "birthday"]);
/** Events remembered per connection. The oldest are forgotten first; they're long past. */
const KNOWN_LIMIT = 2_000;

/**
 * New and changed events on each connected account's calendar, checked every 30 seconds by default.
 * Only upcoming events count, and a change only counts when something Jev reads changed: RSVPs alone
 * don't re-emit an event.
 */
export function events(options: EventsOptions = {}): CalendarSource {
  const calendarId = options.calendarId ?? "primary";
  return calendarSource(`google-calendar:${calendarId}`, options, () => true);
}

/**
 * Invites waiting for an answer: upcoming events someone else organized, where you're a guest and
 * haven't said yes, no or maybe. An invite comes again when its time, place or guests change while
 * you still haven't answered. Each one says what it clashes with.
 */
export function invites(options: EventsOptions = {}): CalendarSource {
  const calendarId = options.calendarId ?? "primary";
  return calendarSource(`google-calendar:${calendarId}:invites`, options, isPendingInvite);
}

function calendarSource(id: string, options: EventsOptions, wanted: (event: CalendarEvent, me: string) => boolean): CalendarSource {
  const calendarId = options.calendarId ?? "primary";
  return {
    id,
    platform: "google-calendar",
    noun: "event",
    canAct: true,
    integration: "google",
    defaults: { every: "30s" },
    describe: describeEvent,
    isProtected: (item) => item.protectedBecause ?? false,
    async session(ctx) {
      const connection = connectionOf(ctx, id);
      const api = connectedApi(ctx, connection);
      const me = await addressOf(connection, async () => (await api.calendar<{ id: string }>("GET", "/calendars/primary")).id);
      return { api, me, calendarId, people: new People(api, me) };
    },
    check: (ctx) => new CalendarSync(ctx, options, wanted).check(),
  };
}

/** Follows a calendar with sync tokens, remembering what each upcoming event looked like. */
class CalendarSync {
  readonly #ctx: SourceContext<CalendarItem, CalendarSession>;
  readonly #options: EventsOptions;
  readonly #wanted: (event: CalendarEvent, me: string) => boolean;
  readonly #path: string;
  #known = new Map<string, string>();
  #timeZone = "UTC";

  constructor(ctx: SourceContext<CalendarItem, CalendarSession>, options: EventsOptions, wanted: (event: CalendarEvent, me: string) => boolean) {
    this.#ctx = ctx;
    this.#options = options;
    this.#wanted = wanted;
    this.#path = `/calendars/${encodeURIComponent(ctx.session.calendarId)}/events`;
  }

  get #api(): GoogleApi {
    return this.#ctx.session.api;
  }

  async check(): Promise<void> {
    const cursor = await this.#ctx.cursor.get<CalendarCursor>();
    if (!cursor) {
      const syncToken = await this.#baseline();
      await this.#backfill(this.#options.backfill ?? 0);
      await this.#save(syncToken);
      return;
    }
    this.#known = new Map(Object.entries(cursor.known));
    const changed: CalendarEvent[] = [];
    let pageToken: string | undefined;
    let next: string | undefined;
    do {
      let page: EventsPage;
      try {
        page = await this.#api.calendar<EventsPage>("GET", this.#path, { query: { syncToken: cursor.syncToken, pageToken, maxResults: 250 } });
      } catch (error) {
        if (!(error instanceof GoogleApiError && error.status === 410)) throw error;
        // Google expires sync tokens now and then. Start over from now.
        this.#ctx.log.warn("Google Calendar asked for a full resync, so changes made in the last moments may be skipped.");
        await this.#save(await this.#baseline(), cursor);
        return;
      }
      if (page.timeZone) this.#timeZone = page.timeZone;
      changed.push(...(page.items ?? []));
      pageToken = page.nextPageToken;
      next = page.nextSyncToken ?? next;
    } while (pageToken);
    for (const event of changed) {
      if (this.#ctx.signal.aborted) return;
      await this.#consider(event);
    }
    await this.#save(next ?? cursor.syncToken, cursor);
  }

  /** Remember every upcoming event as it is now. Returns where to pick up changes from. */
  async #baseline(): Promise<string> {
    this.#known.clear();
    const timeMin = new Date().toISOString();
    let pageToken: string | undefined;
    let syncToken: string | undefined;
    do {
      const page = await this.#api.calendar<EventsPage>("GET", this.#path, { query: { timeMin, maxResults: 250, pageToken } });
      if (page.timeZone) this.#timeZone = page.timeZone;
      for (const event of page.items ?? []) {
        if (event.status !== "cancelled") this.#remember(event.id, fingerprint(event));
      }
      pageToken = page.nextPageToken;
      syncToken = page.nextSyncToken ?? syncToken;
    } while (pageToken);
    if (!syncToken) throw new Error("Google Calendar didn't return a sync token, so changes can't be followed.");
    return syncToken;
  }

  /** Emit the next `count` wanted events, one per recurring series, soonest first. */
  async #backfill(count: number): Promise<void> {
    if (count <= 0) return;
    const { me } = this.#ctx.session;
    const timeMin = new Date().toISOString();
    const series = new Set<string>();
    const upcoming: CalendarEvent[] = [];
    let pageToken: string | undefined;
    // Pages can come back short, and a daily series fills them with repeats, so read a few.
    for (let pages = 0; pages < 5 && upcoming.length < count; pages++) {
      const page = await this.#api.calendar<EventsPage>("GET", this.#path, {
        query: { timeMin, singleEvents: true, orderBy: "startTime", maxResults: Math.min(250, count * 5), pageToken },
      });
      if (page.timeZone) this.#timeZone = page.timeZone;
      for (const event of page.items ?? []) {
        if (upcoming.length >= count) break;
        if (event.status === "cancelled" || SKIPPED_TYPES.has(event.eventType ?? "default") || !this.#wanted(event, me)) continue;
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

  async #consider(event: CalendarEvent): Promise<void> {
    if (event.status === "cancelled") {
      this.#known.delete(event.id);
      return;
    }
    if (SKIPPED_TYPES.has(event.eventType ?? "default")) return;
    const print = fingerprint(event);
    const before = this.#known.get(event.id);
    if (before === print) return; // only RSVPs or other details Jev doesn't read changed
    this.#remember(event.id, print);
    if (!this.#wanted(event, this.#ctx.session.me)) return;
    try {
      let occurrence = event;
      if (event.recurrence?.length) {
        const next = await this.#api.calendar<EventsPage>("GET", `${this.#path}/${encodeURIComponent(event.id)}/instances`, {
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
    const { me, calendarId, people } = this.#ctx.session;
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
    const clashesWith = isPendingInvite(event, me) ? await this.#clashes(extra.occurrence ?? event) : [];
    if (this.#ctx.signal.aborted) return;
    await this.#ctx.emit(
      calendarItem(event, {
        calendarId,
        me,
        timeZone: this.#timeZone,
        change,
        ...extra,
        ...(organizer ? { organizer } : {}),
        ...(reason ? { protectedBecause: reason } : {}),
        ...(clashesWith.length > 0 ? { clashesWith } : {}),
      }),
    );
  }

  /** The titles of up to three events you're going to that overlap this one. */
  async #clashes(occurrence: CalendarEvent): Promise<string[]> {
    const start = occurrence.start?.dateTime;
    const end = occurrence.end?.dateTime;
    if (!start || !end) return []; // all-day events don't clash with meetings
    const { me } = this.#ctx.session;
    const series = occurrence.recurringEventId ?? occurrence.id;
    const clashes: string[] = [];
    try {
      let pageToken: string | undefined;
      // Google may send fewer events than asked for and the rest on later pages, so follow a few.
      for (let pages = 0; pages < 5 && clashes.length < 3; pages++) {
        const page: EventsPage = await this.#api.calendar<EventsPage>("GET", this.#path, {
          query: { timeMin: start, timeMax: end, singleEvents: true, orderBy: "startTime", maxResults: 10, pageToken },
        });
        for (const other of page.items ?? []) {
          if (other.id === occurrence.id || (other.recurringEventId ?? other.id) === series) continue;
          if (other.status === "cancelled" || other.transparency === "transparent" || other.start?.dateTime === undefined) continue;
          if (isGoing(other, me) && clashes.length < 3) clashes.push(other.summary?.trim() || "(no title)");
        }
        pageToken = page.nextPageToken;
        if (!pageToken) break;
      }
      return clashes;
    } catch (error) {
      if (isFatal(error)) throw error;
      this.#ctx.log.warn(`Couldn't check what "${occurrence.summary ?? occurrence.id}" clashes with: ${(error as Error).message}`);
      return [];
    }
  }

  #remember(id: string, print: string): void {
    this.#known.delete(id); // re-adding moves it to the end, so the oldest are forgotten first
    this.#known.set(id, print);
    for (const oldest of this.#known.keys()) {
      if (this.#known.size <= KNOWN_LIMIT) break;
      this.#known.delete(oldest);
    }
  }

  /** Save the cursor, unless nothing changed since `before`. */
  async #save(syncToken: string, before?: CalendarCursor): Promise<void> {
    const cursor: CalendarCursor = { syncToken, known: Object.fromEntries(this.#known) };
    if (before && JSON.stringify(before) === JSON.stringify(cursor)) return;
    await this.#ctx.cursor.set(cursor);
  }
}

/** Someone else's event where you're a guest who hasn't answered. */
function isPendingInvite(event: CalendarEvent, me: string): boolean {
  if (event.organizer?.self || event.organizer?.email?.toLowerCase() === me) return false;
  const you = event.attendees?.find((a) => a.self || a.email?.toLowerCase() === me);
  return you !== undefined && (you.responseStatus ?? "needsAction") === "needsAction";
}

/** You organized it, it's your own block with no guests, or you said yes or maybe. */
function isGoing(event: CalendarEvent, me: string): boolean {
  if (event.organizer?.self || event.organizer?.email?.toLowerCase() === me) return true;
  const you = event.attendees?.find((a) => a.self || a.email?.toLowerCase() === me);
  if (!you) return !event.attendees?.length;
  return you.responseStatus === "accepted" || you.responseStatus === "tentative";
}

/** A short hash of what Jev reads about an event, to tell real changes from RSVPs. */
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
  return createHash("sha1").update(JSON.stringify(parts)).digest("base64url").slice(0, 12);
}

function endOf(event: CalendarEvent): number {
  const end = event.end ?? event.start;
  if (end?.dateTime) return new Date(end.dateTime).getTime();
  // All-day: the end date is exclusive. Give it the whole day in any time zone.
  if (end?.date) return new Date(`${end.date}T00:00:00Z`).getTime() + 14 * 3_600_000;
  return Number.POSITIVE_INFINITY;
}
