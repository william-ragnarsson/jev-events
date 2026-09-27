import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { CalendarAttendee, CalendarEvent, GmailMessage, GmailPart, GoogleTokens } from "@jev-events/google";
import type { NewConnection } from "jev-events";

import type { EventTime } from "../src/calendar/item.js";

// A fake Google on one local port: Gmail, Calendar and OAuth, the way the Google package calls them.
// It keeps real state (labels, history IDs, sync tokens, recurring series) so the sources and actions
// run their real code paths. Creating one points JEV_GOOGLE_API_URL at it; close() points it back.

export interface FakeGoogleOptions {
  /** The signed-in address. Default "me@acme.com". */
  me?: string;
  /** The primary calendar's time zone. Default "Europe/Stockholm". */
  timeZone?: string;
  clientId?: string;
  /** "" accepts requests without a secret. Default "secret-1". */
  clientSecret?: string;
  /** Items per page for history and event lists, so paging runs. Default 2. */
  pageSize?: number;
}

export interface FakeRequest {
  method: string;
  api: "gmail" | "calendar" | "oauth";
  /** Relative to the API and still URL-encoded, e.g. "/messages/m1/trash" or "/calendars/primary/events". */
  path: string;
  query: Record<string, string>;
  body: unknown;
  /** The bearer token sent, if any. */
  token: string | undefined;
}

export interface FailOptions {
  /** The response body. Default: what Google sends for that status. */
  body?: unknown;
  /** How many requests get this response. Default 1. */
  times?: number;
  /** Default `{ "Retry-After": "0" }`, so retries don't wait. */
  headers?: Record<string, string>;
  /** Runs when the response is served, e.g. to change state in between. */
  run?: () => void;
}

export interface FakeMail {
  /** "Ann <ann@example.com>" */
  from: string;
  /** Default: the signed-in address. */
  to?: string;
  cc?: string;
  replyTo?: string;
  subject?: string;
  text?: string;
  html?: string;
  attachments?: Array<{ filename: string; mimeType: string; size?: number; contentId?: string }>;
  /** Extra or replaced headers, matched case-insensitively. `undefined` removes one. */
  headers?: Record<string, string | undefined>;
  /** Default ["INBOX", "UNREAD"]. */
  labels?: string[];
  threadId?: string;
}

export interface FakeDraft {
  id: string;
  threadId: string | undefined;
  /** As sent: base64url. */
  raw: string;
  /** The decoded MIME message. */
  mime: string;
}

export type FakeEvent = CalendarEvent & { originalStartTime?: EventTime };

interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

interface Override {
  route: string | RegExp;
  status: number;
  times: number;
  options: FailOptions;
}

interface Label {
  id: string;
  name: string;
  type: "system" | "user";
  labelListVisibility?: string;
  messageListVisibility?: string;
}

interface Code {
  redirectUri: string;
  challenge: string;
  scopes: string[];
  refreshToken: boolean;
}

interface StoredEvent {
  event: FakeEvent;
  /** The change counter when it last changed, for sync tokens. */
  changedAt: number;
}

const SYSTEM_LABELS = [
  "INBOX",
  "SENT",
  "TRASH",
  "SPAM",
  "DRAFT",
  "UNREAD",
  "STARRED",
  "IMPORTANT",
  "CHAT",
  "CATEGORY_PERSONAL",
  "CATEGORY_SOCIAL",
  "CATEGORY_PROMOTIONS",
  "CATEGORY_UPDATES",
  "CATEGORY_FORUMS",
];
const ALL_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar.events",
];
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export async function fakeGoogle(options: FakeGoogleOptions = {}): Promise<FakeGoogle> {
  const google = new FakeGoogle(options);
  await google.listen();
  return google;
}

export class FakeGoogle {
  url = "";
  readonly me: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly pageSize: number;
  /** Every request, in order, recorded before it's answered. */
  readonly requests: FakeRequest[] = [];
  readonly drafts: FakeDraft[] = [];

  readonly #server = createServer((request, response) => void this.#handle(request, response));
  #previousUrl: string | undefined;
  #overrides: Override[] = [];
  #lastNow = 0;

  // OAuth
  #accessTokens = new Set<string>();
  #refreshTokens = new Map<string, string[]>([["refresh-1", ALL_SCOPES]]);
  #accessCount = 0;
  #refreshCount = 1;
  #codes = new Map<string, Code>();
  #codeCount = 0;
  #consent: { deny?: boolean; withhold?: string[]; refreshToken?: boolean } = {};

  // Gmail
  #historyId = 1000;
  #historyFloor = 0;
  #history: Array<{ id: number; message: { id: string; threadId: string; labelIds: string[] } }> = [];
  #messages = new Map<string, GmailMessage>();
  #order: string[] = [];
  #messageCount = 0;
  #labels: Label[] = SYSTEM_LABELS.map((id) => ({ id, name: id, type: "system" }));
  #labelCount = 0;
  #emailed = new Set<string>();

  // Calendar
  #calendars = new Map<string, { id: string; summary: string; timeZone: string }>();
  #events = new Map<string, Map<string, StoredEvent>>();
  #eventCount = 0;
  #seq = 0;
  #syncFloor = 0;

  constructor(options: FakeGoogleOptions = {}) {
    this.me = options.me ?? "me@acme.com";
    this.clientId = options.clientId ?? "client-1";
    this.clientSecret = options.clientSecret ?? "secret-1";
    this.pageSize = options.pageSize ?? 2;
    this.addCalendar(this.me, options.timeZone ?? "Europe/Stockholm");
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.#server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
    this.#previousUrl = process.env.JEV_GOOGLE_API_URL;
    process.env.JEV_GOOGLE_API_URL = this.url;
  }

  async close(): Promise<void> {
    if (this.#previousUrl === undefined) delete process.env.JEV_GOOGLE_API_URL;
    else process.env.JEV_GOOGLE_API_URL = this.#previousUrl;
    await new Promise<void>((resolve) => {
      this.#server.close(() => resolve());
      this.#server.closeAllConnections();
    });
  }

  /** Requests to one route, such as "POST /messages/m1/trash", or all of them. */
  calls(route?: string | RegExp): FakeRequest[] {
    return route === undefined ? this.requests : this.requests.filter((r) => matches(route, `${r.method} ${r.path}`));
  }

  /** Answer the next request(s) to `route` ("METHOD /path", no query) with `status` instead. */
  fail(route: string | RegExp, status: number, options: FailOptions = {}): void {
    this.#overrides.push({ route, status, times: options.times ?? 1, options });
  }

  // -------------------------------------------------------------------------------------------------
  // Sign-in

  /** The signed-in account as `authorize()` saves it: tokens, plus the OAuth client that renews them. */
  connection(): NewConnection {
    const { email: _email, ...tokens } = this.tokens();
    return { account: this.me, label: this.me, credentials: tokens, facts: { email: this.me } };
  }

  /** Tokens for the signed-in account. */
  tokens(): GoogleTokens {
    return {
      clientId: this.clientId,
      ...(this.clientSecret ? { clientSecret: this.clientSecret } : {}),
      accessToken: this.#issueAccessToken(),
      refreshToken: "refresh-1",
      expiresAt: Date.now() + 3_600_000,
      email: this.me,
    };
  }

  /** Every access token stops working, as if an hour passed. Refresh tokens still work. */
  expireAccessTokens(): void {
    this.#accessTokens.clear();
  }

  /** Every refresh token stops working, as if the user removed access. */
  revoke(): void {
    this.#refreshTokens.clear();
  }

  /** What the user does on the next consent screen. */
  consent(choice: { deny?: boolean; withhold?: string[]; refreshToken?: boolean }): void {
    this.#consent = choice;
  }

  // -------------------------------------------------------------------------------------------------
  // Gmail

  /** A new email arrives. Returns its ID. */
  deliver(mail: FakeMail): string {
    const id = `m${++this.#messageCount}`;
    this.#historyId++;
    const message = buildMessage(mail, { id, me: this.me, internalDate: this.#now(), historyId: this.#historyId });
    this.#messages.set(id, message);
    this.#order.push(id);
    this.#history.push({ id: this.#historyId, message: { id, threadId: message.threadId, labelIds: [...(message.labelIds ?? [])] } });
    return id;
  }

  message(id: string): GmailMessage | undefined {
    return this.#messages.get(id);
  }

  relabel(id: string, change: { add?: string[]; remove?: string[] }): void {
    const message = this.#messages.get(id);
    if (!message) throw new Error(`No message ${id}.`);
    this.#applyLabels(message, change.add ?? [], change.remove ?? []);
  }

  /** Gone for good, e.g. deleted in another client before the source fetched it. */
  remove(id: string): void {
    this.#messages.delete(id);
    this.#order = this.#order.filter((other) => other !== id);
  }

  /** History from before now is gone, as when a source was paused for about a week. */
  expireHistory(): void {
    this.#historyId++;
    this.#historyFloor = this.#historyId;
  }

  /** The user has sent mail to these addresses. */
  emailed(...addresses: string[]): void {
    for (const address of addresses) this.#emailed.add(address.toLowerCase());
  }

  /** A user label. Returns its ID. */
  addLabel(name: string): string {
    const label: Label = { id: `Label_${++this.#labelCount}`, name, type: "user" };
    this.#labels.push(label);
    return label.id;
  }

  labels(): Label[] {
    return this.#labels.map((label) => ({ ...label }));
  }

  // -------------------------------------------------------------------------------------------------
  // Calendar

  addCalendar(id: string, timeZone: string): void {
    this.#calendars.set(id, { id, summary: id, timeZone });
    if (!this.#events.has(id)) this.#events.set(id, new Map());
  }

  /** Add an event. Defaults: organized by you, starting in 2 hours, 30 minutes long. */
  addEvent(partial: Partial<FakeEvent> = {}, calendarId = "primary"): FakeEvent {
    const events = this.#eventsOf(calendarId);
    if (!events) throw new Error(`No calendar ${calendarId}.`);
    const id = partial.id ?? `e${++this.#eventCount}`;
    const start = partial.start ?? { dateTime: new Date(Date.now() + 2 * 60 * MINUTE).toISOString() };
    const end = partial.end ?? defaultEnd(start);
    const organizer = this.#person(partial.organizer ?? { email: this.me });
    const stamp = new Date(this.#now()).toISOString();
    const event: FakeEvent = {
      id,
      status: "confirmed",
      htmlLink: `https://calendar.google.com/event?eid=${id}`,
      created: stamp,
      updated: stamp,
      eventType: "default",
      ...partial,
      start,
      end,
      organizer,
      creator: this.#person(partial.creator ?? organizer),
      ...(partial.attendees ? { attendees: partial.attendees.map((a) => this.#attendee(a, organizer)) } : {}),
    };
    events.set(id, { event: structuredClone(event), changedAt: ++this.#seq });
    return structuredClone(event);
  }

  updateEvent(id: string, changes: Partial<FakeEvent>, calendarId = "primary"): FakeEvent {
    return this.#change(id, calendarId, (event) => {
      Object.assign(event, changes);
      if (changes.organizer) event.organizer = this.#person(changes.organizer);
      if (changes.attendees) event.attendees = changes.attendees.map((a) => this.#attendee(a, event.organizer ?? {}));
    });
  }

  cancelEvent(id: string, calendarId = "primary"): void {
    this.#change(id, calendarId, (event) => {
      event.status = "cancelled";
    });
  }

  /** An attendee answers the invite. Nothing Jev reads changes. */
  respond(id: string, email: string, status: NonNullable<CalendarAttendee["responseStatus"]>, calendarId = "primary"): void {
    this.#change(id, calendarId, (event) => {
      const attendee = event.attendees?.find((a) => a.email?.toLowerCase() === email.toLowerCase());
      if (!attendee) throw new Error(`${email} isn't invited to ${id}.`);
      attendee.responseStatus = status;
    });
  }

  event(id: string, calendarId = "primary"): FakeEvent | undefined {
    const stored = this.#eventsOf(calendarId)?.get(id);
    return stored ? structuredClone(stored.event) : undefined;
  }

  /** Every sync token stops working, as Google does now and then. */
  expireSync(): void {
    this.#seq++;
    this.#syncFloor = this.#seq;
  }

  // -------------------------------------------------------------------------------------------------
  // Serving

  async #handle(incoming: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(incoming.url ?? "/", this.url);
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    const route = splitRoute(url.pathname);
    if (!route) return send(response, { status: 404, body: "Not found" });

    const request: FakeRequest = {
      method: incoming.method ?? "GET",
      api: route.api,
      path: route.path,
      query: Object.fromEntries(url.searchParams),
      body: parseBody(text, incoming.headers["content-type"]),
      token: /^Bearer (.+)$/.exec(incoming.headers.authorization ?? "")?.[1],
    };
    this.requests.push(request);

    const override = this.#overrides.find((o) => o.times > 0 && matches(o.route, `${request.method} ${request.path}`));
    if (override) {
      override.times--;
      override.options.run?.();
      return send(response, {
        status: override.status,
        body: override.options.body ?? defaultBody(override.status, route.api),
        headers: override.options.headers ?? { "Retry-After": "0" },
      });
    }

    try {
      if (route.api === "oauth") return send(response, this.#oauth(request));
      if (!request.token || !this.#accessTokens.has(request.token)) {
        return send(response, {
          status: 401,
          body: defaultBody(401, route.api),
          headers: { "WWW-Authenticate": 'Bearer realm="https://accounts.google.com/", error="invalid_token"' },
        });
      }
      send(response, route.api === "gmail" ? this.#gmail(request) : this.#calendar(request));
    } catch (error) {
      send(response, { status: 500, body: `Fake Google broke: ${(error as Error).stack ?? String(error)}` });
    }
  }

  #oauth(request: FakeRequest): Reply {
    if (request.path === "/o/oauth2/v2/auth") return this.#consentScreen(request.query);
    if (request.path !== "/token" || request.method !== "POST") return { status: 404, body: "Not found" };
    const form = (request.body ?? {}) as Record<string, string | undefined>;
    if (form.client_id !== this.clientId || (form.client_secret ?? "") !== this.clientSecret) {
      return { status: 401, body: { error: "invalid_client", error_description: "Unauthorized" } };
    }
    if (form.grant_type === "refresh_token") {
      const scopes = this.#refreshTokens.get(form.refresh_token ?? "");
      if (!scopes) return { status: 400, body: { error: "invalid_grant", error_description: "Token has been expired or revoked." } };
      return { status: 200, body: { access_token: this.#issueAccessToken(), expires_in: 3599, scope: scopes.join(" "), token_type: "Bearer" } };
    }
    if (form.grant_type === "authorization_code") {
      const code = this.#codes.get(form.code ?? "");
      this.#codes.delete(form.code ?? "");
      if (!code) return { status: 400, body: { error: "invalid_grant", error_description: "Malformed auth code." } };
      if (code.redirectUri !== form.redirect_uri) return { status: 400, body: { error: "redirect_uri_mismatch", error_description: "Bad Request" } };
      const challenge = createHash("sha256").update(form.code_verifier ?? "").digest("base64url");
      if (challenge !== code.challenge) return { status: 400, body: { error: "invalid_grant", error_description: "Invalid code verifier." } };
      let refreshToken: string | undefined;
      if (code.refreshToken) {
        refreshToken = `refresh-${++this.#refreshCount}`;
        this.#refreshTokens.set(refreshToken, code.scopes);
      }
      return {
        status: 200,
        body: {
          access_token: this.#issueAccessToken(),
          ...(refreshToken ? { refresh_token: refreshToken } : {}),
          expires_in: 3599,
          scope: code.scopes.join(" "),
          token_type: "Bearer",
          ...(code.scopes.includes("openid") ? { id_token: this.#idToken() } : {}),
        },
      };
    }
    return { status: 400, body: { error: "unsupported_grant_type", error_description: `Invalid grant_type: ${form.grant_type ?? ""}` } };
  }

  /** Google's sign-in page, where the user always says yes unless `consent()` says otherwise. */
  #consentScreen(query: Record<string, string>): Reply {
    if (query.client_id !== this.clientId) return { status: 400, body: "Error 401: invalid_client. The OAuth client was not found." };
    const consent = this.#consent;
    this.#consent = {};
    const redirect = new URL(query.redirect_uri ?? "");
    if (consent.deny) {
      redirect.search = new URLSearchParams({ error: "access_denied", state: query.state ?? "" }).toString();
      return { status: 302, headers: { Location: redirect.href } };
    }
    const requested = (query.scope ?? "").split(" ").filter(Boolean);
    const granted = requested.filter((scope) => !consent.withhold?.includes(scope));
    const code = `code-${++this.#codeCount}`;
    this.#codes.set(code, {
      redirectUri: query.redirect_uri ?? "",
      challenge: query.code_challenge ?? "",
      scopes: granted,
      refreshToken: consent.refreshToken ?? query.access_type === "offline",
    });
    redirect.search = new URLSearchParams({ code, scope: granted.join(" "), state: query.state ?? "" }).toString();
    return { status: 302, headers: { Location: redirect.href } };
  }

  #gmail(request: FakeRequest): Reply {
    const { method, path, query } = request;
    const route = `${method} ${path}`;
    if (route === "GET /profile") {
      return ok({ emailAddress: this.me, messagesTotal: this.#messages.size, threadsTotal: this.#messages.size, historyId: String(this.#historyId) });
    }
    if (route === "GET /history") {
      const start = Number(query.startHistoryId);
      if (!Number.isFinite(start) || start < this.#historyFloor) return error(404, "gmail");
      const records = this.#history.filter((r) => r.id > start && (!query.labelId || r.message.labelIds.includes(query.labelId)));
      const offset = Number(query.pageToken ?? 0);
      const page = records.slice(offset, offset + this.pageSize);
      const next = offset + this.pageSize < records.length ? String(offset + this.pageSize) : undefined;
      return ok({
        ...(page.length > 0
          ? { history: page.map((r) => ({ id: String(r.id), messages: [r.message], messagesAdded: [{ message: r.message }] })) }
          : {}),
        ...(next ? { nextPageToken: next } : {}),
        historyId: String(this.#historyId),
      });
    }
    if (route === "GET /messages") return this.#listMessages(query);
    if (route === "GET /labels") return ok({ labels: this.labels() });
    if (route === "POST /labels") {
      const body = request.body as { name?: string; labelListVisibility?: string; messageListVisibility?: string };
      const name = body.name ?? "";
      if (this.#labels.some((label) => label.name.toLowerCase() === name.toLowerCase())) {
        return { status: 409, body: googleError(409, "Label name exists or conflicts", "alreadyExists", "ALREADY_EXISTS") };
      }
      const label: Label = {
        id: `Label_${++this.#labelCount}`,
        name,
        type: "user",
        ...(body.labelListVisibility ? { labelListVisibility: body.labelListVisibility } : {}),
        ...(body.messageListVisibility ? { messageListVisibility: body.messageListVisibility } : {}),
      };
      this.#labels.push(label);
      return ok(label);
    }
    if (route === "POST /drafts") {
      const body = request.body as { message?: { raw?: string; threadId?: string } };
      const raw = body.message?.raw ?? "";
      const draft: FakeDraft = {
        id: `r-${this.drafts.length + 1}`,
        threadId: body.message?.threadId,
        raw,
        mime: Buffer.from(raw, "base64url").toString("utf8"),
      };
      this.drafts.push(draft);
      return ok({ id: draft.id, message: { id: `draft-message-${this.drafts.length}`, threadId: draft.threadId, labelIds: ["DRAFT"] } });
    }

    const match = /^\/messages\/([^/]+)(?:\/(trash|modify))?$/.exec(path);
    const message = match ? this.#messages.get(decodeURIComponent(match[1] ?? "")) : undefined;
    if (!match) return error(404, "gmail");
    if (!message) return error(404, "gmail");
    const summary = () => ok({ id: message.id, threadId: message.threadId, labelIds: message.labelIds });
    if (method === "GET" && !match[2]) return ok(message);
    if (method === "POST" && match[2] === "trash") {
      this.#applyLabels(message, ["TRASH"], ["INBOX"]);
      return summary();
    }
    if (method === "POST" && match[2] === "modify") {
      const body = request.body as { addLabelIds?: string[]; removeLabelIds?: string[] };
      const unknown = [...(body.addLabelIds ?? []), ...(body.removeLabelIds ?? [])].find((id) => !this.#labels.some((l) => l.id === id));
      if (unknown) return { status: 400, body: googleError(400, `Invalid label: ${unknown}`, "invalidArgument", "INVALID_ARGUMENT") };
      this.#applyLabels(message, body.addLabelIds ?? [], body.removeLabelIds ?? []);
      return summary();
    }
    return error(404, "gmail");
  }

  #listMessages(query: Record<string, string>): Reply {
    if (query.q !== undefined) {
      // The only search the package runs: have you ever sent mail to this address?
      const search = /^in:sent \{to:(\S+) cc:\1 bcc:\1\}$/.exec(query.q);
      if (!search) return { status: 400, body: googleError(400, `Unexpected search: ${query.q}`, "invalidArgument", "INVALID_ARGUMENT") };
      return this.#emailed.has((search[1] ?? "").toLowerCase())
        ? ok({ messages: [{ id: "sent-1", threadId: "t-sent" }], resultSizeEstimate: 1 })
        : ok({ resultSizeEstimate: 0 });
    }
    const includeSpamTrash = query.includeSpamTrash === "true";
    const ids = [...this.#order].reverse().filter((id) => {
      const labels = this.#messages.get(id)?.labelIds ?? [];
      if (!includeSpamTrash && (labels.includes("SPAM") || labels.includes("TRASH"))) return false;
      return !query.labelIds || labels.includes(query.labelIds);
    });
    const page = ids.slice(0, Number(query.maxResults ?? 100)).map((id) => ({ id, threadId: this.#messages.get(id)?.threadId }));
    return ok({ ...(page.length > 0 ? { messages: page } : {}), resultSizeEstimate: page.length });
  }

  #applyLabels(message: GmailMessage, add: string[], remove: string[]): void {
    const labels = new Set(message.labelIds ?? []);
    for (const id of add) labels.add(id);
    for (const id of remove) labels.delete(id);
    message.labelIds = [...labels];
    message.historyId = String(++this.#historyId);
  }

  #calendar(request: FakeRequest): Reply {
    const { method, path, query } = request;
    const calendarOnly = /^\/calendars\/([^/]+)$/.exec(path);
    if (calendarOnly && method === "GET") {
      const calendar = this.#calendars.get(this.#calendarKey(calendarOnly[1] ?? ""));
      return calendar ? ok({ kind: "calendar#calendar", ...calendar }) : error(404, "calendar");
    }
    const match = /^\/calendars\/([^/]+)\/events(?:\/([^/]+)(?:\/(instances))?)?$/.exec(path);
    const events = match ? this.#eventsOf(decodeURIComponent(match[1] ?? "")) : undefined;
    if (!match || !events) return error(404, "calendar");
    const eventId = match[2] === undefined ? undefined : decodeURIComponent(match[2]);

    if (eventId === undefined) {
      if (method !== "GET") return error(404, "calendar");
      const timeZone = this.#calendars.get(this.#calendarKey(match[1] ?? ""))?.timeZone ?? "UTC";
      return query.syncToken ? this.#changes(events, query, timeZone) : this.#fullList(events, query, timeZone);
    }
    const stored = events.get(eventId);
    if (!stored) return error(404, "calendar");
    if (match[3] === "instances") {
      const after = query.timeMin ? Date.parse(query.timeMin) : Number.NEGATIVE_INFINITY;
      const upcoming = instancesOf(stored.event).filter((e) => endMs(e) > after);
      return ok({ items: upcoming.slice(0, Number(query.maxResults ?? 250)) });
    }
    if (method === "GET") return ok(stored.event);
    if (method === "PATCH") {
      const { attendeesOmitted, attendees, ...rest } = request.body as Partial<FakeEvent> & { attendeesOmitted?: boolean };
      const event = stored.event;
      Object.assign(event, rest);
      if (attendees && attendeesOmitted) {
        // Only the attendees sent change; the rest of the guest list stays.
        for (const sent of attendees) {
          const existing = event.attendees?.find((a) => a.email?.toLowerCase() === sent.email?.toLowerCase());
          if (existing) Object.assign(existing, sent);
          else (event.attendees ??= []).push(this.#attendee(sent, event.organizer ?? {}));
        }
      } else if (attendees) {
        event.attendees = attendees.map((a) => this.#attendee(a, event.organizer ?? {}));
      }
      event.updated = new Date(this.#now()).toISOString();
      stored.changedAt = ++this.#seq;
      return ok(event);
    }
    return error(404, "calendar");
  }

  /**
   * A full list: events ending after `timeMin` and starting before `timeMax`, and a sync token on
   * the last page unless ordered by start.
   */
  #fullList(events: Map<string, StoredEvent>, query: Record<string, string>, timeZone: string): Reply {
    const single = query.singleEvents === "true";
    if (query.orderBy === "startTime" && !single) {
      return { status: 400, body: googleError(400, "The requested ordering is not available for the particular query.", "invalid", "INVALID_ARGUMENT") };
    }
    const after = query.timeMin ? Date.parse(query.timeMin) : Number.NEGATIVE_INFINITY;
    const before = query.timeMax ? Date.parse(query.timeMax) : Number.POSITIVE_INFINITY;
    const within = (event: FakeEvent) => endMs(event) > after && startMs(event) < before;
    let list = [...events.values()].map((stored) => stored.event).filter((event) => event.status !== "cancelled");
    if (single) list = list.flatMap((event) => instancesOf(event));
    list = list.filter((event) => (event.recurrence?.length ? instancesOf(event).some(within) : within(event)));
    if (query.orderBy === "startTime") list.sort((a, b) => startMs(a) - startMs(b));

    const [offset, upTo] = parsePageToken(query.pageToken, this.#seq);
    const size = Math.min(Number(query.maxResults ?? 250), this.pageSize);
    const page = list.slice(offset, offset + size);
    const more = offset + size < list.length;
    return ok({
      kind: "calendar#events",
      timeZone,
      items: page,
      ...(more ? { nextPageToken: `p-${offset + size}-${upTo}` } : {}),
      ...(!more && query.orderBy !== "startTime" ? { nextSyncToken: `sync-${upTo}` } : {}),
    });
  }

  /** What changed since a sync token, cancelled events included. */
  #changes(events: Map<string, StoredEvent>, query: Record<string, string>, timeZone: string): Reply {
    if (query.timeMin || query.timeMax || query.orderBy) {
      return { status: 400, body: googleError(400, "Sync token cannot be combined with timeMin, timeMax or orderBy.", "invalid", "INVALID_ARGUMENT") };
    }
    const since = Number(/^sync-(\d+)$/.exec(query.syncToken ?? "")?.[1] ?? Number.NaN);
    if (!Number.isFinite(since) || since < this.#syncFloor) return error(410, "calendar");
    const [offset, upTo] = parsePageToken(query.pageToken, this.#seq);
    const changed = [...events.values()]
      .filter((stored) => stored.changedAt > since && stored.changedAt <= upTo)
      .sort((a, b) => a.changedAt - b.changedAt)
      .map((stored) => stored.event);
    const size = Math.min(Number(query.maxResults ?? 250), this.pageSize);
    const page = changed.slice(offset, offset + size);
    const more = offset + size < changed.length;
    return ok({
      kind: "calendar#events",
      timeZone,
      items: page,
      ...(more ? { nextPageToken: `p-${offset + size}-${upTo}` } : { nextSyncToken: `sync-${upTo}` }),
    });
  }

  #change(id: string, calendarId: string, apply: (event: FakeEvent) => void): FakeEvent {
    const stored = this.#eventsOf(calendarId)?.get(id);
    if (!stored) throw new Error(`No event ${id} on ${calendarId}.`);
    apply(stored.event);
    stored.event.updated = new Date(this.#now()).toISOString();
    stored.changedAt = ++this.#seq;
    return structuredClone(stored.event);
  }

  #calendarKey(id: string): string {
    const decoded = decodeURIComponent(id);
    return decoded === "primary" ? this.me : decoded;
  }

  #eventsOf(calendarId: string): Map<string, StoredEvent> | undefined {
    return this.#events.get(this.#calendarKey(calendarId));
  }

  #person<P extends { email?: string }>(person: P): P & { self?: boolean } {
    return person.email?.toLowerCase() === this.me ? { ...person, self: true } : { ...person };
  }

  #attendee(attendee: CalendarAttendee, organizer: { email?: string }): CalendarAttendee {
    const email = attendee.email?.toLowerCase();
    return {
      responseStatus: "needsAction",
      ...attendee,
      ...(email === this.me ? { self: true } : {}),
      ...(email && email === organizer.email?.toLowerCase() ? { organizer: true } : {}),
    };
  }

  // -------------------------------------------------------------------------------------------------

  #issueAccessToken(): string {
    const token = `access-${++this.#accessCount}`;
    this.#accessTokens.add(token);
    return token;
  }

  #idToken(): string {
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const claims = { email: this.me, email_verified: true, aud: this.clientId, iss: "https://accounts.google.com" };
    return `${part({ alg: "RS256", typ: "JWT" })}.${part(claims)}.signature`;
  }

  /** Epoch milliseconds that never repeat, so order by time is order of arrival. */
  #now(): number {
    this.#lastNow = Math.max(Date.now(), this.#lastNow + 1);
    return this.#lastNow;
  }
}

/** A Gmail message as `messages.get?format=full` returns it. */
export function buildMessage(
  mail: FakeMail,
  options: { id?: string; me?: string; internalDate?: number; historyId?: number } = {},
): GmailMessage {
  const id = options.id ?? "m1";
  const date = options.internalDate ?? Date.now();
  const headers = new Map<string, { name: string; value: string | undefined }>();
  const set = (name: string, value: string | undefined) => headers.set(name.toLowerCase(), { name, value });
  set("From", mail.from);
  set("To", mail.to ?? options.me ?? "me@acme.com");
  set("Cc", mail.cc);
  set("Reply-To", mail.replyTo);
  set("Subject", mail.subject);
  set("Date", new Date(date).toUTCString());
  set("Message-ID", `<${id}@mail.example>`);
  set("MIME-Version", "1.0");
  for (const [name, value] of Object.entries(mail.headers ?? {})) set(name, value);

  const bodies: GmailPart[] = [];
  if (mail.text !== undefined || mail.html === undefined) bodies.push(textPart("text/plain", mail.text ?? ""));
  if (mail.html !== undefined) bodies.push(textPart("text/html", mail.html));
  let root: GmailPart = bodies.length === 1 && bodies[0] ? bodies[0] : multipart("alternative", bodies);
  if (mail.attachments?.length) {
    root = multipart("mixed", [
      root,
      ...mail.attachments.map((file, index) => ({
        mimeType: file.mimeType,
        filename: file.filename,
        headers: [
          { name: "Content-Type", value: `${file.mimeType}; name="${file.filename}"` },
          { name: "Content-Disposition", value: `${file.contentId ? "inline" : "attachment"}; filename="${file.filename}"` },
          ...(file.contentId ? [{ name: "Content-ID", value: `<${file.contentId}>` }] : []),
          { name: "Content-Transfer-Encoding", value: "base64" },
        ],
        body: { size: file.size ?? 1024, attachmentId: `att-${index + 1}` },
      })),
    ]);
  }

  const top = [...headers.values()].flatMap(({ name, value }) => (value === undefined ? [] : [{ name, value }]));
  const plain = mail.text ?? (mail.html ?? "").replace(/<[^>]*>/g, " ");
  return {
    id,
    threadId: mail.threadId ?? `t-${id}`,
    labelIds: [...(mail.labels ?? ["INBOX", "UNREAD"])],
    snippet: escapeHtml(plain.replace(/\s+/g, " ").trim().slice(0, 200)),
    historyId: String(options.historyId ?? 1000),
    internalDate: String(date),
    payload: { ...root, headers: [...top, ...(root.headers ?? [])] },
  };
}

function textPart(mimeType: "text/plain" | "text/html", content: string): GmailPart {
  return {
    mimeType,
    filename: "",
    headers: [
      { name: "Content-Type", value: `${mimeType}; charset="UTF-8"` },
      { name: "Content-Transfer-Encoding", value: "quoted-printable" },
    ],
    body: { size: Buffer.byteLength(content), data: Buffer.from(content).toString("base64url") },
  };
}

function multipart(kind: "alternative" | "mixed", parts: GmailPart[]): GmailPart {
  return {
    mimeType: `multipart/${kind}`,
    filename: "",
    headers: [{ name: "Content-Type", value: `multipart/${kind}; boundary="${kind}-boundary"` }],
    body: { size: 0 },
    parts,
  };
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** The occurrences of a recurring event (DAILY or WEEKLY, 30 by default), or the event itself. */
function instancesOf(event: FakeEvent): FakeEvent[] {
  const rule = event.recurrence?.find((line) => line.startsWith("RRULE:"));
  if (!rule) return [event];
  const parts = new Map(rule.slice("RRULE:".length).split(";").map((part) => part.split("=") as [string, string]));
  const step = parts.get("FREQ") === "WEEKLY" ? 7 * DAY : DAY;
  const count = Number(parts.get("COUNT") ?? 30);
  const { recurrence: _recurrence, ...single } = event;
  return Array.from({ length: count }, (_, index) => {
    const start = shift(event.start, index * step);
    const stamp = start.dateTime ? new Date(start.dateTime).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "") : (start.date ?? "").replace(/-/g, "");
    return {
      ...structuredClone(single),
      id: `${event.id}_${stamp}`,
      recurringEventId: event.id,
      originalStartTime: start,
      start,
      end: shift(event.end, index * step),
    };
  });
}

function shift(time: EventTime | undefined, ms: number): EventTime {
  if (time?.dateTime) return { ...time, dateTime: new Date(Date.parse(time.dateTime) + ms).toISOString() };
  const date = time?.date ?? "1970-01-01";
  return { ...time, date: new Date(Date.parse(`${date}T00:00:00Z`) + ms).toISOString().slice(0, 10) };
}

function defaultEnd(start: EventTime): EventTime {
  return start.dateTime ? shift(start, 30 * MINUTE) : shift(start, DAY);
}

function startMs(event: FakeEvent): number {
  return timeMs(event.start);
}

function endMs(event: FakeEvent): number {
  return timeMs(event.end ?? event.start);
}

function timeMs(time: EventTime | undefined): number {
  if (time?.dateTime) return Date.parse(time.dateTime);
  if (time?.date) return Date.parse(`${time.date}T00:00:00Z`);
  return Number.POSITIVE_INFINITY;
}

function parsePageToken(token: string | undefined, seq: number): [offset: number, upTo: number] {
  const match = /^p-(\d+)-(\d+)$/.exec(token ?? "");
  return match ? [Number(match[1]), Number(match[2])] : [0, seq];
}

function splitRoute(pathname: string): { api: FakeRequest["api"]; path: string } | undefined {
  const gmail = "/gmail/v1/users/me";
  const calendar = "/calendar/v3";
  if (pathname.startsWith(`${gmail}/`)) return { api: "gmail", path: pathname.slice(gmail.length) };
  if (pathname.startsWith(`${calendar}/`)) return { api: "calendar", path: pathname.slice(calendar.length) };
  if (pathname === "/token" || pathname === "/o/oauth2/v2/auth") return { api: "oauth", path: pathname };
  return undefined;
}

function matches(route: string | RegExp, request: string): boolean {
  return typeof route === "string" ? route === request : route.test(request);
}

function parseBody(text: string, contentType: string | undefined): unknown {
  if (!text) return undefined;
  if (contentType?.includes("application/json")) return JSON.parse(text) as unknown;
  if (contentType?.includes("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(text));
  return text;
}

function send(response: ServerResponse, reply: Reply): void {
  const { status, body, headers = {} } = reply;
  if (body === undefined || body === "") {
    response.writeHead(status, headers).end();
  } else if (typeof body === "string") {
    response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", ...headers }).end(body);
  } else {
    response.writeHead(status, { "Content-Type": "application/json; charset=UTF-8", ...headers }).end(JSON.stringify(body));
  }
}

function ok(body: unknown): Reply {
  return { status: 200, body };
}

function error(status: number, api: FakeRequest["api"]): Reply {
  return { status, body: defaultBody(status, api) };
}

/** Google's error shape: `{ error: { code, message, errors: [{ reason }], status } }`. */
export function googleError(code: number, message: string, reason: string, status: string, domain = "global") {
  return { error: { code, message, errors: [{ message, domain, reason }], status } };
}

function defaultBody(status: number, api: FakeRequest["api"]): unknown {
  if (status < 400) return {};
  if (api === "oauth") return { error: "internal_failure", error_description: "Internal failure" };
  switch (status) {
    case 400:
      return googleError(400, "Bad Request", "badRequest", "INVALID_ARGUMENT");
    case 401:
      return googleError(401, "Request had invalid authentication credentials.", "authError", "UNAUTHENTICATED");
    case 403:
      return googleError(403, "Request had insufficient authentication scopes.", "insufficientPermissions", "PERMISSION_DENIED");
    case 404:
      return googleError(404, "Requested entity was not found.", "notFound", "NOT_FOUND");
    case 409:
      return googleError(409, "Requested entity already exists.", "alreadyExists", "ALREADY_EXISTS");
    case 410:
      return googleError(410, "Sync token is no longer valid, a full sync is required.", "fullSyncRequired", "GONE", "calendar");
    case 429:
      return googleError(429, "Rate Limit Exceeded", "rateLimitExceeded", "RESOURCE_EXHAUSTED");
    default:
      return googleError(status, "Backend Error", "backendError", status === 503 ? "UNAVAILABLE" : "INTERNAL");
  }
}
