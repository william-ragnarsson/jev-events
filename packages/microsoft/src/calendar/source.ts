import { createHash } from "node:crypto";

import type { ConnectedSource, SourceContext } from "jev-events";

import { GraphApiError, isFatal, type GraphApi, type GraphPage } from "../api.js";
import type { MicrosoftUser } from "../oauth.js";
import { People, protectedBecause, type Person, type ProtectOptions } from "../protect.js";
import { connectedApi, connectionOf, whoAmI } from "../session.js";
import { describeEvent, endOf, outlookCalendarItem, startOf, type EventChange, type GraphEvent, type OutlookCalendarItem } from "./item.js";

/** What the Outlook Calendar sources and their actions use for one connection. */
export interface OutlookCalendarSession {
  api: GraphApi;
  /** The signed-in address, or "" for an account without one. */
  me: string;
  user: MicrosoftUser;
  people: People;
  /** The time zone all-day events are placed in. */
  timeZone: string;
}

export type OutlookCalendarSource = ConnectedSource<OutlookCalendarItem, "outlook-calendar", OutlookCalendarSession>;

export interface EventsOptions {
  /** Also emit this many upcoming events on the first check. Default 0. */
  backfill?: number;
  /**
   * Whose events native actions never answer, by organizer. Default: colleagues at your company and
   * people you've emailed before. `false` protects no one.
   */
  protect?: ProtectOptions | false;
  /** Your time zone, such as "Europe/Stockholm", for all-day events and the `starts` fact. Default: this machine's. */
  timeZone?: string;
}

/**
 * Where the last check left off: Graph's delta link for the followed stretch of time, and what each
 * event looked like.
 */
export type OutlookCalendarCursor = {
  deltaLink: string;
  /** The stretch of time followed: from a day before it was set to 180 days after. It moves forward weekly. */
  window: [string, string];
  /** When the last check that changed something started. Events created after it are new. */
  checkedAt: string;
  /** A short hash of an event or series ID → a hash of what Jev reads, to tell real changes from RSVPs. */
  known: Record<string, string>;
};

/** A single event, or a series with its occurrences in view. */
interface Group {
  /** The single event, or the series' master. */
  main: GraphEvent;
  /** The single event, or the occurrences and exceptions listed. */
  members: GraphEvent[];
}

interface Listing {
  events: GraphEvent[];
  deltaLink: string;
}

const DAY_MS = 24 * 60 * 60_000;
/** How far ahead events are followed. Events further out are picked up, without being announced, as they come closer. */
const AHEAD_DAYS = 180;
/** The followed stretch moves forward once it has shrunk by this much. */
const MOVE_AFTER_DAYS = 7;
/** Events created this long before the last check are still new: Outlook can list them late. */
const CREATED_LEEWAY_MS = 10 * 60_000;
const PAGE_SIZE = "odata.maxpagesize=100";
const MAX_PAGES = 500;
/** Series masters read at once. */
const PARALLEL = 4;
/** Events remembered per connection. The oldest are forgotten first. */
const KNOWN_LIMIT = 2_000;
const CLASH_FIELDS = "id,subject,start,end,isAllDay,isCancelled,showAs,isOrganizer,responseStatus,seriesMasterId,attendees";

/**
 * New and changed events on each connected account's Outlook calendar, checked every 30 seconds by
 * default. Only events in the next 180 days count, and a change only counts when something Jev
 * reads changed: RSVPs alone don't re-emit an event.
 */
export function events(options: EventsOptions = {}): OutlookCalendarSource {
  return calendarSource("outlook-calendar", options, () => true);
}

/**
 * Invites waiting for an answer: upcoming events someone else organized, where you're invited and
 * haven't said yes, no or maybe. An invite comes again when its time, place or guests change while
 * you still haven't answered. Each one says what it clashes with.
 */
export function invites(options: EventsOptions = {}): OutlookCalendarSource {
  return calendarSource("outlook-calendar:invites", options, isPendingInvite);
}

function calendarSource(id: string, options: EventsOptions, wanted: (event: GraphEvent) => boolean): OutlookCalendarSource {
  const timeZone = checkTimeZone(options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC");
  return {
    id,
    platform: "outlook-calendar",
    noun: "event",
    canAct: true,
    integration: "microsoft",
    defaults: { every: "30s" },
    describe: describeEvent,
    isProtected: (item) => item.protectedBecause ?? false,
    async session(ctx) {
      const connection = connectionOf(ctx, id);
      const api = connectedApi(ctx, connection);
      const user = await whoAmI(connection, api);
      const me = user.email ?? "";
      return { api, me, user, people: new People(api, me), timeZone };
    },
    check: (ctx) => new CalendarSync(ctx, options, wanted).check(),
  };
}

function checkTimeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return timeZone;
  } catch {
    throw new Error(`Unknown time zone "${timeZone}". Use a name such as "Europe/Stockholm" or "America/New_York".`);
  }
}

/**
 * Follows the calendar with Graph's delta links. Graph only follows a fixed stretch of time, so the
 * stretch is read again weekly to move it forward, and events coming into view aren't news.
 */
class CalendarSync {
  readonly #ctx: SourceContext<OutlookCalendarItem, OutlookCalendarSession>;
  readonly #options: EventsOptions;
  readonly #wanted: (event: GraphEvent) => boolean;
  #known = new Map<string, string>();

  constructor(ctx: SourceContext<OutlookCalendarItem, OutlookCalendarSession>, options: EventsOptions, wanted: (event: GraphEvent) => boolean) {
    this.#ctx = ctx;
    this.#options = options;
    this.#wanted = wanted;
  }

  get #api(): GraphApi {
    return this.#ctx.session.api;
  }

  async check(): Promise<void> {
    const startedAt = new Date();
    const cursor = await this.#ctx.cursor.get<OutlookCalendarCursor>();
    if (!cursor?.deltaLink || !cursor.window) {
      const view = await this.#readWindow(startedAt, Number.POSITIVE_INFINITY);
      if (!view) return;
      await this.#backfill(view.groups, Math.max(0, Math.floor(this.#options.backfill ?? 0)));
      await this.#save({ deltaLink: view.deltaLink, window: view.window, checkedAt: startedAt.toISOString() });
      return;
    }

    this.#known = new Map(Object.entries(cursor.known ?? {}));
    const since = Date.parse(cursor.checkedAt) - CREATED_LEEWAY_MS;
    let changes: Listing | undefined;
    let resync = false;
    try {
      changes = await this.#list(cursor.deltaLink);
      if (!changes) return; // stopped
    } catch (error) {
      if (!isResync(error)) throw error;
      this.#ctx.log.warn("Outlook asked for the calendar to be read again from scratch; changes are found by comparing.");
      resync = true;
    }
    if (changes && !(await this.#apply(changes.events, since, false))) return;

    let deltaLink = changes?.deltaLink ?? cursor.deltaLink;
    let window = cursor.window;
    const ahead = Date.parse(window[1]) - startedAt.getTime();
    if (resync || !(ahead > (AHEAD_DAYS - MOVE_AFTER_DAYS) * DAY_MS)) {
      const view = await this.#readWindow(startedAt, since);
      if (!view) return;
      ({ deltaLink, window } = view);
    }
    await this.#save({ deltaLink, window, checkedAt: startedAt.toISOString() }, cursor);
  }

  /**
   * Read every event from a day ago to 180 days ahead, comparing each with what's known, and forget
   * the ones no longer in view. Undefined when stopped.
   */
  async #readWindow(now: Date, since: number): Promise<{ deltaLink: string; window: [string, string]; groups: Group[] } | undefined> {
    const window: [string, string] = [iso(now.getTime() - DAY_MS), iso(now.getTime() + AHEAD_DAYS * DAY_MS)];
    const listing = await this.#list("/me/calendarView/delta", { startDateTime: window[0], endDateTime: window[1] });
    if (!listing) return undefined;
    const inView = new Set<string>();
    const groups = await this.#apply(listing.events, since, true, inView);
    if (!groups) return undefined;
    this.#known = new Map([...this.#known].filter(([key]) => inView.has(key)));
    return { deltaLink: listing.deltaLink, window, groups };
  }

  /** Follow delta pages to the end: the events listed, and the link for the next check. Undefined when stopped. */
  async #list(pathOrLink: string, query?: Record<string, string>): Promise<Listing | undefined> {
    const events: GraphEvent[] = [];
    let page = await this.#api.call<GraphPage<GraphEvent>>("GET", pathOrLink, { ...(query ? { query } : {}), prefer: [PAGE_SIZE] });
    for (let pages = 1; ; pages++) {
      events.push(...(page.value ?? []));
      const deltaLink = page["@odata.deltaLink"];
      if (deltaLink) return { events, deltaLink };
      const next = page["@odata.nextLink"];
      if (!next) throw new Error("Outlook didn't say where to pick up calendar changes from, so they can't be followed.");
      if (pages >= MAX_PAGES) throw new Error(`Outlook listed more than ${MAX_PAGES} pages of calendar events at once, so they can't be followed.`);
      if (this.#ctx.signal.aborted) return undefined;
      page = await this.#api.call<GraphPage<GraphEvent>>("GET", next, { prefer: [PAGE_SIZE] });
    }
  }

  /**
   * Compare listed events with what's known, a series at a time, and emit what changed. `since` tells
   * new events from old ones. With `whole`, the list is everything in view rather than changes, so
   * unknown events are only news when they're new. Returns the groups, or undefined when stopped.
   */
  async #apply(listed: GraphEvent[], since: number, whole: boolean, inView?: Set<string>): Promise<Group[] | undefined> {
    const bySeries = new Map<string, Map<string, GraphEvent>>();
    for (const event of listed) {
      if (event["@removed"]) {
        this.#known.delete(shortHash(event.id));
        continue;
      }
      const key = event.seriesMasterId ?? event.id;
      let members = bySeries.get(key);
      if (!members) bySeries.set(key, (members = new Map()));
      members.delete(event.id); // listed again: the later one is newer
      members.set(event.id, event);
    }
    const masters = await this.#masters(
      [...bySeries].filter(([, members]) => [...members.values()].some((e) => e.seriesMasterId) && ![...members.values()].some(isMaster)).map(([id]) => id),
    );
    if (!masters) return undefined;

    const groups: Group[] = [];
    for (const [id, listedMembers] of bySeries) {
      if (this.#ctx.signal.aborted) return undefined;
      const all = [...listedMembers.values()];
      const series = all.some((e) => e.seriesMasterId || isMaster(e));
      const main = series ? (all.find(isMaster) ?? masters.get(id)) : all[0];
      if (!main) continue; // the series was deleted, or its master couldn't be read
      const key = shortHash(main.id);
      if (main.isCancelled) {
        this.#known.delete(key);
        continue;
      }
      const group: Group = { main, members: series ? all.filter((e) => !isMaster(e)) : [main] };
      groups.push(group);

      const prints = [main, ...group.members.filter((e) => e.type === "exception")].map((e): [string, string] => [shortHash(e.id), fingerprint(e)]);
      const before = this.#known.get(key);
      const created = Date.parse(main.createdDateTime ?? "");
      // In a whole listing only the series itself is compared: exceptions come into view as time passes.
      const changed = whole
        ? before === undefined
          ? created > since
          : before !== prints[0]?.[1]
        : prints.some(([k, print]) => this.#known.get(k) !== print);
      for (const [k, print] of prints) {
        this.#remember(k, print);
        inView?.add(k);
      }
      if (!changed || !this.#wanted(main)) continue;
      const next = this.#next(group.members);
      if (!next) continue; // over, or every occurrence in view is
      const change: EventChange = before === undefined && created > since ? "new" : "updated";
      await this.#emit(next, group, change);
    }
    return groups;
  }

  /** Read the masters of these series, a few at a time. Undefined when stopped. */
  async #masters(ids: string[]): Promise<Map<string, GraphEvent> | undefined> {
    const masters = new Map<string, GraphEvent>();
    for (let i = 0; i < ids.length; i += PARALLEL) {
      if (this.#ctx.signal.aborted) return undefined;
      await Promise.all(
        ids.slice(i, i + PARALLEL).map(async (id) => {
          try {
            masters.set(id, await this.#api.call<GraphEvent>("GET", `/me/events/${encodeURIComponent(id)}`));
          } catch (error) {
            if (error instanceof GraphApiError && error.status === 404) {
              this.#known.delete(shortHash(id)); // the series was deleted
              return;
            }
            if (isFatal(error)) throw error;
            this.#ctx.fail(error);
          }
        }),
      );
    }
    return masters;
  }

  /** Emit the next `count` wanted events, one per series, soonest first. */
  async #backfill(groups: Group[], count: number): Promise<void> {
    if (count <= 0) return;
    const { timeZone } = this.#ctx.session;
    const upcoming = groups
      .filter((group) => this.#wanted(group.main))
      .map((group) => ({ group, next: this.#next(group.members) }))
      .filter((entry): entry is { group: Group; next: GraphEvent } => entry.next !== undefined)
      .sort((a, b) => (startOf(a.next, timeZone)?.getTime() ?? 0) - (startOf(b.next, timeZone)?.getTime() ?? 0))
      .slice(0, count);
    for (const { group, next } of upcoming) {
      if (this.#ctx.signal.aborted) return;
      await this.#emit(next, group, "existing");
    }
  }

  /** The soonest event that hasn't ended and isn't cancelled. */
  #next(members: GraphEvent[]): GraphEvent | undefined {
    const { timeZone } = this.#ctx.session;
    const now = Date.now();
    let next: GraphEvent | undefined;
    let soonest = Number.POSITIVE_INFINITY;
    for (const event of members) {
      const start = startOf(event, timeZone)?.getTime();
      const end = endOf(event, timeZone)?.getTime();
      if (event.isCancelled || start === undefined || end === undefined || end <= now) continue;
      if (start < soonest) {
        next = event;
        soonest = start;
      }
    }
    return next;
  }

  /** Emit `event`, one of `group`'s members. Errors other than a lost sign-in skip it. */
  async #emit(event: GraphEvent, group: Group, change: EventChange): Promise<void> {
    const { me, people, timeZone } = this.#ctx.session;
    const { main } = group;
    const protect = this.#options.protect;
    try {
      const address = main.organizer?.emailAddress?.address;
      let organizer: Person | undefined;
      let reason: string | undefined;
      if (address) {
        try {
          organizer = await people.about(address);
          if (main.isOrganizer) organizer = { ...organizer, you: true };
          reason = protectedBecause(organizer, protect, "you organized it");
        } catch (error) {
          // Can't tell whether you know them, so play safe: judge it, but don't act on it.
          this.#ctx.log.warn(`Couldn't check whether you've emailed ${address} before: ${(error as Error).message}`);
          reason = protect === false ? undefined : "couldn't check your Sent Items";
        }
      }
      const clashesWith = isPendingInvite(main) ? await this.#clashes(event) : [];
      if (this.#ctx.signal.aborted) return;
      await this.#ctx.emit(
        outlookCalendarItem(event, {
          me,
          timeZone,
          change,
          eventId: main.id,
          version: versionOf(group),
          ...(organizer ? { organizer } : {}),
          ...(reason ? { protectedBecause: reason } : {}),
          ...(clashesWith.length > 0 ? { clashesWith } : {}),
        }),
      );
    } catch (error) {
      if (isFatal(error)) throw error;
      this.#ctx.fail(error);
    }
  }

  /** The titles of up to three events you're going to that overlap this one. */
  async #clashes(event: GraphEvent): Promise<string[]> {
    if (event.isAllDay) return []; // all-day events don't clash with meetings
    const { timeZone } = this.#ctx.session;
    const start = startOf(event, timeZone)?.getTime();
    const end = endOf(event, timeZone)?.getTime();
    if (start === undefined || end === undefined || end <= start) return [];
    const series = event.seriesMasterId ?? event.id;
    try {
      const page = await this.#api.call<GraphPage<GraphEvent>>("GET", "/me/calendarView", {
        query: { startDateTime: iso(start), endDateTime: iso(end), $orderby: "start/dateTime", $top: 20, $select: CLASH_FIELDS },
      });
      const clashes: string[] = [];
      for (const other of page.value ?? []) {
        if (clashes.length >= 3) break;
        if (other.id === event.id || (other.seriesMasterId ?? other.id) === series) continue;
        if (other.isCancelled || other.isAllDay || other.showAs === "free" || !isGoing(other)) continue;
        const otherStart = startOf(other, timeZone)?.getTime();
        const otherEnd = endOf(other, timeZone)?.getTime();
        if (otherStart === undefined || otherEnd === undefined || otherStart >= end || otherEnd <= start) continue;
        clashes.push(other.subject?.trim() || "(no title)");
      }
      return clashes;
    } catch (error) {
      if (isFatal(error)) throw error;
      this.#ctx.log.warn(`Couldn't check what "${event.subject ?? event.id}" clashes with: ${(error as Error).message}`);
      return [];
    }
  }

  #remember(key: string, print: string): void {
    this.#known.delete(key); // re-adding moves it to the end, so the oldest are forgotten first
    this.#known.set(key, print);
    for (const oldest of this.#known.keys()) {
      if (this.#known.size <= KNOWN_LIMIT) break;
      this.#known.delete(oldest);
    }
  }

  /**
   * Save the cursor with what's known now. When only the time changed since `before`, it isn't
   * saved: an older `checkedAt` only makes more events count as new.
   */
  async #save(cursor: Omit<OutlookCalendarCursor, "known">, before?: OutlookCalendarCursor): Promise<void> {
    const next: OutlookCalendarCursor = { ...cursor, known: Object.fromEntries(this.#known) };
    const same = (a: OutlookCalendarCursor) => JSON.stringify([a.deltaLink, a.window, a.known]);
    if (before && same(before) === same(next)) return;
    await this.#ctx.cursor.set(next);
  }
}

/** Someone else's event you're invited to and haven't answered. */
export function isPendingInvite(event: GraphEvent): boolean {
  if (event.isOrganizer || event.isCancelled || event.responseRequested === false) return false;
  const response = event.responseStatus?.response ?? "none";
  return (response === "notResponded" || response === "none") && (event.attendees?.length ?? 0) > 0;
}

/** You organized it, said yes or maybe, or it's your own block with no guests. */
function isGoing(event: GraphEvent): boolean {
  if (event.isCancelled || event.showAs === "free") return false;
  if (event.isOrganizer) return true;
  const response = event.responseStatus?.response;
  if (response === "accepted" || response === "tentativelyAccepted" || response === "organizer") return true;
  return !event.attendees?.length;
}

function isMaster(event: GraphEvent): boolean {
  return event.type === "seriesMaster";
}

/** Delta links expire; Graph then asks for everything to be read again. */
function isResync(error: unknown): boolean {
  return error instanceof GraphApiError && (error.status === 410 || /syncstate|resync/i.test(error.code ?? ""));
}

/** When the group last changed, to tell this version of the event apart from earlier ones. */
function versionOf(group: Group): string {
  const times = [group.main, ...group.members].map((e) => Date.parse(e.lastModifiedDateTime ?? "")).filter((t) => !Number.isNaN(t));
  return times.length > 0 ? new Date(Math.max(...times)).toISOString() : "";
}

/** A short hash of what Jev reads about an event, to tell real changes from RSVPs. */
function fingerprint(event: GraphEvent): string {
  const attendees = (event.attendees ?? []).map((a) => a.emailAddress?.address?.toLowerCase() ?? "").sort();
  const parts = [
    event.subject ?? "",
    event.body?.content ?? event.bodyPreview ?? "",
    event.location?.displayName ?? "",
    JSON.stringify(event.start ?? {}),
    JSON.stringify(event.end ?? {}),
    event.isAllDay === true,
    JSON.stringify(event.recurrence ?? null),
    attendees.join(","),
    event.organizer?.emailAddress?.address?.toLowerCase() ?? "",
    event.isCancelled === true,
  ];
  return createHash("sha1").update(JSON.stringify(parts)).digest("base64url").slice(0, 12);
}

/** Graph IDs are long; the cursor keeps a short hash of each. */
function shortHash(id: string): string {
  return createHash("sha1").update(id).digest("base64url").slice(0, 12);
}

/** An ISO time without milliseconds. */
function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}
