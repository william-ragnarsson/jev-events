import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { PERSONAL_TENANT, type ChatMessage, type GraphChat, type GraphEvent, type MicrosoftTokens, type OutlookMessage } from "@jev-events/microsoft";
import type { NewConnection } from "jev-events";

// A fake Microsoft on one local port: Graph (Outlook mail, Outlook Calendar, Teams chats) and the
// Microsoft sign-in endpoints, the way the Microsoft package calls them. It keeps real state (folders,
// delta links, recurring series, chats) and enforces the query rules Graph enforces, so the sources and
// actions run their real code paths. Creating one points JEV_MICROSOFT_API_URL at it; close() points it back.

export interface FakeRequest {
  method: string;
  api: "graph" | "login";
  /** Relative to the API and decoded, such as "/me/messages/AAMk-1=/move". Sign-in paths are "/authorize", "/token" and "/devicecode". */
  path: string;
  query: Record<string, string>;
  body: unknown;
  /** The bearer token sent, if any. */
  token: string | undefined;
  /** The Prefer header, as sent. */
  prefer: string | undefined;
  /** The tenant in a sign-in URL, such as "common". */
  tenant?: string;
}

export interface FailOptions {
  /** The response body. Default: what Microsoft sends for that status. */
  body?: unknown;
  /** How many requests get this response. Default 1. */
  times?: number;
  /** Default `{ "Retry-After": "0" }`, so retries don't wait. */
  headers?: Record<string, string>;
  /** Runs when the response is served, e.g. to change state in between. */
  run?: () => void;
}

export interface FakeMicrosoftOptions {
  /** The signed-in address. Default "me@acme.com". */
  me?: string;
  /** Default "Me Myself". */
  name?: string;
  /** Default "user-me". */
  userId?: string;
  /** Default "tenant-acme". */
  tenantId?: string;
  /** A personal account (outlook.com): no Teams, and no `mail` on the profile. */
  personal?: boolean;
  /** The app registration's Application (client) ID. */
  clientId?: string;
  /** Set for a web app's client. Without one the app is a public client, as the CLI's is. */
  clientSecret?: string;
  /** Most calendar events per delta page. Default 2, so paging is always exercised. */
  pageSize?: number;
}

export interface FakeMail {
  /** "Ann Lee <ann@example.com>" or just the address. */
  from: string;
  /** Default: you. */
  to?: string[];
  cc?: string[];
  replyTo?: string[];
  sender?: string;
  subject?: string;
  text?: string;
  html?: string;
  /** The new part of the body, without quoted replies. Default: the body. */
  unique?: string;
  headers?: Record<string, string>;
  attachments?: Array<{ name: string; contentType?: string; size?: number; inline?: boolean }>;
  /** A folder id or well-known name. Default "inbox". */
  folder?: string;
  isRead?: boolean;
  isDraft?: boolean;
  importance?: "low" | "normal" | "high";
  categories?: string[];
  flagged?: boolean;
  /** False puts it under "Other". */
  focused?: boolean;
  conversationId?: string;
  /** Epoch milliseconds. Default now. */
  receivedAt?: number;
}

export type FakeResponse = "none" | "organizer" | "tentativelyAccepted" | "accepted" | "declined" | "notResponded";

export interface FakeEventInput {
  id?: string;
  subject?: string;
  /** Plain text. */
  body?: string;
  /** Epoch milliseconds. Default two hours from now. */
  start?: number;
  /** Default half an hour after the start, or a day for an all-day event. */
  end?: number;
  /** All-day events start at midnight UTC. */
  isAllDay?: boolean;
  location?: string;
  /** "Name <address>". Default: you. */
  organizer?: string;
  attendees?: Array<string | { address: string; name?: string; response?: FakeResponse; type?: "required" | "optional" | "resource" }>;
  /** Your answer, when someone else organized it. Default "notResponded". */
  response?: FakeResponse;
  responseRequested?: boolean;
  showAs?: "free" | "tentative" | "busy" | "oof" | "workingElsewhere" | "unknown";
  joinUrl?: string;
  repeat?: { every: "day" | "week"; interval?: number; count?: number };
  /** Epoch milliseconds. Default now. */
  createdAt?: number;
}

export interface FakePerson {
  name: string;
  email?: string;
  /** Default: made from the name. */
  id?: string;
  /** Default: your tenant. Another one makes them someone from another company. */
  tenantId?: string;
  guest?: boolean;
}

export interface FakeSay {
  from: FakePerson | "me" | { app: string };
  text?: string;
  html?: string;
  mentions?: Array<FakePerson | "me">;
  everyone?: boolean;
  importance?: "normal" | "high" | "urgent";
  /** File names, shared as links. */
  files?: string[];
  /** The id of the message this one quotes. */
  quote?: string;
  /** Default "message". Others, like "systemEventMessage", aren't someone talking. */
  messageType?: string;
  /** Epoch milliseconds. Default now. */
  at?: number;
}

export interface DeviceScript {
  /** How many polls answer "authorization_pending" before the user approves. */
  pending?: number;
  decline?: boolean;
  expire?: boolean;
  invalidScope?: boolean;
}

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

interface Folder {
  id: string;
  displayName: string;
  parentId: string;
  wellKnown?: string;
}

interface StoredMail extends FakeMail {
  id: string;
  folderId: string;
  receivedAt: number;
  order: number;
}

interface Address {
  name: string;
  address: string;
}

interface StoredEvent {
  id: string;
  subject: string;
  body: string;
  start: number;
  end: number;
  isAllDay: boolean;
  location: string | undefined;
  organizer: Address;
  attendees: Array<Address & { response: FakeResponse; type: "required" | "optional" | "resource" }>;
  myResponse: FakeResponse;
  responseRequested: boolean;
  showAs: FakeEventInput["showAs"];
  joinUrl: string | undefined;
  repeat: { every: "day" | "week"; interval: number; count: number } | undefined;
  createdAt: number;
  modifiedAt: number;
  changedAt: number;
  isCancelled: boolean;
  exceptions: Map<number, { changes: Partial<Pick<FakeEventInput, "subject" | "start" | "end" | "location">> & { isCancelled?: boolean }; changedAt: number; modifiedAt: number }>;
  removed: Map<number, number>;
}

interface Instance {
  event: StoredEvent;
  /** -1 for an event that doesn't repeat. */
  index: number;
  id: string;
  start: number;
  end: number;
  subject: string;
  location: string | undefined;
  isCancelled: boolean;
  exception: { changedAt: number; modifiedAt: number } | undefined;
}

interface StoredPerson {
  id: string;
  name: string;
  email: string | undefined;
  tenantId: string;
  guest: boolean;
}

interface StoredChat {
  id: string;
  topic: string | undefined;
  type: "oneOnOne" | "group" | "meeting";
  members: StoredPerson[];
  createdAt: number;
}

interface StoredChatMessage {
  id: string;
  chatId: string;
  messageType: string;
  createdAt: number;
  modifiedAt: number;
  editedAt: number | undefined;
  deletedAt: number | undefined;
  from: { user: StoredPerson } | { app: { id: string; name: string } };
  html: string;
  importance: "normal" | "high" | "urgent";
  mentions: NonNullable<ChatMessage["mentions"]>;
  attachments: NonNullable<ChatMessage["attachments"]>;
  reactions: Array<{ reactionType: string; userId: string; at: number }>;
}

const DAY_MS = 24 * 60 * 60_000;
const MAIL_SCOPE = "Mail.ReadWrite";
const CALENDAR_SCOPE = "Calendars.ReadWrite";
const CHAT_SCOPE = "Chat.ReadWrite";
const TEXT_BODIES = 'outlook.body-content-type="text"';

export async function fakeMicrosoft(options: FakeMicrosoftOptions = {}): Promise<FakeMicrosoft> {
  const microsoft = new FakeMicrosoft(options);
  await microsoft.listen();
  return microsoft;
}

export class FakeMicrosoft {
  url = "";
  readonly me: string;
  readonly name: string;
  readonly userId: string;
  readonly tenantId: string;
  readonly personal: boolean;
  readonly clientId: string;
  readonly clientSecret: string | undefined;
  readonly requests: FakeRequest[] = [];
  /** Replies saved as drafts with createReply. */
  readonly drafts: Array<{ replyTo: string; comment: string }> = [];
  /** Invites answered with accept, decline or tentativelyAccept. */
  readonly rsvps: Array<{ id: string; response: FakeResponse; comment: string | undefined; sendResponse: unknown }> = [];

  readonly #server = createServer((request, response) => void this.#handle(request, response));
  readonly #pageSize: number;
  #previousUrl: string | undefined;
  #overrides: Override[] = [];
  #lastNow = 0;
  #counter = 0;

  constructor(options: FakeMicrosoftOptions = {}) {
    this.me = options.me ?? "me@acme.com";
    this.name = options.name ?? "Me Myself";
    this.userId = options.userId ?? "user-me";
    this.tenantId = options.tenantId ?? "tenant-acme";
    this.personal = options.personal ?? false;
    this.clientId = options.clientId ?? "11111111-2222-3333-4444-555555555555";
    this.clientSecret = options.clientSecret || undefined;
    this.#pageSize = options.pageSize ?? 2;
    this.#refreshTokens.set("refresh-1", this.#grantable);
    for (const [wellKnown, displayName] of [
      ["inbox", "Inbox"],
      ["archive", "Archive"],
      ["deleteditems", "Deleted Items"],
      ["drafts", "Drafts"],
      ["sentitems", "Sent Items"],
      ["junkemail", "Junk Email"],
    ] as const) {
      this.#folders.push({ id: `AAMkFolder${++this.#counter}=`, displayName, parentId: "root", wellKnown });
    }
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.#server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
    this.#previousUrl = process.env.JEV_MICROSOFT_API_URL;
    process.env.JEV_MICROSOFT_API_URL = this.url;
  }

  async close(): Promise<void> {
    if (this.#previousUrl === undefined) delete process.env.JEV_MICROSOFT_API_URL;
    else process.env.JEV_MICROSOFT_API_URL = this.#previousUrl;
    await new Promise<void>((resolve) => {
      this.#server.close(() => resolve());
      this.#server.closeAllConnections();
    });
  }

  /** Requests to one route, such as "POST /me/messages/AAMk-1=/move" or "POST /token", or all of them. */
  calls(route?: string | RegExp): FakeRequest[] {
    return route === undefined ? this.requests : this.requests.filter((r) => matches(route, `${r.method} ${r.path}`));
  }

  /** Answer the next request(s) to `route` ("METHOD /path", decoded, no query) with `status` instead. */
  fail(route: string | RegExp, status: number, options: FailOptions = {}): void {
    this.#overrides.push({ route, status, times: options.times ?? 1, options });
  }

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
      path: `/${route.parts.join("/")}`,
      query: Object.fromEntries(url.searchParams),
      body: parseBody(text, incoming.headers["content-type"]),
      token: /^Bearer (.+)$/.exec(incoming.headers.authorization ?? "")?.[1],
      prefer: typeof incoming.headers.prefer === "string" ? incoming.headers.prefer : undefined,
      ...(route.tenant === undefined ? {} : { tenant: route.tenant }),
    };
    this.requests.push(request);

    const override = this.#overrides.find((o) => o.times > 0 && matches(o.route, `${request.method} ${request.path}`));
    if (override) {
      override.times--;
      override.options.run?.();
      return send(response, {
        status: override.status,
        body: override.options.body ?? (route.api === "login" ? loginError("temporarily_unavailable", "AADSTS90033: A transient error has occurred. Please try again.") : graphErrorFor(override.status)),
        headers: override.options.headers ?? { "Retry-After": "0" },
      });
    }
    try {
      if (route.api === "login") return send(response, this.#login(request));
      const scopes = request.token === undefined ? undefined : this.#accessTokens.get(request.token);
      if (!scopes) {
        return send(response, {
          status: 401,
          body: graphErrorFor(401),
          headers: { "WWW-Authenticate": 'Bearer realm="", authorization_uri="https://login.microsoftonline.com/common/oauth2/authorize"' },
        });
      }
      const needs = scopeFor(route.parts);
      if (needs && !scopes.includes(needs)) return send(response, missingScope(needs, scopes));
      send(response, this.#graph(request, route.parts));
    } catch (error) {
      send(response, { status: 500, body: `Fake Microsoft broke: ${(error as Error).stack ?? String(error)}` });
    }
  }

  #graph(r: FakeRequest, parts: string[]): Reply {
    const [first, second] = parts;
    if (first === "me" && parts.length === 1 && r.method === "GET") {
      return ok(select({ id: this.userId, displayName: this.name, mail: this.personal ? null : this.me, userPrincipalName: this.me }, r.query.$select));
    }
    if (first === "me" && (second === "mailFolders" || second === "messages")) return this.#mailRoute(r, parts);
    if (first === "me" && (second === "calendarView" || second === "events")) return this.#calendar(r, parts);
    if ((first === "me" && second === "chats") || first === "chats") return this.#teams(r, first === "me" ? parts.slice(1) : parts);
    return unknownRoute(r);
  }

  // -------------------------------------------------------------------------------------------------
  // Sign-in

  readonly #accessTokens = new Map<string, string[]>();
  readonly #refreshTokens = new Map<string, string[]>();
  readonly #codes = new Map<string, { redirectUri: string; challenge: string; scopes: string[] }>();
  readonly #devices = new Map<string, { scopes: string[]; polls: number; script: DeviceScript }>();
  #deviceScript: DeviceScript = {};
  #consentScript: { deny?: boolean } = {};
  #accessCount = 0;
  #refreshCount = 1;
  #codeCount = 0;

  /** What the account can grant: everything the package asks for, except Teams on a personal account. */
  get #grantable(): string[] {
    return ["openid", "profile", "email", "User.Read", MAIL_SCOPE, CALENDAR_SCOPE, ...(this.personal ? [] : [CHAT_SCOPE])];
  }

  /** The account as `jev-events auth microsoft` saves it, with a working access token. */
  connection(options: { scopes?: string[] } = {}): NewConnection {
    const scopes = options.scopes ?? this.#grantable;
    const refreshToken = options.scopes ? this.#issueRefresh(scopes) : "refresh-1";
    return {
      account: this.userId,
      label: this.me,
      credentials: {
        clientId: this.clientId,
        ...(this.clientSecret ? { clientSecret: this.clientSecret } : {}),
        accessToken: this.#issueAccess(scopes),
        refreshToken,
        expiresAt: Date.now() + 3_600_000,
        scopes,
      },
      facts: { userId: this.userId, email: this.me, name: this.name, ...(this.personal ? { personal: true } : {}) },
    };
  }

  /** Tokens for `withTokens()`, with a working access token. */
  tokens(): MicrosoftTokens {
    return {
      clientId: this.clientId,
      ...(this.clientSecret ? { clientSecret: this.clientSecret } : {}),
      accessToken: this.#issueAccess(this.#grantable),
      refreshToken: "refresh-1",
      expiresAt: Date.now() + 3_600_000,
      email: this.me,
      scopes: this.#grantable,
    };
  }

  /** Make every access token stop working, as when they expire. Refresh tokens still work. */
  expireAccessTokens(): void {
    this.#accessTokens.clear();
  }

  /** Sign the account out everywhere: every access and refresh token stops working. */
  revoke(): void {
    this.#accessTokens.clear();
    this.#refreshTokens.clear();
  }

  /** How the next device sign-in goes. By default the user approves on the first poll. */
  device(script: DeviceScript): void {
    this.#deviceScript = script;
  }

  /** How the next browser sign-in goes. By default the user clicks Accept. */
  consent(script: { deny?: boolean }): void {
    this.#consentScript = script;
  }

  #login(r: FakeRequest): Reply {
    if (r.path === "/authorize" && r.method === "GET") return this.#authorize(r);
    if (r.method !== "POST") return { status: 405, body: "Method not allowed" };
    const form = (r.body ?? {}) as Record<string, string>;
    if (r.path === "/devicecode") {
      if (form.client_id !== this.clientId) return unknownClient(form.client_id);
      const code = `device-${++this.#codeCount}`;
      const userCode = `CODE${String(this.#codeCount).padStart(5, "0")}`;
      this.#devices.set(code, { scopes: splitScopes(form.scope), polls: 0, script: this.#deviceScript });
      this.#deviceScript = {};
      return ok({
        device_code: code,
        user_code: userCode,
        verification_uri: "https://microsoft.com/devicelogin",
        expires_in: 900,
        interval: 0,
        message: `To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code ${userCode} to authenticate.`,
      });
    }
    if (r.path !== "/token") return { status: 404, body: "Not found" };

    if (form.client_id !== this.clientId) return unknownClient(form.client_id);
    if (!this.clientSecret && form.client_secret) {
      return { status: 401, body: loginError("invalid_client", "AADSTS700025: Client is public so neither 'client_assertion' nor 'client_secret' should be presented.") };
    }
    if (this.clientSecret && !form.client_secret) {
      return { status: 401, body: loginError("invalid_client", "AADSTS7000218: The request body must contain the following parameter: 'client_assertion' or 'client_secret'.") };
    }
    if (this.clientSecret && form.client_secret !== this.clientSecret) {
      return { status: 401, body: loginError("invalid_client", "AADSTS7000215: Invalid client secret provided. Ensure the secret being sent in the request is the client secret value.") };
    }

    if (form.grant_type === "authorization_code") {
      const code = this.#codes.get(form.code ?? "");
      this.#codes.delete(form.code ?? "");
      if (!code) return { status: 400, body: loginError("invalid_grant", "AADSTS70000: The provided authorization code is invalid or has expired.") };
      if (form.redirect_uri !== code.redirectUri) {
        return { status: 400, body: loginError("invalid_grant", "AADSTS50011: The redirect URI specified in the request does not match the one the code was issued for.") };
      }
      if (createHash("sha256").update(form.code_verifier ?? "").digest("base64url") !== code.challenge) {
        return { status: 400, body: loginError("invalid_grant", "AADSTS50148: The code_verifier does not match the code_challenge supplied in the authorization request for PKCE.") };
      }
      return this.#tokenReply(code.scopes);
    }
    if (form.grant_type === "refresh_token") {
      const granted = this.#refreshTokens.get(form.refresh_token ?? "");
      if (!granted) return { status: 400, body: loginError("invalid_grant", "AADSTS70008: The provided authorization code or refresh token has expired due to inactivity.") };
      const asked = form.scope ? splitScopes(form.scope).filter((scope) => scope !== "offline_access") : granted;
      const extra = asked.filter((scope) => !granted.includes(scope));
      if (extra.length > 0) {
        return { status: 400, body: loginError("invalid_grant", `AADSTS65001: The user or administrator has not consented to use the application with ID '${this.clientId}'. Send an interactive authorization request for this user and resource.`) };
      }
      return this.#tokenReply([...asked, "offline_access"]);
    }
    if (form.grant_type === "urn:ietf:params:oauth:grant-type:device_code") {
      const device = this.#devices.get(form.device_code ?? "");
      if (!device) return { status: 400, body: loginError("bad_verification_code", "AADSTS70019: Verification code expired.") };
      const { script } = device;
      if (script.decline) return { status: 400, body: loginError("authorization_declined", "AADSTS70018: The user declined the authorization request.") };
      if (script.expire) return { status: 400, body: loginError("expired_token", "AADSTS70020: The provided value for the input parameter 'device_code' is not valid. This device code has expired.") };
      if (script.invalidScope) {
        return { status: 400, body: loginError("invalid_scope", "AADSTS70011: The provided request must include a 'scope' input parameter. The provided value for the input parameter 'scope' isn't valid.") };
      }
      if ((script.pending ?? 0) > device.polls++) {
        return { status: 400, body: loginError("authorization_pending", "AADSTS70016: Authorization is pending. Continue polling.") };
      }
      this.#devices.delete(form.device_code ?? "");
      return this.#tokenReply(device.scopes);
    }
    return { status: 400, body: loginError("unsupported_grant_type", `AADSTS70003: The app requested an unsupported grant type '${form.grant_type}'.`) };
  }

  #authorize(r: FakeRequest): Reply {
    const { query } = r;
    if (query.client_id !== this.clientId) return { status: 400, body: `AADSTS700016: Application with identifier '${query.client_id}' was not found in the directory.` };
    const redirect = new URL(query.redirect_uri ?? "");
    const { deny } = this.#consentScript;
    this.#consentScript = {};
    if (deny) {
      redirect.searchParams.set("error", "access_denied");
      redirect.searchParams.set("error_description", "AADSTS65004: User declined to consent to access the app.");
    } else {
      const code = `code-${++this.#codeCount}`;
      this.#codes.set(code, { redirectUri: query.redirect_uri ?? "", challenge: query.code_challenge ?? "", scopes: splitScopes(query.scope) });
      redirect.searchParams.set("code", code);
    }
    if (query.state) redirect.searchParams.set("state", query.state);
    return { status: 302, headers: { Location: redirect.toString() } };
  }

  #tokenReply(requested: string[]): Reply {
    const granted = requested.filter((scope) => this.#grantable.includes(scope));
    return ok({
      token_type: "Bearer",
      scope: granted.join(" "),
      expires_in: 3599,
      ext_expires_in: 3599,
      access_token: this.#issueAccess(granted),
      ...(requested.includes("offline_access") ? { refresh_token: this.#issueRefresh(granted) } : {}),
      ...(requested.includes("openid") ? { id_token: this.#idToken() } : {}),
    });
  }

  #issueAccess(scopes: string[]): string {
    const token = `access-${++this.#accessCount}`;
    this.#accessTokens.set(token, [...scopes]);
    return token;
  }

  #issueRefresh(scopes: string[]): string {
    const token = `refresh-${++this.#refreshCount}`;
    this.#refreshTokens.set(token, [...scopes]);
    return token;
  }

  #idToken(): string {
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const tid = this.personal ? PERSONAL_TENANT : this.tenantId;
    const claims = { aud: this.clientId, iss: `https://login.microsoftonline.com/${tid}/v2.0`, tid, oid: this.userId, preferred_username: this.me, name: this.name };
    return `${part({ alg: "RS256", typ: "JWT" })}.${part(claims)}.signature`;
  }

  // -------------------------------------------------------------------------------------------------
  // Outlook mail

  readonly #folders: Folder[] = [];
  readonly #mailbox = new Map<string, StoredMail>();
  readonly #emailed = new Set<string>();
  #mailCount = 0;

  /** A new email arrives. Returns its id. */
  deliver(mail: FakeMail): string {
    const folder = this.#folder(mail.folder ?? "inbox");
    if (!folder) throw new Error(`The fake has no folder ${mail.folder}.`);
    const id = `AAMk-${++this.#mailCount}=`;
    this.#mailbox.set(id, { ...mail, id, folderId: folder.id, receivedAt: mail.receivedAt ?? this.#now(), order: this.#mailCount });
    return id;
  }

  /** You've emailed these addresses before, so they're in Sent Items. */
  emailed(...addresses: string[]): void {
    for (const address of addresses) this.#emailed.add(address.toLowerCase());
  }

  /** Add a folder, at the top or inside another one (an id or well-known name). Returns its id. */
  addFolder(name: string, parent?: string): string {
    const parentId = parent === undefined ? "root" : this.#folder(parent)?.id;
    if (!parentId) throw new Error(`The fake has no folder ${parent}.`);
    const folder = { id: `AAMkFolder${++this.#counter}=`, displayName: name, parentId };
    this.#folders.push(folder);
    return folder.id;
  }

  /** Remove a folder, such as "archive" for a mailbox without one. */
  removeFolder(ref: string): void {
    const folder = this.#folder(ref);
    if (folder) this.#folders.splice(this.#folders.indexOf(folder), 1);
  }

  /** Delete an email for good. */
  remove(id: string): void {
    this.#mailbox.delete(id);
  }

  /** An email as it is now, with the folder it's in as a path such as "Inbox/Receipts". */
  message(id: string): (StoredMail & { folderPath: string }) | undefined {
    const mail = this.#mailbox.get(id);
    return mail && { ...mail, folderPath: this.#folderPath(mail.folderId) };
  }

  /** The folder an email is in, as a path such as "Inbox/Receipts". */
  folderOf(id: string): string | undefined {
    const mail = this.#mailbox.get(id);
    return mail && this.#folderPath(mail.folderId);
  }

  #folder(ref: string): Folder | undefined {
    return this.#folders.find((f) => f.id === ref || f.wellKnown === ref.toLowerCase());
  }

  #folderPath(id: string): string {
    const folder = this.#folders.find((f) => f.id === id);
    if (!folder) return "(deleted folder)";
    return folder.parentId === "root" ? folder.displayName : `${this.#folderPath(folder.parentId)}/${folder.displayName}`;
  }

  /** `parts` is the whole path, such as ["me", "mailFolders", "inbox", "messages"]. */
  #mailRoute(r: FakeRequest, parts: string[]): Reply {
    const [, kind, id, sub] = parts;
    if (kind === "mailFolders") {
      if (id === undefined) return this.#folderList(r, "root");
      const folder = this.#folder(id);
      if (!folder) return graphError(404, "ErrorItemNotFound", "The specified object was not found in the store.");
      if (sub === "childFolders" && parts.length === 4) return this.#folderList(r, folder.id);
      if (sub === "messages" && parts.length === 4 && r.method === "GET") return this.#messageList(r, folder, parts);
      return unknownRoute(r);
    }
    const mail = id === undefined ? undefined : this.#mailbox.get(id);
    if (!mail) return graphError(404, "ErrorItemNotFound", "The specified object was not found in the store.");
    const route = `${r.method} ${sub ?? ""}`;
    const body = (r.body ?? {}) as Record<string, unknown>;
    switch (route) {
      case "GET ":
        return ok(select(this.#messageJson(mail, r.prefer?.includes(TEXT_BODIES) ?? false), r.query.$select));
      case "GET attachments":
        return ok({ value: (mail.attachments ?? []).map((a, i) => select(attachmentJson(a, i), r.query.$select)) });
      case "PATCH ": {
        if (typeof body.isRead === "boolean") mail.isRead = body.isRead;
        const flag = body.flag as { flagStatus?: string } | undefined;
        if (flag?.flagStatus) mail.flagged = flag.flagStatus === "flagged";
        if (Array.isArray(body.categories)) mail.categories = body.categories as string[];
        return ok(this.#messageJson(mail, false));
      }
      case "POST move": {
        const folder = this.#folder(String(body.destinationId ?? ""));
        if (!folder) return graphError(404, "ErrorFolderNotFound", "The specified folder could not be found in the store.");
        mail.folderId = folder.id;
        return { status: 201, body: this.#messageJson(mail, false) };
      }
      case "POST createReply": {
        const comment = String(body.comment ?? "");
        this.drafts.push({ replyTo: mail.id, comment });
        return { status: 201, body: { id: `draft-${this.drafts.length}`, isDraft: true, subject: `RE: ${mail.subject ?? ""}`, bodyPreview: comment.slice(0, 255) } };
      }
      default:
        return unknownRoute(r);
    }
  }

  #folderList(r: FakeRequest, parentId: string): Reply {
    if (r.method === "POST") {
      const name = String((r.body as { displayName?: unknown } | undefined)?.displayName ?? "");
      if (this.#folders.some((f) => f.parentId === parentId && f.displayName.toLowerCase() === name.toLowerCase())) {
        return graphError(409, "ErrorFolderExists", "A folder with the specified name already exists.");
      }
      const folder = { id: `AAMkFolder${++this.#counter}=`, displayName: name, parentId };
      this.#folders.push(folder);
      return { status: 201, body: folderJson(folder) };
    }
    if (r.method !== "GET") return unknownRoute(r);
    let folders = this.#folders.filter((f) => f.parentId === parentId);
    if (r.query.$filter) {
      const match = /^displayName eq '((?:[^']|'')*)'$/.exec(r.query.$filter);
      if (!match) return graphError(400, "ErrorInvalidUrlQuery", `Fake Microsoft doesn't understand $filter=${r.query.$filter}.`);
      const name = (match[1] ?? "").replaceAll("''", "'").toLowerCase();
      folders = folders.filter((f) => f.displayName.toLowerCase() === name);
    }
    const top = Number(r.query.$top ?? 10);
    return ok({ value: folders.slice(0, top).map((f) => select(folderJson(f), r.query.$select)) });
  }

  #messageList(r: FakeRequest, folder: Folder, parts: string[]): Reply {
    const { $search, $filter, $orderby } = r.query;
    let mail = [...this.#mailbox.values()].filter((m) => m.folderId === folder.id);
    if ($search !== undefined) {
      if ($filter !== undefined || $orderby !== undefined) {
        return graphError(400, "ErrorInvalidUrlQuery", "The query parameter '$orderby' is invalid. $search can't be combined with $filter or $orderby.");
      }
      const address = /^"recipients:(.+)"$/.exec($search)?.[1];
      if (!address) return graphError(400, "ErrorInvalidUrlQuery", `Fake Microsoft doesn't understand $search=${$search}.`);
      return ok({ value: this.#emailed.has(address.toLowerCase()) ? [{ id: "sent-1" }] : [] });
    }
    if ($filter !== undefined) {
      const match = /^receivedDateTime (ge|gt) (\S+)$/.exec($filter);
      const from = match ? Date.parse(match[2] ?? "") : Number.NaN;
      if (!match || Number.isNaN(from)) return graphError(400, "ErrorInvalidUrlQuery", `Fake Microsoft doesn't understand $filter=${$filter}.`);
      mail = mail.filter((m) => (match[1] === "ge" ? seconds(m.receivedAt) >= from : seconds(m.receivedAt) > from));
    }
    const order = /^receivedDateTime (asc|desc)$/.exec($orderby ?? "receivedDateTime desc")?.[1];
    if (!order) return graphError(400, "ErrorInvalidUrlQuery", `Fake Microsoft doesn't understand $orderby=${$orderby}.`);
    mail.sort((a, b) => seconds(a.receivedAt) - seconds(b.receivedAt) || a.order - b.order);
    if (order === "desc") mail.reverse();
    const top = Number(r.query.$top ?? 10);
    if (!(top > 0 && top <= 1000)) return graphError(400, "ErrorInvalidUrlQuery", "The value of $top must be between 1 and 1000.");
    return this.#page(mail.map((m) => select(this.#messageJson(m, false), r.query.$select)), r, parts, top, "$skip");
  }

  #messageJson(mail: StoredMail, textBodies: boolean): OutlookMessage {
    const text = mail.text ?? (mail.html === undefined ? "" : htmlText(mail.html));
    const html = mail.html ?? textHtml(mail.text ?? "");
    const unique = mail.unique ?? text;
    const received = new Date(seconds(mail.receivedAt)).toISOString().replace(".000Z", "Z");
    return {
      id: mail.id,
      receivedDateTime: received,
      subject: mail.subject ?? "",
      from: recipient(mail.from),
      sender: recipient(mail.sender ?? mail.from),
      toRecipients: (mail.to ?? [`${this.name} <${this.me}>`]).map(recipient),
      ccRecipients: (mail.cc ?? []).map(recipient),
      replyTo: (mail.replyTo ?? []).map(recipient),
      bodyPreview: text.replace(/\s+/g, " ").trim().slice(0, 255),
      body: textBodies ? { contentType: "text", content: text } : { contentType: "html", content: html },
      uniqueBody: textBodies ? { contentType: "text", content: unique } : { contentType: "html", content: textHtml(unique) },
      categories: mail.categories ?? [],
      isRead: mail.isRead ?? false,
      isDraft: mail.isDraft ?? false,
      hasAttachments: (mail.attachments ?? []).some((a) => !a.inline),
      importance: mail.importance ?? "normal",
      conversationId: mail.conversationId ?? `conv-${mail.id}`,
      internetMessageId: `<${mail.id}@fake.outlook.com>`,
      ...(mail.headers ? { internetMessageHeaders: Object.entries(mail.headers).map(([name, value]) => ({ name, value })) } : {}),
      inferenceClassification: mail.focused === false ? "other" : "focused",
      flag: { flagStatus: mail.flagged ? "flagged" : "notFlagged" },
      parentFolderId: mail.folderId,
      webLink: `https://outlook.office365.com/owa/?ItemID=${encodeURIComponent(mail.id)}&exvsurl=1&viewmodel=ReadMessageItem`,
    };
  }

  // -------------------------------------------------------------------------------------------------
  // Outlook Calendar

  readonly #events = new Map<string, StoredEvent>();
  readonly #tombstones: Array<{ ids: string[]; seq: number }> = [];
  #seq = 0;
  #syncFloor = 0;
  #eventCount = 0;

  /** Add an event to the calendar. Returns its id. */
  addEvent(input: FakeEventInput = {}): string {
    const id = input.id ?? `AAMkEv${++this.#eventCount}=`;
    const now = this.#now();
    const start = input.isAllDay ? atMidnight(input.start ?? now + 2 * 3_600_000) : (input.start ?? now + 2 * 3_600_000);
    const organizer = address(input.organizer ?? `${this.name} <${this.me}>`);
    const mine = organizer.address.toLowerCase() === this.me.toLowerCase();
    const attendees = (input.attendees ?? []).map((a) => {
      const { name, address: email } = typeof a === "string" ? address(a) : { name: a.name ?? a.address, address: a.address };
      return { name, address: email, response: (typeof a === "string" ? undefined : a.response) ?? "notResponded", type: (typeof a === "string" ? undefined : a.type) ?? "required" };
    });
    if (!mine && !attendees.some((a) => a.address.toLowerCase() === this.me.toLowerCase())) {
      attendees.push({ name: this.name, address: this.me, response: input.response ?? "notResponded", type: "required" });
    }
    this.#events.set(id, {
      id,
      subject: input.subject ?? "Meeting",
      body: input.body ?? "",
      start,
      end: input.end ?? start + (input.isAllDay ? DAY_MS : 30 * 60_000),
      isAllDay: input.isAllDay ?? false,
      location: input.location,
      organizer,
      attendees,
      myResponse: mine ? "organizer" : (input.response ?? "notResponded"),
      responseRequested: input.responseRequested ?? true,
      showAs: input.showAs,
      joinUrl: input.joinUrl,
      repeat: input.repeat && { every: input.repeat.every, interval: input.repeat.interval ?? 1, count: input.repeat.count ?? 30 },
      createdAt: input.createdAt ?? now,
      modifiedAt: now,
      changedAt: ++this.#seq,
      isCancelled: false,
      exceptions: new Map(),
      removed: new Map(),
    });
    return id;
  }

  /** Change an event, or a whole series. */
  updateEvent(id: string, changes: Pick<FakeEventInput, "subject" | "body" | "start" | "end" | "location" | "showAs" | "joinUrl">): void {
    const event = this.#event(id);
    Object.assign(event, Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined)));
    this.#touch(event);
  }

  /** The organizer cancels it. It stays in the calendar, marked cancelled. */
  cancelEvent(id: string): void {
    const event = this.#event(id);
    event.isCancelled = true;
    this.#touch(event);
  }

  /** Delete an event, or a whole series. */
  deleteEvent(id: string): void {
    const event = this.#event(id);
    this.#events.delete(id);
    this.#tombstones.push({ ids: [id, ...this.#instances(event).map((i) => i.id)], seq: ++this.#seq });
  }

  /** An attendee answers. Only their response changes. */
  respond(id: string, attendee: string, response: FakeResponse): void {
    const event = this.#event(id);
    const found = event.attendees.find((a) => a.address.toLowerCase() === attendee.toLowerCase());
    if (!found) throw new Error(`${attendee} isn't invited to ${id}.`);
    found.response = response;
    this.#touch(event);
  }

  /** Change one occurrence of a series (0 is the first), making it an exception. */
  changeOccurrence(id: string, index: number, changes: Partial<Pick<FakeEventInput, "subject" | "start" | "end" | "location">> & { isCancelled?: boolean }): void {
    const event = this.#event(id);
    const before = event.exceptions.get(index)?.changes ?? {};
    event.exceptions.set(index, { changes: { ...before, ...changes }, changedAt: ++this.#seq, modifiedAt: this.#now() });
  }

  /** Delete one occurrence of a series. */
  removeOccurrence(id: string, index: number): void {
    this.#event(id).removed.set(index, ++this.#seq);
  }

  /** Make every delta link handed out so far stop working, as Graph does after a while. */
  expireSync(): void {
    this.#syncFloor = ++this.#seq;
  }

  /** An event, occurrence or series as Graph returns it. */
  event(id: string): GraphEvent | undefined {
    const found = this.#find(id);
    return found && this.#eventJson(found.event, found.instance);
  }

  #event(id: string): StoredEvent {
    const event = this.#events.get(id);
    if (!event) throw new Error(`The fake has no event ${id}.`);
    return event;
  }

  #touch(event: StoredEvent): void {
    event.modifiedAt = this.#now();
    event.changedAt = ++this.#seq;
  }

  /** A stored event by its own id, or one of its occurrences by theirs. */
  #find(id: string): { event: StoredEvent; instance?: Instance } | undefined {
    const event = this.#events.get(id);
    if (event) return event.repeat ? { event } : { event, instance: this.#instances(event)[0] as Instance };
    const match = /^(.+)_(\d+)$/.exec(id);
    const master = match ? this.#events.get(match[1] ?? "") : undefined;
    const instance = master && this.#instances(master).find((i) => i.id === id);
    return master && instance ? { event: master, instance } : undefined;
  }

  #instances(event: StoredEvent): Instance[] {
    if (!event.repeat) {
      return [{ event, index: -1, id: event.id, start: event.start, end: event.end, subject: event.subject, location: event.location, isCancelled: event.isCancelled, exception: undefined }];
    }
    const step = event.repeat.interval * (event.repeat.every === "day" ? DAY_MS : 7 * DAY_MS);
    const instances: Instance[] = [];
    for (let index = 0; index < event.repeat.count; index++) {
      if (event.removed.has(index)) continue;
      const exception = event.exceptions.get(index);
      const changes = exception?.changes ?? {};
      const start = changes.start ?? event.start + index * step;
      instances.push({
        event,
        index,
        id: `${event.id}_${index}`,
        start,
        end: changes.end ?? start + (event.end - event.start),
        subject: changes.subject ?? event.subject,
        location: changes.location ?? event.location,
        isCancelled: event.isCancelled || (changes.isCancelled ?? false),
        exception: exception && { changedAt: exception.changedAt, modifiedAt: exception.modifiedAt },
      });
    }
    return instances;
  }

  #eventJson(event: StoredEvent, instance?: Instance): GraphEvent {
    const first = this.#instances(event)[0];
    const start = instance?.start ?? (event.repeat ? event.start : (first?.start ?? event.start));
    const end = instance?.end ?? start + (event.end - event.start);
    const mine = event.myResponse === "organizer";
    const type = !event.repeat ? "singleInstance" : !instance ? "seriesMaster" : instance.exception ? "exception" : "occurrence";
    const modifiedAt = Math.max(event.modifiedAt, instance?.exception?.modifiedAt ?? 0);
    return {
      id: instance?.id ?? event.id,
      type,
      ...(type === "occurrence" || type === "exception" ? { seriesMasterId: event.id } : {}),
      subject: instance?.subject ?? event.subject,
      body: { contentType: "html", content: textHtml(event.body) },
      bodyPreview: event.body.slice(0, 255),
      start: { dateTime: graphTime(start), timeZone: "UTC" },
      end: { dateTime: graphTime(end), timeZone: "UTC" },
      isAllDay: event.isAllDay,
      location: { displayName: (instance ? instance.location : event.location) ?? "" },
      organizer: { emailAddress: { name: event.organizer.name, address: event.organizer.address } },
      attendees: event.attendees.map((a) => ({ type: a.type, status: { response: a.response }, emailAddress: { name: a.name, address: a.address } })),
      isOrganizer: mine,
      responseRequested: event.responseRequested,
      responseStatus: { response: event.myResponse },
      isCancelled: instance?.isCancelled ?? event.isCancelled,
      showAs: event.showAs ?? (event.myResponse === "tentativelyAccepted" ? "tentative" : "busy"),
      ...(type === "seriesMaster" && event.repeat ? { recurrence: recurrenceOf(event) } : { recurrence: null }),
      onlineMeeting: event.joinUrl ? { joinUrl: event.joinUrl } : null,
      webLink: `https://outlook.office365.com/owa/?itemid=${encodeURIComponent(instance?.id ?? event.id)}&exvsurl=1&path=/calendar/item`,
      createdDateTime: graphStamp(event.createdAt),
      lastModifiedDateTime: graphStamp(modifiedAt),
    };
  }

  /** `parts` is the whole path, such as ["me", "events", "AAMkEv1=", "accept"]. */
  #calendar(r: FakeRequest, parts: string[]): Reply {
    const [, kind, id, action] = parts;
    if (kind === "calendarView" && parts.length === 3 && id === "delta" && r.method === "GET") return this.#delta(r, parts);
    if (kind === "calendarView" && parts.length === 2 && r.method === "GET") {
      const from = Date.parse(r.query.startDateTime ?? "");
      const to = Date.parse(r.query.endDateTime ?? "");
      if (Number.isNaN(from) || Number.isNaN(to)) return graphError(400, "ErrorInvalidParameter", "This request requires a time window specified by the query string parameters StartDateTime and EndDateTime.");
      const top = Number(r.query.$top ?? 10);
      const inView = [...this.#events.values()].flatMap((e) => this.#instances(e)).filter((i) => i.start < to && i.end > from);
      inView.sort((a, b) => a.start - b.start);
      return ok({ value: inView.slice(0, top).map((i) => select(this.#eventJson(i.event, i), r.query.$select)) });
    }
    if (kind !== "events" || id === undefined) return unknownRoute(r);
    const found = this.#find(id);
    if (!found) return graphError(404, "ErrorItemNotFound", "The specified object was not found in the store.");
    if (parts.length === 3 && r.method === "GET") return ok(select(this.#eventJson(found.event, found.instance), r.query.$select));
    const responses = { accept: "accepted", decline: "declined", tentativelyAccept: "tentativelyAccepted" } as const;
    if (parts.length === 4 && r.method === "POST" && action && action in responses) {
      const { event } = found;
      if (event.myResponse === "organizer") return graphError(400, "ErrorInvalidRequest", "Your request can't be completed. You can't respond to a meeting you organized.");
      const body = (r.body ?? {}) as { comment?: string; sendResponse?: unknown };
      const response = responses[action as keyof typeof responses];
      this.rsvps.push({ id, response, comment: body.comment, sendResponse: body.sendResponse });
      event.myResponse = response;
      const me = event.attendees.find((a) => a.address.toLowerCase() === this.me.toLowerCase());
      if (me) me.response = response;
      this.#touch(event);
      return { status: 202 };
    }
    return unknownRoute(r);
  }

  #delta(r: FakeRequest, parts: string[]): Reply {
    const pageSize = Math.min(this.#pageSize, Number(/odata\.maxpagesize=(\d+)/.exec(r.prefer ?? "")?.[1] ?? Number.POSITIVE_INFINITY));
    // Links carry: where the next page starts, the change the listing goes up to, the window, and the change it lists from (-1 for everything).
    let offset = 0;
    let upTo = this.#seq;
    let window: [number, number];
    let since = -1;
    if (r.query.$skiptoken !== undefined) {
      const [o = 0, u = 0, s = 0, e = 0, from = -1] = r.query.$skiptoken.split(".").map(Number);
      offset = o;
      upTo = u;
      window = [s, e];
      since = from;
    } else if (r.query.$deltatoken !== undefined) {
      const [u = 0, s = 0, e = 0] = r.query.$deltatoken.split(".").map(Number);
      if (u < this.#syncFloor) return graphError(410, "SyncStateNotFound", "The sync state generation is not found. Resync is required.");
      window = [s, e];
      since = u;
    } else {
      const from = Date.parse(r.query.startDateTime ?? "");
      const to = Date.parse(r.query.endDateTime ?? "");
      if (Number.isNaN(from) || Number.isNaN(to)) return graphError(400, "ErrorInvalidParameter", "This request requires a time window specified by the query string parameters StartDateTime and EndDateTime.");
      if (r.query.$select || r.query.$filter || r.query.$orderby) return graphError(400, "ErrorInvalidUrlQuery", "Delta queries on calendarView don't support $select, $filter or $orderby.");
      window = [from, to];
    }
    const listed = this.#changes(window, since);
    const page = listed.slice(offset, offset + pageSize);
    const done = offset + pageSize >= listed.length;
    const link = done
      ? { "@odata.deltaLink": this.#link(parts, { $deltatoken: `${upTo}.${window[0]}.${window[1]}` }) }
      : { "@odata.nextLink": this.#link(parts, { $skiptoken: `${offset + pageSize}.${upTo}.${window[0]}.${window[1]}.${since}` }) };
    return ok({ value: page, ...link });
  }

  /** What a delta listing returns: everything in the window when `since` is -1, else what changed after it. */
  #changes([from, to]: [number, number], since: number): GraphEvent[] {
    const listed: Array<{ at: number; event: GraphEvent }> = [];
    const removed = (id: string, reason: string) => listed.push({ at: Number.POSITIVE_INFINITY, event: { id, "@removed": { reason } } });
    for (const event of this.#events.values()) {
      const inView = this.#instances(event).filter((i) => i.start < to && i.end > from);
      const add = (instances: Instance[]) => listed.push(...instances.map((i) => ({ at: i.start, event: this.#eventJson(event, i) })));
      if (since < 0 || event.changedAt > since) {
        if (inView.length > 0) add(inView);
        else if (since >= 0 && !event.repeat) removed(event.id, "changed");
        if (since < 0) continue;
      } else {
        add(inView.filter((i) => (i.exception?.changedAt ?? 0) > since));
      }
      for (const [index, seq] of event.removed) if (seq > since) removed(`${event.id}_${index}`, "deleted");
    }
    if (since >= 0) for (const tombstone of this.#tombstones) if (tombstone.seq > since) for (const id of tombstone.ids) removed(id, "deleted");
    return listed.sort((a, b) => a.at - b.at).map((entry) => entry.event);
  }

  // -------------------------------------------------------------------------------------------------
  // Teams

  readonly #chats = new Map<string, StoredChat>();
  readonly #chatMessages = new Map<string, StoredChatMessage[]>();
  #chatCount = 0;

  /** You, as a Teams user. */
  get #self(): StoredPerson {
    return { id: this.userId, name: this.name, email: this.me, tenantId: this.tenantId, guest: false };
  }

  /** Start a chat you're in. Returns its id. */
  addChat(chat: { id?: string; topic?: string; type?: "oneOnOne" | "group" | "meeting"; members: FakePerson[] }): string {
    const id = chat.id ?? `19:chat${++this.#chatCount}@thread.v2`;
    this.#chats.set(id, { id, topic: chat.topic, type: chat.type ?? "group", members: [this.#self, ...chat.members.map((m) => this.#person(m))], createdAt: this.#now() });
    this.#chatMessages.set(id, []);
    return id;
  }

  /** Someone writes in a chat. Returns the message's id. */
  say(chatId: string, message: FakeSay): string {
    const chat = this.#chat(chatId);
    const at = message.at ?? this.#now();
    const messages = this.#chatMessages.get(chatId) ?? [];
    let id = String(at);
    while (messages.some((m) => m.id === id)) id = String(Number(id) + 1);
    const mentions: StoredChatMessage["mentions"] = [];
    const tags: string[] = [];
    for (const person of message.mentions ?? []) {
      const who = person === "me" ? this.#self : this.#person(person, chat);
      tags.push(`<at id="${mentions.length}">${escapeHtml(who.name)}</at>`);
      mentions.push({ id: mentions.length, mentionText: who.name, mentioned: { user: { id: who.id, displayName: who.name, userIdentityType: "aadUser", tenantId: who.tenantId } } });
    }
    if (message.everyone) {
      tags.push(`<at id="${mentions.length}">Everyone</at>`);
      mentions.push({ id: mentions.length, mentionText: "Everyone", mentioned: { conversation: { id: chatId, displayName: "Everyone" } } });
    }
    const attachments: StoredChatMessage["attachments"] = [];
    const quoted = message.quote === undefined ? undefined : messages.find((m) => m.id === message.quote);
    if (message.quote !== undefined) {
      if (!quoted) throw new Error(`The chat has no message ${message.quote} to quote.`);
      const sender = "user" in quoted.from ? quoted.from.user.name : quoted.from.app.name;
      attachments.push({
        id: quoted.id,
        contentType: "messageReference",
        contentUrl: null,
        content: JSON.stringify({ messageId: quoted.id, messagePreview: htmlText(quoted.html), messageSender: { user: { displayName: sender } } }),
        name: null,
      });
    }
    for (const name of message.files ?? []) {
      attachments.push({ id: `file-${++this.#counter}`, contentType: "reference", contentUrl: `https://acme.sharepoint.com/files/${encodeURIComponent(name)}`, content: null, name });
    }
    const body = message.html ?? textHtml(message.text ?? "");
    const html = `${tags.length > 0 ? `<p>${tags.join(" ")}</p>` : ""}${body}${attachments.map((a) => `<attachment id="${a.id}"></attachment>`).join("")}`;
    const from = message.from === "me" ? { user: this.#self } : "app" in message.from ? { app: { id: `app-${message.from.app}`, name: message.from.app } } : { user: this.#person(message.from, chat) };
    messages.push({
      id,
      chatId,
      messageType: message.messageType ?? "message",
      createdAt: Number(id),
      modifiedAt: Number(id),
      editedAt: undefined,
      deletedAt: undefined,
      from,
      html,
      importance: message.importance ?? "normal",
      mentions,
      attachments,
      reactions: [],
    });
    this.#chatMessages.set(chatId, messages);
    return id;
  }

  /** Someone edits their message. */
  edit(chatId: string, messageId: string, text: string): void {
    const message = this.#chatMessage(chatId, messageId);
    message.html = textHtml(text);
    message.editedAt = message.modifiedAt = this.#now();
  }

  /** Someone deletes their message. */
  deleteMessage(chatId: string, messageId: string): void {
    const message = this.#chatMessage(chatId, messageId);
    message.deletedAt = message.modifiedAt = this.#now();
  }

  /** Someone reacts to a message. */
  react(chatId: string, messageId: string, reactionType = "like", userId = "user-someone"): void {
    const message = this.#chatMessage(chatId, messageId);
    message.modifiedAt = this.#now();
    message.reactions.push({ reactionType, userId, at: message.modifiedAt });
  }

  /** A chat as Graph returns it, with its members. */
  chat(id: string): GraphChat | undefined {
    const chat = this.#chats.get(id);
    return chat && { ...this.#chatJson(chat), members: chat.members.map((m) => memberJson(m)) };
  }

  /** The messages in a chat, oldest first, as Graph returns them. */
  messagesIn(chatId: string): ChatMessage[] {
    return (this.#chatMessages.get(chatId) ?? []).map((m) => this.#chatMessageJson(m));
  }

  #chat(id: string): StoredChat {
    const chat = this.#chats.get(id);
    if (!chat) throw new Error(`The fake has no chat ${id}.`);
    return chat;
  }

  #chatMessage(chatId: string, messageId: string): StoredChatMessage {
    const message = this.#chatMessages.get(chatId)?.find((m) => m.id === messageId);
    if (!message) throw new Error(`The chat ${chatId} has no message ${messageId}.`);
    return message;
  }

  /** A person as stored: the chat's member of that name when there is one. */
  #person(person: FakePerson, chat?: StoredChat): StoredPerson {
    const member = chat?.members.find((m) => m.name === person.name);
    if (member) return member;
    const slug = person.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    return { id: person.id ?? `user-${slug}`, name: person.name, email: person.email, tenantId: person.tenantId ?? this.tenantId, guest: person.guest ?? false };
  }

  #teams(r: FakeRequest, parts: string[]): Reply {
    const [kind, id, sub, messageId, action] = parts;
    if (kind === "chats" && id === undefined && r.method === "GET") return this.#chatList(r, ["me", "chats"]);
    const chat = id === undefined ? undefined : this.#chats.get(id);
    if (!chat) return graphError(404, "NotFound", "Resource not found for the segment 'chats'.");
    if (parts.length === 2 && r.method === "GET") {
      const json = this.#chatJson(chat);
      return ok(r.query.$expand === "members" ? { ...json, members: chat.members.map((m) => memberJson(m)) } : json);
    }
    if (sub !== "messages") return unknownRoute(r);
    const messages = this.#chatMessages.get(chat.id) ?? [];
    if (parts.length === 3 && r.method === "GET") return this.#chatMessageList(r, parts, messages);
    if (parts.length === 3 && r.method === "POST") {
      const body = ((r.body ?? {}) as { body?: { contentType?: string; content?: string } }).body;
      if (!body?.content) return graphError(400, "BadRequest", "Missing body content.");
      const posted = this.say(chat.id, { from: "me", ...(body.contentType === "html" ? { html: body.content } : { text: body.content }) });
      return { status: 201, body: this.#chatMessageJson(this.#chatMessage(chat.id, posted)) };
    }
    const message = messages.find((m) => m.id === messageId);
    if (!message) return graphError(404, "NotFound", "Resource not found for the segment 'messages'.");
    if (parts.length === 5 && action === "setReaction" && r.method === "POST") {
      const reactionType = String(((r.body ?? {}) as { reactionType?: unknown }).reactionType ?? "");
      if (!reactionType) return graphError(400, "BadRequest", "reactionType is required.");
      this.react(chat.id, message.id, reactionType, this.userId);
      return { status: 204 };
    }
    if (parts.length === 4 && r.method === "GET") return ok(this.#chatMessageJson(message));
    return unknownRoute(r);
  }

  #chatList(r: FakeRequest, parts: string[]): Reply {
    const top = Number(r.query.$top ?? 20);
    if (!(top > 0 && top <= 50)) return graphError(400, "BadRequest", "Invalid page size requested. $top must be between 1 and 50.");
    const chats = [...this.#chats.values()].map((chat) => this.#chatJson(chat, r.query.$expand === "lastMessagePreview"));
    if (r.query.$orderby !== undefined) {
      if (r.query.$orderby !== "lastMessagePreview/createdDateTime desc") return graphError(400, "BadRequest", `Fake Microsoft doesn't understand $orderby=${r.query.$orderby}.`);
      const at = (chat: GraphChat) => Date.parse(this.#lastMessage(chat.id)?.createdDateTime ?? "") || Number.NEGATIVE_INFINITY;
      chats.sort((a, b) => at(b) - at(a));
    }
    return this.#page(chats, r, parts, top, "$skiptoken");
  }

  #chatMessageList(r: FakeRequest, parts: string[], messages: StoredChatMessage[]): Reply {
    const top = Number(r.query.$top ?? 20);
    if (!(top > 0 && top <= 50)) return graphError(400, "BadRequest", "Invalid page size requested. $top must be between 1 and 50.");
    const order = /^(createdDateTime|lastModifiedDateTime) desc$/.exec(r.query.$orderby ?? "createdDateTime desc")?.[1] as "createdDateTime" | "lastModifiedDateTime" | undefined;
    if (!order) return graphError(400, "BadRequest", `$orderby=${r.query.$orderby} isn't supported: order by createdDateTime or lastModifiedDateTime, descending.`);
    const timeOf = (m: StoredChatMessage) => (order === "createdDateTime" ? m.createdAt : m.modifiedAt);
    let listed = [...messages];
    if (r.query.$filter !== undefined) {
      const match = /^(createdDateTime|lastModifiedDateTime) (gt|lt) (.+)$/.exec(r.query.$filter);
      const at = Date.parse(match?.[3] ?? "");
      if (!match || Number.isNaN(at) || /^['"]/.test(match[3] ?? "")) return graphError(400, "BadRequest", `Fake Microsoft doesn't understand $filter=${r.query.$filter}.`);
      if (match[1] !== order) return graphError(400, "BadRequest", "$filter and $orderby must use the same property.");
      if (match[1] === "createdDateTime" && match[2] === "gt") return graphError(400, "BadRequest", "createdDateTime only supports the lt operator.");
      listed = listed.filter((m) => (match[2] === "gt" ? timeOf(m) > at : timeOf(m) < at));
    }
    listed.sort((a, b) => timeOf(b) - timeOf(a) || Number(b.id) - Number(a.id));
    return this.#page(listed.map((m) => this.#chatMessageJson(m)), r, parts, top, "$skiptoken");
  }

  #lastMessage(chatId: string): ChatMessage | undefined {
    const messages = this.#chatMessages.get(chatId) ?? [];
    const last = messages.reduce<StoredChatMessage | undefined>((latest, m) => (!latest || m.createdAt >= latest.createdAt ? m : latest), undefined);
    return last && this.#chatMessageJson(last);
  }

  #chatJson(chat: StoredChat, preview = false): GraphChat {
    const last = this.#lastMessage(chat.id);
    return {
      id: chat.id,
      topic: chat.topic ?? null,
      chatType: chat.type,
      webUrl: `https://teams.microsoft.com/l/chat/${encodeURIComponent(chat.id)}/0?tenantId=${this.tenantId}`,
      tenantId: this.tenantId,
      ...(preview
        ? { lastMessagePreview: last ? { id: last.id, createdDateTime: last.createdDateTime ?? "", isDeleted: Boolean(last.deletedDateTime), messageType: last.messageType ?? "message" } : null }
        : {}),
    };
  }

  #chatMessageJson(message: StoredChatMessage): ChatMessage {
    const from =
      "user" in message.from
        ? {
            user: {
              id: message.from.user.id,
              displayName: message.from.user.name,
              userIdentityType: message.from.user.tenantId === this.tenantId ? "aadUser" : "federatedUser",
              tenantId: message.from.user.tenantId,
            },
            application: null,
          }
        : { user: null, application: { id: message.from.app.id, displayName: message.from.app.name } };
    return {
      id: message.id,
      messageType: message.messageType,
      createdDateTime: new Date(message.createdAt).toISOString(),
      lastModifiedDateTime: new Date(message.modifiedAt).toISOString(),
      lastEditedDateTime: message.editedAt === undefined ? null : new Date(message.editedAt).toISOString(),
      deletedDateTime: message.deletedAt === undefined ? null : new Date(message.deletedAt).toISOString(),
      chatId: message.chatId,
      subject: null,
      importance: message.importance,
      webUrl: null,
      from,
      body: { contentType: "html", content: message.deletedAt === undefined ? message.html : "" },
      attachments: message.deletedAt === undefined ? message.attachments : [],
      mentions: message.deletedAt === undefined ? message.mentions : [],
    };
  }

  // -------------------------------------------------------------------------------------------------
  // Shared

  /** One page of `items`, with a next link that carries the same query and the next offset. */
  #page(items: unknown[], r: FakeRequest, parts: string[], top: number, offsetParam: "$skip" | "$skiptoken"): Reply {
    const offset = Number(r.query[offsetParam] ?? 0);
    const more = offset + top < items.length;
    const next = more ? { "@odata.nextLink": this.#link(parts, { ...r.query, [offsetParam]: String(offset + top) }) } : {};
    return ok({ value: items.slice(offset, offset + top), ...next });
  }

  /** An absolute link to a Graph path, as Graph writes next and delta links. */
  #link(parts: string[], query: Record<string, string>): string {
    return `${this.url}/v1.0/${parts.map(encodeURIComponent).join("/")}?${new URLSearchParams(query).toString()}`;
  }

  /** Epoch milliseconds that never repeat, so order by time is order of arrival. */
  #now(): number {
    this.#lastNow = Math.max(Date.now(), this.#lastNow + 1);
    return this.#lastNow;
  }
}

function splitRoute(pathname: string): { api: "graph" | "login"; parts: string[]; tenant?: string } | undefined {
  const login = /^\/([^/]+)\/oauth2\/v2\.0\/(authorize|token|devicecode)$/.exec(pathname);
  if (login) return { api: "login", parts: [login[2] ?? ""], tenant: decodeURIComponent(login[1] ?? "") };
  if (!pathname.startsWith("/v1.0/")) return undefined;
  return { api: "graph", parts: pathname.slice("/v1.0/".length).split("/").map(decodeURIComponent) };
}

/** The permission a Graph path needs. */
function scopeFor(parts: string[]): string | undefined {
  const [first, second] = parts;
  if (first === "me" && parts.length === 1) return "User.Read";
  if (first === "me" && (second === "mailFolders" || second === "messages")) return MAIL_SCOPE;
  if (first === "me" && (second === "calendarView" || second === "events")) return CALENDAR_SCOPE;
  if (first === "chats" || (first === "me" && second === "chats")) return CHAT_SCOPE;
  return undefined;
}

function missingScope(scope: string, granted: string[]): Reply {
  if (scope === CHAT_SCOPE) {
    return graphError(403, "Forbidden", `Missing scope permissions on the request. API requires one of 'Chat.ReadBasic, Chat.Read, Chat.ReadWrite'. Scopes on the request '${granted.join(", ")}'`);
  }
  return graphError(403, "ErrorAccessDenied", "Access is denied. Check credentials and try again.");
}

function graphErrorFor(status: number): unknown {
  const [code, message] =
    {
      400: ["BadRequest", "Bad request."],
      401: ["InvalidAuthenticationToken", "Access token has expired or is not yet valid."],
      403: ["ErrorAccessDenied", "Access is denied. Check credentials and try again."],
      404: ["ErrorItemNotFound", "The specified object was not found in the store."],
      409: ["ErrorFolderExists", "A folder with the specified name already exists."],
      410: ["SyncStateNotFound", "The sync state generation is not found. Resync is required."],
      429: ["ApplicationThrottled", "Application is over its MailboxConcurrency limit."],
      500: ["InternalServerError", "An internal server error occurred."],
    }[status] ?? (status >= 500 ? ["ServiceUnavailable", "The service is temporarily unavailable."] : ["BadRequest", "Bad request."]);
  return { error: { code, message } };
}

function graphError(status: number, code: string, message: string): Reply {
  return { status, body: { error: { code, message } } };
}

function unknownRoute(r: FakeRequest): Reply {
  return graphError(400, "BadRequest", `Fake Microsoft doesn't serve ${r.method} ${r.path}.`);
}

function loginError(error: string, description: string): unknown {
  return { error, error_description: `${description}\r\nTrace ID: 0000aaaa-11bb-22cc-33dd-444444eeeeee\r\nCorrelation ID: 5555ffff-66aa-77bb-88cc-999999dddddd\r\nTimestamp: 2026-09-27 10:00:00Z`, error_codes: [] };
}

function unknownClient(clientId: string | undefined): Reply {
  return { status: 400, body: loginError("unauthorized_client", `AADSTS700016: Application with identifier '${clientId}' was not found in the directory 'Acme'.`) };
}

function splitScopes(scope: string | undefined): string[] {
  return (scope ?? "").split(" ").filter(Boolean);
}

function select<T extends object>(value: T, $select: string | undefined): T {
  if (!$select) return value;
  const fields = new Set(["id", ...$select.split(",").map((field) => field.trim())]);
  return Object.fromEntries(Object.entries(value).filter(([key]) => fields.has(key))) as T;
}

function folderJson(folder: Folder) {
  return { id: folder.id, displayName: folder.displayName, parentFolderId: folder.parentId, childFolderCount: 0, unreadItemCount: 0, totalItemCount: 0 };
}

function attachmentJson(attachment: NonNullable<FakeMail["attachments"]>[number], index: number) {
  return {
    "@odata.type": "#microsoft.graph.fileAttachment",
    id: `att-${index + 1}`,
    name: attachment.name,
    contentType: attachment.contentType ?? "application/octet-stream",
    size: attachment.size ?? 1024,
    isInline: attachment.inline ?? false,
  };
}

function memberJson(person: StoredPerson) {
  return {
    "@odata.type": "#microsoft.graph.aadUserConversationMember",
    id: `member-${person.id}`,
    roles: person.guest ? ["guest"] : ["owner"],
    displayName: person.name,
    userId: person.id,
    email: person.email ?? null,
    tenantId: person.tenantId,
  };
}

function recurrenceOf(event: StoredEvent) {
  const repeat = event.repeat as NonNullable<StoredEvent["repeat"]>;
  const day = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"][new Date(event.start).getUTCDay()];
  return {
    pattern: { type: repeat.every === "day" ? "daily" : "weekly", interval: repeat.interval, ...(repeat.every === "week" ? { daysOfWeek: [day], firstDayOfWeek: "sunday" } : {}) },
    range: { type: "numbered", startDate: new Date(event.start).toISOString().slice(0, 10), numberOfOccurrences: repeat.count, recurrenceTimeZone: "UTC" },
  };
}

/** "Ann Lee <ann@example.com>", or just the address. */
function address(text: string): Address {
  const match = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(text);
  return match ? { name: match[1] || (match[2] ?? ""), address: match[2] ?? "" } : { name: text.trim(), address: text.trim() };
}

function recipient(text: string) {
  const { name, address: email } = address(text);
  return { emailAddress: { name, address: email } };
}

/** Graph's event times: UTC with seven decimals and no offset, such as "2026-10-01T09:00:00.0000000". */
function graphTime(ms: number): string {
  return new Date(ms).toISOString().replace(/\.(\d{3})Z$/, (_, fraction: string) => `.${fraction}0000`);
}

function graphStamp(ms: number): string {
  return `${graphTime(ms)}Z`;
}

function atMidnight(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

/** Received times are kept to the second, as Outlook's are. */
function seconds(ms: number): number {
  return Math.floor(ms / 1000) * 1000;
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function textHtml(text: string): string {
  return `<html><body><p>${escapeHtml(text).replaceAll("\n", "<br>")}</p></body></html>`;
}

function htmlText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .trim();
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
  if (body === undefined || body === "") response.writeHead(status, headers).end();
  else if (typeof body === "string") response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", ...headers }).end(body);
  else response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers }).end(JSON.stringify(body));
}

function ok(body: unknown): Reply {
  return { status: 200, body };
}
