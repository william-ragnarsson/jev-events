import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { WebSocketServer, type WebSocket as ServerSocket } from "ws";

import type { NewConnection } from "jev-events";

import type { ApiConversation, ApiUser, ConversationKind, EventCallback, SlackMessageEvent } from "@jev-events/slack";

// A fake Slack on one local port: the Web API methods the Slack package calls, and Socket Mode over
// a WebSocket. It keeps real state (members, history, reactions) so the source and the actions run
// their real code paths. Creating one points JEV_SLACK_API_URL at it; close() points it back.

export const BOT_TOKEN = "xoxb-1-fake-bot-token";
export const APP_TOKEN = "xapp-1-fake-app-token";
/** The app's OAuth client, for installs through `/connect/slack`. */
export const CLIENT = { id: "1111.2222", secret: "fake-client-secret" } as const;

export const TEAM = { id: "T0ACME", name: "Acme", url: "https://acme.slack.com/" } as const;
/** The app's bot user. */
export const BOT = { userId: "U0BOT", botId: "B0BOT", handle: "jev_events", name: "Jev Events", appId: "A0JEV" } as const;

export const ANN = "U0ANN";
export const BOB = "U0BOB";
/** A single-channel guest. */
export const GUEST = "U0GUEST";
/** Someone from another company, in a Slack Connect channel. */
export const ERIN = "U0ERIN";

export const GENERAL = "C0GENERAL";
export const RANDOM = "C0RANDOM";
/** A public channel the app isn't in. */
export const OFF_TOPIC = "C0OFFTOPIC";
/** The app's direct messages with Ann. */
export const ANN_DM = "D0ANNDM1";

export interface FakeSlackOptions {
  /** Entries per page for paginated methods, so paging runs. Default 2. */
  pageSize?: number;
  /** Never say hello on new Socket Mode connections, like a Slack that doesn't answer. */
  silent?: boolean;
}

export interface FakeConversation {
  id: string;
  /** Channels have one; direct messages don't. */
  name?: string;
  /** Default "channel". */
  kind?: ConversationKind;
  /** User IDs. Default: the app, Ann and Bob. */
  members?: string[];
  /** A direct message: the other person. */
  user?: string;
  archived?: boolean;
}

export interface FakeMessage {
  channel: string;
  /** Default Ann. Leave it out for a bot message with `bot_id`. */
  user?: string | undefined;
  text?: string;
  ts?: string;
  thread_ts?: string;
  subtype?: string;
  bot_id?: string;
  username?: string;
  user_team?: string;
  files?: SlackMessageEvent["files"];
  /** Default true: send it over Socket Mode too. false: only put it in the channel's history. */
  live?: boolean;
}

export interface SendOptions {
  /** The workspace the event is from. Default Acme. */
  team?: string;
}

export interface FakeCall {
  method: string;
  params: Record<string, string>;
  token: string | undefined;
}

export interface FailOptions {
  /** How many calls get this error. Default 1. */
  times?: number;
  /** Default 200, the way Slack sends most errors. */
  status?: number;
  /** A body other than `{ ok: false, error }`, e.g. an HTML error page. */
  body?: string;
  headers?: Record<string, string>;
  /** With `missing_scope`: the scope to name. */
  needed?: string;
}

interface Conversation {
  id: string;
  name?: string;
  kind: ConversationKind;
  members: Set<string>;
  user?: string;
  archived: boolean;
  /** Oldest first, the way they were posted. */
  messages: SlackMessageEvent[];
  /** "ts" → reactions the app added. */
  reactions: Map<string, string[]>;
}

interface Override {
  error: string;
  times: number;
  options: FailOptions;
}

interface Envelope {
  envelope_id: string;
  type: "events_api";
  accepts_response_payload: false;
  retry_attempt: number;
  retry_reason: string;
  payload: EventCallback;
}

interface Reply {
  status: number;
  body: string;
  headers: Record<string, string>;
}

const TYPE_OF: Record<string, ConversationKind> = {
  public_channel: "channel",
  private_channel: "private",
  im: "dm",
  mpim: "group-dm",
};

const HISTORY_SCOPE: Record<ConversationKind, string> = {
  channel: "channels:history",
  private: "groups:history",
  dm: "im:history",
  "group-dm": "mpim:history",
};

const SCOPE: Record<string, string> = {
  "users.info": "users:read",
  "chat.postMessage": "chat:write",
  "reactions.add": "reactions:write",
};

export async function fakeSlack(options: FakeSlackOptions = {}): Promise<FakeSlack> {
  const slack = new FakeSlack(options);
  await slack.listen();
  return slack;
}

export class FakeSlack {
  url = "";
  /** Envelope IDs the client acknowledged. */
  readonly acks: string[] = [];
  /** Envelope IDs sent, in order. */
  readonly sent: string[] = [];
  /** Messages the app posted with chat.postMessage. */
  readonly posted: SlackMessageEvent[] = [];
  /** Socket Mode connections opening and closing, in order: "open 1", "open 2", "close 1". */
  readonly connections: string[] = [];

  readonly #options: FakeSlackOptions;
  readonly #server = createServer((request, response) => void this.#handle(request, response));
  readonly #sockets = new Set<ServerSocket>();
  /** Connections that got their hello, newest last. Events go to the newest. */
  readonly #ready: ServerSocket[] = [];
  readonly #wss = new WebSocketServer({ server: this.#server, path: "/link/" });
  readonly #calls: FakeCall[] = [];
  readonly #users = new Map<string, ApiUser>();
  readonly #conversations = new Map<string, Conversation>();
  readonly #overrides = new Map<string, Override[]>();
  readonly #delays = new Map<string, number>();
  readonly #tickets = new Set<string>();
  /** OAuth codes handed out, each with the redirect it was for. */
  readonly #codes = new Map<string, string | undefined>();
  readonly #scopes = new Set([
    "channels:history",
    "groups:history",
    "im:history",
    "mpim:history",
    "channels:read",
    "groups:read",
    "im:read",
    "mpim:read",
    "users:read",
    "chat:write",
    "reactions:write",
  ]);
  /** Envelopes waiting for a connection, the way Slack retries while none is open. */
  #pending: Envelope[] = [];
  #last: Envelope | undefined;
  #seq = 0;
  #connectionCount = 0;
  #revoked = false;
  #appTokenRevoked = false;
  #appTokenCanConnect = true;
  #previousUrl: string | undefined;

  constructor(options: FakeSlackOptions) {
    this.#options = options;
    this.#wss.on("connection", (socket, request) => this.#connected(socket, request));

    this.addUser({ id: BOT.userId, team_id: TEAM.id, name: BOT.handle, real_name: BOT.name, is_bot: true, profile: { display_name: "", real_name: BOT.name } });
    this.addUser({ id: ANN, team_id: TEAM.id, name: "ann", real_name: "Ann Smith", is_owner: true, profile: { display_name: "", real_name: "Ann Smith" } });
    this.addUser({ id: BOB, team_id: TEAM.id, name: "bob", real_name: "Bob Jones", profile: { display_name: "Bob", real_name: "Bob Jones" } });
    this.addUser({ id: GUEST, team_id: TEAM.id, name: "gus", real_name: "Gus Guest", is_restricted: true, is_ultra_restricted: true, profile: { real_name: "Gus Guest" } });
    this.addUser({ id: ERIN, team_id: "T0PARTNER", name: "erin", real_name: "Erin Partner", profile: { real_name: "Erin Partner" } });

    this.addConversation({ id: GENERAL, name: "general" });
    this.addConversation({ id: RANDOM, name: "random" });
    this.addConversation({ id: OFF_TOPIC, name: "off-topic", members: [ANN, BOB] });
    this.addConversation({ id: ANN_DM, kind: "dm", user: ANN, members: [BOT.userId, ANN] });
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.#server.listen(0, "127.0.0.1", resolve));
    const { port } = this.#server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${port}`;
    this.#previousUrl = process.env.JEV_SLACK_API_URL;
    process.env.JEV_SLACK_API_URL = this.url;
  }

  async close(): Promise<void> {
    if (this.#previousUrl === undefined) delete process.env.JEV_SLACK_API_URL;
    else process.env.JEV_SLACK_API_URL = this.#previousUrl;
    for (const socket of this.#sockets) socket.terminate();
    await new Promise<void>((resolve) => this.#wss.close(() => resolve()));
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  addUser(user: ApiUser): void {
    this.#users.set(user.id, user);
  }

  addConversation(conversation: FakeConversation): void {
    this.#conversations.set(conversation.id, {
      id: conversation.id,
      ...(conversation.name ? { name: conversation.name } : {}),
      kind: conversation.kind ?? "channel",
      members: new Set(conversation.members ?? [BOT.userId, ANN, BOB]),
      ...(conversation.user ? { user: conversation.user } : {}),
      archived: conversation.archived ?? false,
      messages: [],
      reactions: new Map(),
    });
  }

  /** Someone joins a conversation, such as the app after /invite. */
  join(channel: string, user = BOT.userId): void {
    this.#conversation(channel).members.add(user);
  }

  /** Someone leaves a conversation, such as the app when it's removed. */
  leave(channel: string, user = BOT.userId): void {
    this.#conversation(channel).members.delete(user);
  }

  /** Someone posts: into the channel's history, and over Socket Mode unless `live: false`. */
  post(message: FakeMessage): SlackMessageEvent {
    const conversation = this.#conversation(message.channel);
    const { live = true, channel: _channel, ...fields } = message;
    const user = "user" in message ? message.user : ANN;
    const stored: SlackMessageEvent = {
      type: "message",
      ...fields,
      ...(user ? { user } : {}),
      ...(message.text === undefined && !message.files ? { text: "" } : {}),
      ts: message.ts ?? this.#nextTs(),
      team: TEAM.id,
    };
    if (stored.user === undefined) delete stored.user;
    conversation.messages.push(stored);
    const event = { ...stored, channel: conversation.id, channel_type: channelType(conversation.kind) };
    if (live) this.send({ ...event, event_ts: event.ts });
    return event;
  }

  /** Send any event over Socket Mode, such as an edit or a reaction. Returns its envelope ID. */
  send(event: Record<string, unknown> & { type: string }, options: SendOptions = {}): string {
    const envelope: Envelope = {
      envelope_id: `env-${++this.#seq}`,
      type: "events_api",
      accepts_response_payload: false,
      retry_attempt: 0,
      retry_reason: "",
      payload: callback(event, `Ev${this.#seq}`, options.team ?? TEAM.id),
    };
    this.#deliver(envelope);
    return envelope.envelope_id;
  }

  /** The connection `npx jev-events auth slack` saves for this workspace. `appToken: false` leaves the app token out. */
  connection(options: { appToken?: boolean } = {}): NewConnection {
    return {
      account: TEAM.id,
      label: TEAM.name,
      credentials: { token: BOT_TOKEN, ...(options.appToken === false ? {} : { appToken: APP_TOKEN }) },
      facts: { team: TEAM.name, teamId: TEAM.id, userId: BOT.userId, user: BOT.handle, url: TEAM.url, botId: BOT.botId },
    };
  }

  /** A one-time code, as in Slack's redirect after someone clicks Allow. */
  code(redirectUri?: string): string {
    const code = `code-${++this.#seq}`;
    this.#codes.set(code, redirectUri);
    return code;
  }

  /** Send the last event again, the way Slack does when it doesn't hear an acknowledgement in time. */
  redeliver(): void {
    if (!this.#last) throw new Error("Nothing was sent yet.");
    this.#deliver({ ...this.#last, envelope_id: `env-${++this.#seq}`, retry_attempt: this.#last.retry_attempt + 1, retry_reason: "timeout" });
  }

  /** Ask every connection to go, the way Slack does before it closes one ("warning", "refresh_requested", "link_disabled"). */
  disconnect(reason: string): void {
    for (const socket of this.#sockets) socket.send(JSON.stringify({ type: "disconnect", reason, debug_info: { host: "fake-slack" } }));
  }

  /** Cut every connection without warning. */
  dropSockets(): void {
    for (const socket of this.#sockets) socket.terminate();
  }

  /** Open Socket Mode connections. */
  get sockets(): number {
    return this.#sockets.size;
  }

  /** The bot token stops working, as when the app is uninstalled. */
  revoke(): void {
    this.#revoked = true;
  }

  revokeAppToken(): void {
    this.#appTokenRevoked = true;
  }

  /** The app-level token was made without the connections:write scope. */
  appTokenWithoutScope(): void {
    this.#appTokenCanConnect = false;
  }

  /** The app was installed without this scope. */
  removeScope(scope: string): void {
    this.#scopes.delete(scope);
  }

  /** The next call (or `times` calls) to `method` fails with `error`. */
  fail(method: string, error: string, options: FailOptions = {}): void {
    const list = this.#overrides.get(method) ?? [];
    list.push({ error, times: options.times ?? 1, options });
    this.#overrides.set(method, list);
  }

  /** Answer every call to `method` this much later, until set back to 0. */
  delay(method: string, ms: number): void {
    this.#delays.set(method, ms);
  }

  /** Calls made, in order, optionally only to one method. */
  calls(method?: string): FakeCall[] {
    return method ? this.#calls.filter((call) => call.method === method) : [...this.#calls];
  }

  /** Emoji the app added to a message. */
  reactions(channel: string, ts: string): string[] {
    return this.#conversation(channel).reactions.get(ts) ?? [];
  }

  /** A conversation's messages, oldest first. */
  history(channel: string): SlackMessageEvent[] {
    return [...this.#conversation(channel).messages];
  }

  #conversation(id: string): Conversation {
    const conversation = this.#conversations.get(id);
    if (!conversation) throw new Error(`The fake Slack has no conversation ${id}.`);
    return conversation;
  }

  /** "1760000000.000001": this second, and a counter so each is unique and in order. */
  #nextTs(): string {
    return `${Math.floor(Date.now() / 1000)}.${String(++this.#seq).padStart(6, "0")}`;
  }

  #deliver(envelope: Envelope): void {
    this.#last = envelope;
    const socket = this.#ready.at(-1);
    if (!socket) {
      this.#pending.push(envelope);
      return;
    }
    this.sent.push(envelope.envelope_id);
    socket.send(JSON.stringify(envelope));
  }

  #connected(socket: ServerSocket, request: IncomingMessage): void {
    const ticket = new URL(request.url ?? "/", this.url).searchParams.get("ticket") ?? "";
    // Each address from apps.connections.open works once.
    if (!this.#tickets.delete(ticket)) {
      socket.close(4001, "invalid ticket");
      return;
    }
    const number = ++this.#connectionCount;
    this.connections.push(`open ${number}`);
    this.#sockets.add(socket);
    socket.on("message", (data) => {
      const { envelope_id } = JSON.parse(String(data)) as { envelope_id?: string };
      if (envelope_id) this.acks.push(envelope_id);
    });
    socket.on("close", () => {
      this.connections.push(`close ${number}`);
      this.#sockets.delete(socket);
      const index = this.#ready.indexOf(socket);
      if (index !== -1) this.#ready.splice(index, 1);
    });
    if (this.#options.silent) return;
    socket.send(JSON.stringify({ type: "hello", num_connections: this.#sockets.size, connection_info: { app_id: BOT.appId }, debug_info: { host: "fake-slack" } }));
    this.#ready.push(socket);
    const waiting = this.#pending;
    this.#pending = [];
    for (const envelope of waiting) this.#deliver(envelope);
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const raw = await readBody(request);
    const url = new URL(request.url ?? "/", this.url);
    const method = /^\/api\/([\w.]+)$/.exec(url.pathname)?.[1];
    if (!method) {
      send(response, { status: 404, body: "Not found", headers: {} });
      return;
    }
    const params = Object.fromEntries(new URLSearchParams(raw));
    const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1];
    this.#calls.push({ method, params, token });
    const delay = this.#delays.get(method);
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    send(response, this.#overridden(method) ?? this.#route(method, params, token));
  }

  #overridden(method: string): Reply | undefined {
    const override = this.#overrides.get(method)?.[0];
    if (!override) return undefined;
    if (--override.times <= 0) this.#overrides.get(method)?.shift();
    const { status = 200, body, headers = {}, needed } = override.options;
    if (body !== undefined) return { status, body, headers: { "Content-Type": "text/html", ...headers } };
    const retryAfter: Record<string, string> = status === 429 ? { "Retry-After": "0" } : {};
    return reply({ ok: false, error: override.error, ...(needed ? { needed } : {}) }, status, { ...retryAfter, ...headers });
  }

  #route(method: string, params: Record<string, string>, token: string | undefined): Reply {
    if (method === "apps.connections.open") return this.#open(token);
    if (method === "oauth.v2.access") return this.#install(params);

    if (!token) return fail("not_authed");
    if (token.startsWith("xapp-")) return fail("not_allowed_token_type");
    if (token !== BOT_TOKEN) return fail("invalid_auth");
    if (this.#revoked) return fail("token_revoked");
    const scope = SCOPE[method];
    if (scope && !this.#scopes.has(scope)) return fail("missing_scope", { needed: scope });

    switch (method) {
      case "auth.test":
        return ok({ url: TEAM.url, team: TEAM.name, user: BOT.handle, team_id: TEAM.id, user_id: BOT.userId, bot_id: BOT.botId, is_enterprise_install: false });
      case "users.info": {
        const user = this.#users.get(params.user ?? "");
        return user ? ok({ user }) : fail("user_not_found");
      }
      case "conversations.info": {
        const conversation = this.#visible(params.channel);
        return conversation ? ok({ channel: this.#describe(conversation, true) }) : fail("channel_not_found");
      }
      case "conversations.list": {
        const kinds = typesOf(params.types ?? "public_channel");
        const all = [...this.#conversations.values()].filter(
          (c) => kinds.has(c.kind) && this.#canSee(c) && !(params.exclude_archived === "true" && c.archived),
        );
        const { page, next } = this.#page(all, params);
        return ok({ channels: page.map((c) => this.#describe(c, true)), response_metadata: { next_cursor: next } });
      }
      case "users.conversations": {
        const kinds = typesOf(params.types ?? "public_channel");
        const mine = [...this.#conversations.values()].filter(
          (c) => kinds.has(c.kind) && c.members.has(BOT.userId) && !(params.exclude_archived === "true" && c.archived),
        );
        const { page, next } = this.#page(mine, params);
        // Slack leaves is_member out here: every one of them is yours.
        return ok({ channels: page.map((c) => this.#describe(c, false)), response_metadata: { next_cursor: next } });
      }
      case "conversations.history": {
        const conversation = this.#visible(params.channel);
        if (!conversation) return fail("channel_not_found");
        if (!this.#scopes.has(HISTORY_SCOPE[conversation.kind])) return fail("missing_scope", { needed: HISTORY_SCOPE[conversation.kind] });
        if (!conversation.members.has(BOT.userId)) return fail("not_in_channel");
        // Newest first, and only the channel itself: replies stay in their threads.
        const shown = conversation.messages.filter((m) => !m.thread_ts || m.thread_ts === m.ts || m.subtype === "thread_broadcast").reverse();
        const limit = Number(params.limit) || 100;
        return ok({ messages: shown.slice(0, limit), has_more: shown.length > limit });
      }
      case "chat.postMessage": {
        const conversation = this.#visible(params.channel);
        if (!conversation) return fail("channel_not_found");
        if (!conversation.members.has(BOT.userId)) return fail("not_in_channel");
        if (conversation.archived) return fail("is_archived");
        if (!params.text) return fail("no_text");
        const broadcast = params.reply_broadcast === "true" && params.thread_ts;
        const message = this.post({
          channel: conversation.id,
          user: BOT.userId,
          bot_id: BOT.botId,
          text: params.text,
          ...(params.thread_ts ? { thread_ts: params.thread_ts } : {}),
          ...(broadcast ? { subtype: "thread_broadcast" } : {}),
        });
        this.posted.push(message);
        return ok({ channel: conversation.id, ts: message.ts, message });
      }
      case "reactions.add": {
        const conversation = this.#visible(params.channel);
        if (!conversation) return fail("channel_not_found");
        if (!conversation.members.has(BOT.userId)) return fail("not_in_channel");
        const ts = params.timestamp ?? "";
        if (!conversation.messages.some((m) => m.ts === ts)) return fail("message_not_found");
        const added = conversation.reactions.get(ts) ?? [];
        if (added.includes(params.name ?? "")) return fail("already_reacted");
        conversation.reactions.set(ts, [...added, params.name ?? ""]);
        return ok({});
      }
      default:
        return fail("unknown_method");
    }
  }

  /** apps.connections.open, which takes the app-level token and hands out a one-time WebSocket address. */
  #open(token: string | undefined): Reply {
    if (!token) return fail("not_authed");
    if (/^xox[bp]-/.test(token)) return fail("not_allowed_token_type");
    if (token !== APP_TOKEN) return fail("invalid_auth");
    if (this.#appTokenRevoked) return fail("token_revoked");
    if (!this.#appTokenCanConnect) return fail("missing_scope", { needed: "connections:write" });
    const ticket = `ticket-${++this.#seq}`;
    this.#tickets.add(ticket);
    return ok({ url: `${this.url.replace(/^http/, "ws")}/link/?ticket=${ticket}&app_id=${BOT.appId}` });
  }

  /** oauth.v2.access: trade a one-time code for the workspace's bot token. */
  #install(params: Record<string, string>): Reply {
    if (params.client_id !== CLIENT.id) return fail("invalid_client_id");
    if (params.client_secret !== CLIENT.secret) return fail("bad_client_secret");
    const code = params.code ?? "";
    if (!this.#codes.has(code)) return fail("invalid_code");
    const redirectUri = this.#codes.get(code);
    this.#codes.delete(code);
    if (redirectUri !== undefined && params.redirect_uri !== redirectUri) return fail("bad_redirect_uri");
    return ok({
      access_token: BOT_TOKEN,
      token_type: "bot",
      scope: [...this.#scopes].join(","),
      bot_user_id: BOT.userId,
      app_id: BOT.appId,
      team: { id: TEAM.id, name: TEAM.name },
      enterprise: null,
      is_enterprise_install: false,
      authed_user: { id: ANN },
    });
  }

  /** Public channels, and private ones and DMs the app is in. */
  #canSee(conversation: Conversation): boolean {
    return conversation.kind === "channel" || conversation.members.has(BOT.userId);
  }

  #visible(id: string | undefined): Conversation | undefined {
    const conversation = this.#conversations.get(id ?? "");
    return conversation && this.#canSee(conversation) ? conversation : undefined;
  }

  #describe(conversation: Conversation, withMember: boolean): ApiConversation {
    const { kind } = conversation;
    return {
      id: conversation.id,
      ...(conversation.name ? { name: conversation.name } : {}),
      is_channel: kind === "channel",
      is_group: kind === "private",
      is_im: kind === "dm",
      is_mpim: kind === "group-dm",
      is_private: kind !== "channel",
      is_archived: conversation.archived,
      ...(withMember && (kind === "channel" || kind === "private") ? { is_member: conversation.members.has(BOT.userId) } : {}),
      ...(conversation.user ? { user: conversation.user } : {}),
    };
  }

  #page<T>(entries: T[], params: Record<string, string>): { page: T[]; next: string } {
    const size = Math.min(Number(params.limit) || 100, this.#options.pageSize ?? 2);
    const start = params.cursor ? Number(Buffer.from(params.cursor, "base64").toString().replace("offset:", "")) : 0;
    const end = start + size;
    return { page: entries.slice(start, end), next: end < entries.length ? Buffer.from(`offset:${end}`).toString("base64") : "" };
  }
}

/** An Events API payload, as Slack sends it over Socket Mode and to a Request URL. */
export function callback(event: Record<string, unknown> & { type: string }, eventId: string, team: string = TEAM.id): EventCallback {
  const payload = {
    type: "event_callback",
    team_id: team,
    event_id: eventId,
    event_time: Math.floor(Date.now() / 1000),
    authorizations: [{ team_id: team, user_id: BOT.userId, is_bot: true }],
    event,
  };
  return payload;
}

function typesOf(types: string): Set<ConversationKind> {
  return new Set(
    types
      .split(",")
      .map((type) => TYPE_OF[type.trim()])
      .filter((kind): kind is ConversationKind => kind !== undefined),
  );
}

function channelType(kind: ConversationKind): NonNullable<SlackMessageEvent["channel_type"]> {
  return kind === "private" ? "group" : kind === "dm" ? "im" : kind === "group-dm" ? "mpim" : "channel";
}

function ok(body: Record<string, unknown>): Reply {
  return reply({ ok: true, ...body });
}

function fail(error: string, extra: Record<string, unknown> = {}): Reply {
  return reply({ ok: false, error, ...extra });
}

function reply(body: unknown, status = 200, headers: Record<string, string> = {}): Reply {
  return { status, body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...headers } };
}

function send(response: ServerResponse, { status, body, headers }: Reply): void {
  response.writeHead(status, headers);
  response.end(body);
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (body += chunk));
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}
