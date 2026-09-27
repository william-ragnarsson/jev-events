import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { WebSocketServer, type WebSocket as ServerSocket } from "ws";

import type { NewConnection } from "jev-events";

import type { ChatMessageEvent, EventSubMessage } from "@jev-events/twitch";

// A fake Twitch on one local port: sign-in under /oauth2, the Helix methods the Twitch package
// calls under /helix, and EventSub over a WebSocket at /eventsub. It keeps real state (tokens,
// moderators, bans, subscriptions) so the source and the actions run their real code paths.
// Creating one points JEV_TWITCH_API_URL at it; close() points it back.

/** The app everyone signs in with. */
export const CLIENT = { id: "fakeclientid0000000000000000000", secret: "fake-client-secret" } as const;

export const STREAMER = { id: "1000", login: "mychannel", name: "MyChannel" } as const;
/** An account that moderates for the streamer. */
export const BOT = { id: "999", login: "jevbot", name: "JevBot" } as const;
export const VIEWER = { id: "42", login: "viewer", name: "Viewer" } as const;
/** A channel no one here moderates. */
export const OTHER = { id: "77", login: "otherchannel", name: "OtherChannel" } as const;

export const ALL_SCOPES = [
  "user:read:chat",
  "user:write:chat",
  "moderator:manage:banned_users",
  "moderator:manage:chat_messages",
  "moderator:manage:warnings",
  "clips:edit",
];

export interface FakeTwitchOptions {
  /** How often, in seconds, an idle connection gets a keepalive. Default 10, as on Twitch. */
  keepalive?: number;
  /** Seconds between device-code polls. Default 0.02, so sign-in tests are quick. */
  interval?: number;
}

export interface Token {
  userId: string;
  scopes: string[];
  /** Epoch milliseconds. */
  expiresAt: number;
  clientId: string;
}

export interface FakeCall {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  token: string | undefined;
}

export interface ChatOptions {
  /** Default: a viewer. */
  from?: { id: string; login: string; name: string };
  /** Default: the streamer's channel. */
  channel?: { id: string; login: string };
  badges?: string[];
  /** A first-time chatter. */
  first?: boolean;
  reply?: { author: string; text: string };
  bits?: number;
  /** Send it with this message ID, such as one sent before. */
  messageId?: string;
  /** EventSub's own message ID, for sending the same notification twice. */
  eventsubId?: string;
}

export interface Ban {
  broadcasterId: string;
  moderatorId: string;
  userId: string;
  duration?: number;
  reason: string;
}

export interface Sent {
  broadcasterId: string;
  senderId: string;
  message: string;
  replyTo?: string;
}

interface Subscription {
  id: string;
  broadcasterId: string;
  userId: string;
  sessionId: string;
  clientId: string;
}

interface Socket {
  socket: ServerSocket;
  sessionId: string;
  keepalive: ReturnType<typeof setInterval> | undefined;
}

interface DeviceCode {
  deviceCode: string;
  userCode: string;
  clientId: string;
  scopes: string[];
  /** Set once someone approves it, as that user. */
  approvedBy?: string;
  denied?: boolean;
  expired?: boolean;
}

interface Reply {
  status: number;
  body: string;
  headers: Record<string, string>;
}

export async function fakeTwitch(options: FakeTwitchOptions = {}): Promise<FakeTwitch> {
  const twitch = new FakeTwitch(options);
  await twitch.listen();
  return twitch;
}

export class FakeTwitch {
  url = "";
  readonly bans: Ban[] = [];
  /** Message IDs moderators deleted. */
  readonly deleted: string[] = [];
  readonly sent: Sent[] = [];
  readonly warnings: Array<{ userId: string; reason: string }> = [];
  readonly clips: string[] = [];
  /** EventSub connections opening and closing, in order: "open 1", "open 2", "close 1". */
  readonly connections: string[] = [];
  /** Refresh tokens that were used, so each works once, as with a Public app. */
  readonly spent = new Set<string>();

  readonly #options: FakeTwitchOptions;
  readonly #server = createServer((request, response) => void this.#handle(request, response));
  readonly #wss = new WebSocketServer({ server: this.#server, path: "/eventsub" });
  readonly #sockets = new Map<ServerSocket, Socket>();
  readonly #calls: FakeCall[] = [];
  readonly #users = new Map<string, { id: string; login: string; display_name: string }>();
  readonly #tokens = new Map<string, Token>();
  /** Refresh token → the user and scopes it renews. */
  readonly #refreshTokens = new Map<string, Token>();
  readonly #devices = new Map<string, DeviceCode>();
  /** OAuth codes handed out, each with its user, scopes and redirect. */
  readonly #codes = new Map<string, { userId: string; scopes: string[]; redirectUri: string }>();
  readonly #subscriptions = new Map<string, Subscription>();
  /** broadcaster ID → moderator user IDs. */
  readonly #moderators = new Map<string, Set<string>>();
  readonly #live = new Set<string>([STREAMER.id]);
  readonly #failures = new Map<string, Array<{ status: number; message: string; headers?: Record<string, string> }>>();
  #seq = 0;
  #sessionCount = 0;
  #silent = false;
  #previousUrl: string | undefined;

  constructor(options: FakeTwitchOptions = {}) {
    this.#options = options;
    this.#wss.on("connection", (socket, request) => this.#connected(socket, request));
    for (const user of [STREAMER, BOT, VIEWER, OTHER]) this.#users.set(user.id, { id: user.id, login: user.login, display_name: user.name });
    this.#moderators.set(STREAMER.id, new Set([BOT.id]));
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.#server.listen(0, "127.0.0.1", resolve));
    const { port } = this.#server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${port}`;
    this.#previousUrl = process.env.JEV_TWITCH_API_URL;
    process.env.JEV_TWITCH_API_URL = this.url;
  }

  async close(): Promise<void> {
    if (this.#previousUrl === undefined) delete process.env.JEV_TWITCH_API_URL;
    else process.env.JEV_TWITCH_API_URL = this.#previousUrl;
    for (const { socket, keepalive } of this.#sockets.values()) {
      clearInterval(keepalive);
      socket.terminate();
    }
    await new Promise<void>((resolve) => this.#wss.close(() => resolve()));
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  /** Tokens for `user`, as a sign-in makes them. `expiresIn` is in seconds. */
  issue(user: { id: string } = BOT, options: { scopes?: string[]; expiresIn?: number; clientId?: string } = {}): { accessToken: string; refreshToken: string; expiresAt: number } {
    const token: Token = {
      userId: user.id,
      scopes: options.scopes ?? ALL_SCOPES,
      expiresAt: Date.now() + (options.expiresIn ?? 14_400) * 1000,
      clientId: options.clientId ?? CLIENT.id,
    };
    const accessToken = `access-${++this.#seq}`;
    const refreshToken = `refresh-${this.#seq}`;
    this.#tokens.set(accessToken, token);
    this.#refreshTokens.set(refreshToken, token);
    return { accessToken, refreshToken, expiresAt: token.expiresAt };
  }

  /** The connection `npx jev-events auth twitch` saves for `user`. */
  connection(user: { id: string; login: string } = BOT, options: { scopes?: string[]; expiresIn?: number; clientSecret?: string } = {}): NewConnection {
    const { accessToken, refreshToken, expiresAt } = this.issue(user, options);
    const scopes = options.scopes ?? ALL_SCOPES;
    return {
      account: user.id,
      label: user.login,
      credentials: {
        clientId: CLIENT.id,
        ...(options.clientSecret ? { clientSecret: options.clientSecret } : {}),
        accessToken,
        refreshToken,
        expiresAt,
      },
      facts: { userId: user.id, login: user.login, scopes },
    };
  }

  /** Every access token of `user` stops working, as when a token expires early. Refresh tokens still work. */
  expireTokens(user: { id: string } = BOT): void {
    for (const [token, owner] of this.#tokens) if (owner.userId === user.id) this.#tokens.delete(token);
  }

  /** The user took back the app's access: every token of theirs stops working, refresh tokens too. */
  revokeTokens(user: { id: string } = BOT): void {
    this.expireTokens(user);
    for (const [token, owner] of this.#refreshTokens) if (owner.userId === user.id) this.#refreshTokens.delete(token);
  }

  /** Twitch ends every subscription of `user` with this status, such as "authorization_revoked". */
  revoke(status: string, user: { id: string } = BOT): void {
    for (const [id, subscription] of this.#subscriptions) {
      if (subscription.userId !== user.id) continue;
      this.#subscriptions.delete(id);
      const socket = this.#bySession(subscription.sessionId);
      socket?.socket.send(
        JSON.stringify(
          this.#message("revocation", {
            subscription: { id, type: "channel.chat.message", version: "1", status, condition: { broadcaster_user_id: subscription.broadcasterId, user_id: subscription.userId } },
          }, "channel.chat.message"),
        ),
      );
    }
  }

  /** Someone chats, sent to every connection subscribed to that channel's chat. Returns the message ID. */
  chat(text: string, options: ChatOptions = {}): string {
    const from = options.from ?? VIEWER;
    const channel = options.channel ?? STREAMER;
    const messageId = options.messageId ?? `msg-${++this.#seq}`;
    const event: ChatMessageEvent = {
      broadcaster_user_id: channel.id,
      broadcaster_user_login: channel.login,
      chatter_user_id: from.id,
      chatter_user_login: from.login,
      chatter_user_name: from.name,
      message_id: messageId,
      message: { text },
      message_type: options.first ? "user_intro" : "text",
      badges: (options.badges ?? []).map((set_id) => ({ set_id })),
      cheer: options.bits ? { bits: options.bits } : null,
      reply: options.reply ? { parent_user_name: options.reply.author, parent_message_body: options.reply.text } : null,
    };
    for (const [id, subscription] of this.#subscriptions) {
      if (subscription.broadcasterId !== channel.id) continue;
      const socket = this.#bySession(subscription.sessionId);
      const message = this.#message("notification", { subscription: { id, type: "channel.chat.message", version: "1", status: "enabled" }, event }, "channel.chat.message");
      if (options.eventsubId) message.metadata.message_id = options.eventsubId;
      socket?.socket.send(JSON.stringify(message));
    }
    return messageId;
  }

  /** Ask every connection to move, the way Twitch does before maintenance. The old ones close once the new ones are welcomed. */
  reconnect(): void {
    for (const { socket, sessionId } of this.#sockets.values()) {
      socket.send(
        JSON.stringify(
          this.#message("session_reconnect", {
            session: {
              id: sessionId,
              status: "reconnecting",
              keepalive_timeout_seconds: null,
              reconnect_url: `${this.url.replace(/^http/, "ws")}/eventsub?reconnect=${sessionId}`,
              connected_at: new Date().toISOString(),
            },
          }),
        ),
      );
    }
  }

  /** Cut every connection without warning. Their subscriptions go too, as on Twitch. */
  drop(): void {
    for (const { socket } of this.#sockets.values()) socket.terminate();
  }

  /** Stop sending keepalives (and welcomes, to new connections), like a connection that died without closing. */
  silence(): void {
    this.#silent = true;
    for (const entry of this.#sockets.values()) clearInterval(entry.keepalive);
  }

  /** Back to normal after `silence()`. */
  speak(): void {
    this.#silent = false;
  }

  /** Open EventSub connections. */
  get sockets(): number {
    return this.#sockets.size;
  }

  /** Chat subscriptions that are live. */
  get subscriptions(): number {
    return this.#subscriptions.size;
  }

  /** Make `user` a moderator in `channel`, or stop it being one. */
  mod(user: { id: string }, channel: { id: string } = STREAMER, on = true): void {
    const moderators = this.#moderators.get(channel.id) ?? new Set();
    if (on) moderators.add(user.id);
    else moderators.delete(user.id);
    this.#moderators.set(channel.id, moderators);
  }

  /** The channel is live, or offline, for clips. */
  live(channel: { id: string } = STREAMER, on = true): void {
    if (on) this.#live.add(channel.id);
    else this.#live.delete(channel.id);
  }

  /** The next call (or `times` calls) to `path`, such as "/helix/eventsub/subscriptions", fails like this. */
  fail(path: string, status: number, message: string, options: { times?: number; headers?: Record<string, string> } = {}): void {
    const list = this.#failures.get(path) ?? [];
    for (let i = 0; i < (options.times ?? 1); i++) list.push({ status, message, ...(options.headers ? { headers: options.headers } : {}) });
    this.#failures.set(path, list);
  }

  /** Calls made, in order, optionally only to one path such as "/helix/moderation/bans". */
  calls(path?: string): FakeCall[] {
    return path ? this.#calls.filter((call) => call.path === path) : [...this.#calls];
  }

  /** Someone approves the device code on twitch.tv/activate, as `user`. */
  approve(userCode: string, user: { id: string } = BOT): void {
    const device = [...this.#devices.values()].find((entry) => entry.userCode === userCode);
    if (!device) throw new Error(`The fake Twitch has no device code ${userCode}.`);
    device.approvedBy = user.id;
  }

  /** Someone clicks Decline on the device code. */
  deny(userCode: string): void {
    const device = [...this.#devices.values()].find((entry) => entry.userCode === userCode);
    if (!device) throw new Error(`The fake Twitch has no device code ${userCode}.`);
    device.denied = true;
  }

  /** The device code runs out before anyone approves it. */
  expire(userCode: string): void {
    const device = [...this.#devices.values()].find((entry) => entry.userCode === userCode);
    if (!device) throw new Error(`The fake Twitch has no device code ${userCode}.`);
    device.expired = true;
  }

  /** A one-time code, as in Twitch's redirect after someone clicks Authorize. */
  code(redirectUri: string, user: { id: string } = BOT, scopes: string[] = ALL_SCOPES): string {
    const code = `code-${++this.#seq}`;
    this.#codes.set(code, { userId: user.id, scopes, redirectUri });
    return code;
  }

  #bySession(sessionId: string): Socket | undefined {
    return [...this.#sockets.values()].find((entry) => entry.sessionId === sessionId);
  }

  #message(type: string, payload: Record<string, unknown>, subscriptionType?: string): EventSubMessage {
    return {
      metadata: {
        message_id: `eventsub-${++this.#seq}`,
        message_type: type,
        message_timestamp: new Date().toISOString(),
        ...(subscriptionType ? { subscription_type: subscriptionType, subscription_version: "1" } : {}),
      },
      payload,
    } as EventSubMessage;
  }

  #connected(socket: ServerSocket, request: IncomingMessage): void {
    const moving = new URL(request.url ?? "/", this.url).searchParams.get("reconnect");
    const number = ++this.#sessionCount;
    const sessionId = `session-${number}`;
    const entry: Socket = { socket, sessionId, keepalive: undefined };
    this.#sockets.set(socket, entry);
    this.connections.push(`open ${number}`);
    socket.on("message", () => socket.close(4001, "client sent inbound traffic"));
    socket.on("close", () => {
      clearInterval(entry.keepalive);
      this.#sockets.delete(socket);
      this.connections.push(`close ${number}`);
      // A connection's subscriptions end with it, unless they moved to a new one.
      for (const [id, subscription] of this.#subscriptions) if (subscription.sessionId === sessionId) this.#subscriptions.delete(id);
    });
    if (this.#silent) return;
    // Moving keeps the subscriptions: they now go to the new connection.
    if (moving) for (const subscription of this.#subscriptions.values()) if (subscription.sessionId === moving) subscription.sessionId = sessionId;
    const keepalive = this.#options.keepalive ?? 10;
    socket.send(
      JSON.stringify(
        this.#message("session_welcome", {
          session: { id: sessionId, status: "connected", keepalive_timeout_seconds: keepalive, reconnect_url: null, connected_at: new Date().toISOString() },
        }),
      ),
    );
    entry.keepalive = setInterval(() => {
      if (!this.#silent) socket.send(JSON.stringify(this.#message("session_keepalive", {})));
    }, keepalive * 1000 * 0.8);
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const raw = await readBody(request);
    const url = new URL(request.url ?? "/", this.url);
    const path = url.pathname;
    const query = Object.fromEntries(url.searchParams);
    const form = (request.headers["content-type"] ?? "").includes("json") ? undefined : Object.fromEntries(new URLSearchParams(raw));
    const body = form ?? (raw ? (JSON.parse(raw) as unknown) : undefined);
    const token = /^(?:Bearer|OAuth) (.+)$/.exec(request.headers.authorization ?? "")?.[1];
    this.#calls.push({ method: request.method ?? "GET", path, query, body, token });
    const failure = this.#failures.get(path)?.shift();
    if (failure) {
      send(response, reply({ error: "Error", status: failure.status, message: failure.message }, failure.status, failure.headers));
      return;
    }
    send(response, this.#route(request.method ?? "GET", path, query, body, token, request.headers["client-id"]));
  }

  #route(method: string, path: string, query: Record<string, string>, body: unknown, token: string | undefined, clientId: string | string[] | undefined): Reply {
    if (path.startsWith("/oauth2/")) return this.#oauth(path.slice("/oauth2/".length), (body ?? {}) as Record<string, string>, token);
    if (!path.startsWith("/helix/")) return reply({ message: "Not found" }, 404);
    if (!clientId) return error(401, "Client-Id header required");
    const owner = token ? this.#tokens.get(token) : undefined;
    if (!owner || owner.expiresAt < Date.now()) return error(401, "Invalid OAuth token");
    if (owner.clientId !== clientId) return error(401, "Client ID and OAuth token do not match");
    const need = (scope: string) => (owner.scopes.includes(scope) ? undefined : error(401, `Missing scope: ${scope}`));
    const data = ((body ?? {}) as { data?: Record<string, unknown> }).data ?? {};
    const moderates = (broadcasterId: string | undefined) =>
      broadcasterId === owner.userId || this.#moderators.get(broadcasterId ?? "")?.has(owner.userId) === true;

    switch (`${method} ${path.slice("/helix".length)}`) {
      case "GET /users": {
        const logins = query.login ? [query.login] : [];
        const users = logins.length ? [...this.#users.values()].filter((user) => logins.includes(user.login)) : [this.#users.get(owner.userId)];
        return reply({ data: users.filter(Boolean) });
      }
      case "POST /eventsub/subscriptions": {
        const request = body as { type: string; version: string; condition: { broadcaster_user_id: string; user_id: string }; transport: { method: string; session_id: string } };
        if (request.type !== "channel.chat.message" || request.version !== "1") return error(400, "unknown subscription type");
        if (request.condition.user_id !== owner.userId) return error(403, "user_id must match the token's user");
        const missing = need("user:read:chat");
        if (missing) return missing;
        const socket = this.#bySession(request.transport.session_id);
        if (!socket) return error(400, "websocket transport session does not exist or has already disconnected");
        const mine = [...this.#subscriptions.values()].filter((entry) => entry.userId === owner.userId && entry.clientId === owner.clientId);
        const duplicate = mine.some(
          (entry) => entry.broadcasterId === request.condition.broadcaster_user_id && entry.sessionId === request.transport.session_id,
        );
        if (duplicate) return error(409, "subscription already exists");
        if (new Set(mine.map((entry) => entry.sessionId)).size >= 3 && !mine.some((entry) => entry.sessionId === request.transport.session_id)) {
          return error(429, "websocket transports limit exceeded");
        }
        const id = `sub-${++this.#seq}`;
        this.#subscriptions.set(id, {
          id,
          broadcasterId: request.condition.broadcaster_user_id,
          userId: owner.userId,
          sessionId: request.transport.session_id,
          clientId: owner.clientId,
        });
        return reply({ data: [{ id, status: "enabled", type: request.type, version: "1", condition: request.condition }], total: 1, total_cost: 0, max_total_cost: 10 }, 202);
      }
      case "POST /moderation/bans": {
        const missing = need("moderator:manage:banned_users");
        if (missing) return missing;
        if (query.moderator_id !== owner.userId) return error(403, "The ID in moderator_id must match the user ID in the access token.");
        if (!moderates(query.broadcaster_id)) return error(403, "The user in moderator_id is not one of the broadcaster's moderators.");
        const userId = String(data.user_id ?? "");
        if (this.bans.some((ban) => ban.broadcasterId === query.broadcaster_id && ban.userId === userId && ban.duration === undefined)) {
          return error(400, "The user specified in the user_id field is already banned.");
        }
        if (userId === query.broadcaster_id || this.#moderators.get(query.broadcaster_id ?? "")?.has(userId)) {
          return error(400, "The user specified in the user_id field may not be banned.");
        }
        const reason = String(data.reason ?? "");
        if ([...reason].length > 500) return error(400, "The text in the reason field is too long.");
        const duration = data.duration === undefined ? undefined : Number(data.duration);
        this.bans.push({ broadcasterId: query.broadcaster_id ?? "", moderatorId: owner.userId, userId, ...(duration === undefined ? {} : { duration }), reason });
        return reply({ data: [{ broadcaster_id: query.broadcaster_id, moderator_id: owner.userId, user_id: userId, created_at: new Date().toISOString(), end_time: null }] });
      }
      case "DELETE /moderation/chat": {
        const missing = need("moderator:manage:chat_messages");
        if (missing) return missing;
        if (!moderates(query.broadcaster_id)) return error(403, "The user in moderator_id is not one of the broadcaster's moderators.");
        if (!query.message_id || this.deleted.includes(query.message_id)) return error(404, "The ID in message_id was not found.");
        this.deleted.push(query.message_id);
        return { status: 204, body: "", headers: {} };
      }
      case "POST /moderation/warnings": {
        const missing = need("moderator:manage:warnings");
        if (missing) return missing;
        if (!moderates(query.broadcaster_id)) return error(403, "The user in moderator_id is not one of the broadcaster's moderators.");
        const warning = { userId: String(data.user_id ?? ""), reason: String(data.reason ?? "") };
        this.warnings.push(warning);
        return reply({ data: [{ broadcaster_id: query.broadcaster_id, user_id: warning.userId, moderator_id: owner.userId, reason: warning.reason }] });
      }
      case "POST /chat/messages": {
        const missing = need("user:write:chat");
        if (missing) return missing;
        const message = body as { broadcaster_id: string; sender_id: string; message: string; reply_parent_message_id?: string };
        if (message.sender_id !== owner.userId) return error(403, "The sender must be the user in the access token.");
        if ([...message.message].length > 500) {
          return reply({ data: [{ message_id: "", is_sent: false, drop_reason: { code: "msg_too_long", message: "Your message is too long." } }] });
        }
        if (this.bans.some((ban) => ban.broadcasterId === message.broadcaster_id && ban.userId === owner.userId)) {
          return reply({ data: [{ message_id: "", is_sent: false, drop_reason: { code: "user_banned", message: "You are banned from this channel." } }] });
        }
        this.sent.push({
          broadcasterId: message.broadcaster_id,
          senderId: message.sender_id,
          message: message.message,
          ...(message.reply_parent_message_id ? { replyTo: message.reply_parent_message_id } : {}),
        });
        const sender = this.#users.get(owner.userId);
        const channel = this.#users.get(message.broadcaster_id);
        // Chat sees it too, the way Twitch sends your own messages back over EventSub.
        const messageId = sender && channel ? this.chat(message.message, { from: { id: sender.id, login: sender.login, name: sender.display_name }, channel }) : "";
        return reply({ data: [{ message_id: messageId, is_sent: true, drop_reason: null }] });
      }
      case "POST /clips": {
        const missing = need("clips:edit");
        if (missing) return missing;
        if (!this.#live.has(query.broadcaster_id ?? "")) return error(404, "Clipping is not possible for an offline channel.");
        const id = `Clip${++this.#seq}`;
        this.clips.push(id);
        return reply({ data: [{ id, edit_url: `https://clips.twitch.tv/${id}/edit` }] }, 202);
      }
      default:
        return error(404, "Not Found");
    }
  }

  #oauth(path: string, params: Record<string, string>, token: string | undefined): Reply {
    switch (path) {
      case "validate": {
        const owner = token ? this.#tokens.get(token) : undefined;
        if (!owner || owner.expiresAt < Date.now()) return reply({ status: 401, message: "invalid access token" }, 401);
        const user = this.#users.get(owner.userId);
        return reply({
          client_id: owner.clientId,
          login: user?.login,
          scopes: owner.scopes,
          user_id: owner.userId,
          expires_in: Math.round((owner.expiresAt - Date.now()) / 1000),
        });
      }
      case "device": {
        if (params.client_id !== CLIENT.id) return reply({ status: 400, message: "invalid client" }, 400);
        const deviceCode = `device-${++this.#seq}`;
        const userCode = `CODE${this.#seq}`;
        this.#devices.set(deviceCode, { deviceCode, userCode, clientId: params.client_id, scopes: (params.scopes ?? "").split(" ").filter(Boolean) });
        return reply({
          device_code: deviceCode,
          expires_in: 1800,
          interval: this.#options.interval ?? 0.02,
          user_code: userCode,
          verification_uri: `https://www.twitch.tv/activate?device-code=${userCode}`,
        });
      }
      case "token":
        return this.#token(params);
      default:
        return reply({ status: 404, message: "Not found" }, 404);
    }
  }

  #token(params: Record<string, string>): Reply {
    if (params.client_id !== CLIENT.id) return reply({ status: 400, message: "invalid client" }, 400);
    if (params.client_secret !== undefined && params.client_secret !== CLIENT.secret) return reply({ status: 403, message: "invalid client secret" }, 403);
    const issued = (userId: string, scopes: string[]) => {
      const tokens = this.issue({ id: userId }, { scopes });
      return reply({ access_token: tokens.accessToken, expires_in: 14_400, refresh_token: tokens.refreshToken, scope: scopes, token_type: "bearer" });
    };
    switch (params.grant_type) {
      case "urn:ietf:params:oauth:grant-type:device_code": {
        const device = this.#devices.get(params.device_code ?? "");
        if (!device || device.expired) return reply({ status: 400, message: "invalid device code" }, 400);
        if (device.denied) return reply({ status: 400, message: "authorization_denied" }, 400);
        if (!device.approvedBy) return reply({ status: 400, message: "authorization_pending" }, 400);
        this.#devices.delete(device.deviceCode);
        return issued(device.approvedBy, device.scopes);
      }
      case "authorization_code": {
        if (params.client_secret !== CLIENT.secret) return reply({ status: 403, message: "invalid client secret" }, 403);
        const code = this.#codes.get(params.code ?? "");
        if (!code) return reply({ status: 400, message: "Invalid authorization code" }, 400);
        this.#codes.delete(params.code ?? "");
        if (params.redirect_uri !== code.redirectUri) return reply({ status: 400, message: "Parameter redirect_uri does not match registered URI" }, 400);
        return issued(code.userId, code.scopes);
      }
      case "refresh_token": {
        const refreshToken = params.refresh_token ?? "";
        const owner = this.#refreshTokens.get(refreshToken);
        if (!owner || this.spent.has(refreshToken)) return reply({ status: 400, message: "Invalid refresh token" }, 400);
        // A Public app's refresh token works once; renewing hands out a new one.
        this.spent.add(refreshToken);
        this.#refreshTokens.delete(refreshToken);
        return issued(owner.userId, owner.scopes);
      }
      default:
        return reply({ status: 400, message: "unsupported grant type" }, 400);
    }
  }
}

function error(status: number, message: string): Reply {
  const names: Record<number, string> = { 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 409: "Conflict", 429: "Too Many Requests" };
  return reply({ error: names[status] ?? "Error", status, message }, status);
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
