import type { ConnectedSource, SourceContext } from "jev-events";

import { GraphApiError, isFatal, type GraphApi, type GraphPage } from "../api.js";
import type { MicrosoftUser } from "../oauth.js";
import { People, protectedBecause, type Person, type ProtectOptions } from "../protect.js";
import { connectedApi, connectionOf, whoAmI } from "../session.js";
import { findFolder } from "./folders.js";
import { describeEmail, outlookItem, senderOf, type OutlookItem } from "./item.js";
import { MESSAGE_FIELDS, TEXT_BODIES, type GraphAttachment, type OutlookMessage } from "./message.js";

/** What the Outlook source and its actions use for one connection. */
export interface OutlookSession {
  api: GraphApi;
  /** The signed-in address, or "" for an account without one. */
  me: string;
  user: MicrosoftUser;
  people: People;
  /** The watched folder: a well-known name such as "inbox", or the folder's id. */
  folder: string;
}

export type OutlookSource = ConnectedSource<OutlookItem, "outlook", OutlookSession>;

export interface InboxOptions {
  /** Also emit this many of the latest emails already there on the first check. Default 0. */
  backfill?: number;
  /**
   * Who native actions never touch. Default: colleagues at your company and people you've emailed
   * before. `false` protects no one.
   */
  protect?: ProtectOptions | false;
  /** Watch another folder instead of the inbox, such as "Inbox/Receipts" or "junkemail". Default "inbox". */
  folder?: string;
}

/**
 * Where the last check left off: when the newest email read arrived, by Microsoft's clock, and the
 * emails that arrived shortly before it, which the next check lists again.
 */
export type OutlookCursor = {
  /** receivedDateTime of the newest email read (or where reading resumed after a long pause), or null while the folder was empty. */
  since: string | null;
  /** [id, receivedDateTime] of the emails already read near `since`. */
  seen: Array<[string, string]>;
  /** When the last check ran, by this machine's clock. */
  checkedAt: string;
};

interface Listed {
  id: string;
  receivedDateTime?: string;
}

/** Mail can land in a folder a little after the time it says it arrived, so each check looks this far back. */
const OVERLAP_MS = 5 * 60_000;
/** After a longer pause, older mail is skipped rather than read all at once. */
const MAX_PAUSE_MS = 7 * 24 * 60 * 60_000;
const PAGE_SIZE = 50;
const MAX_PAGES = 10;
const MAX_SEEN = 1_000;

/**
 * New mail arriving in each connected account's inbox, listed from Outlook every 15 seconds by
 * default. The first check starts from now, plus `backfill` recent emails. Mail moved into the
 * folder later than 5 minutes after it arrived isn't seen.
 */
export function inbox(options: InboxOptions = {}): OutlookSource {
  const folder = options.folder ?? "inbox";
  const id = `outlook:${folder.toLowerCase()}`;
  return {
    id,
    platform: "outlook",
    noun: "email",
    canAct: true,
    integration: "microsoft",
    defaults: { every: "15s" },
    describe: describeEmail,
    isProtected: (item) => item.protectedBecause ?? false,
    async session(ctx) {
      const connection = connectionOf(ctx, id);
      const api = connectedApi(ctx, connection);
      const user = await whoAmI(connection, api);
      const me = user.email ?? "";
      return { api, me, user, people: new People(api, me), folder: await findFolder(api, folder) };
    },
    async check(ctx) {
      const cursor = await ctx.cursor.get<OutlookCursor>();
      if (cursor) await readNew(ctx, cursor, options.protect);
      else await begin(ctx, options);
    },
  };
}

type Context = SourceContext<OutlookItem, OutlookSession>;

const messagesIn = (folder: string) => `/me/mailFolders/${encodeURIComponent(folder)}/messages`;

/** The first check: remember the newest email there now, and emit the latest few. */
async function begin(ctx: Context, options: InboxOptions): Promise<void> {
  const { api, folder } = ctx.session;
  const backfill = Math.max(0, Math.floor(options.backfill ?? 0));
  const page = await api.call<GraphPage<Listed>>("GET", messagesIn(folder), {
    query: { $orderby: "receivedDateTime desc", $select: "id,receivedDateTime", $top: Math.min(Math.max(backfill, PAGE_SIZE), 1_000) },
  });
  const latest = (page.value ?? []).filter((message): message is Required<Listed> => Boolean(message.receivedDateTime));
  const seen = new Map(latest.map((message): [string, string] => [message.id, message.receivedDateTime]));
  for (const message of latest.slice(0, backfill).reverse()) {
    if (ctx.signal.aborted) return;
    await emit(ctx, message.id, options.protect);
  }
  await save(ctx, latest[0] ? Date.parse(latest[0].receivedDateTime) : undefined, seen);
}

/** Emit the mail that arrived since the cursor, oldest first. */
async function readNew(ctx: Context, cursor: OutlookCursor, protect: ProtectOptions | false | undefined): Promise<void> {
  const { api, folder } = ctx.session;
  const seen = new Map(cursor.seen);
  let newest = cursor.since ? Date.parse(cursor.since) : undefined;
  let from = newest === undefined ? undefined : newest - OVERLAP_MS;
  const weekAgo = Date.now() - MAX_PAUSE_MS;
  if (Date.parse(cursor.checkedAt) < weekAgo && (from === undefined || from < weekAgo)) {
    ctx.log.warn("Outlook wasn't checked for over a week, so only mail from the last week is read.");
    from = weekAgo;
    // The next check carries on from here, rather than going back for the skipped mail.
    newest = weekAgo + OVERLAP_MS;
  }

  let page = await api.call<GraphPage<Listed>>("GET", messagesIn(folder), {
    query: {
      ...(from === undefined ? {} : { $filter: `receivedDateTime ge ${new Date(from).toISOString()}` }),
      $orderby: "receivedDateTime asc",
      $select: "id,receivedDateTime",
      $top: PAGE_SIZE,
    },
  });
  for (let pages = 1; ; pages++) {
    for (const message of page.value ?? []) {
      if (ctx.signal.aborted) break;
      if (!message.receivedDateTime) continue;
      if (!seen.has(message.id)) {
        await emit(ctx, message.id, protect);
        seen.set(message.id, message.receivedDateTime);
      }
      newest = Math.max(newest ?? 0, Date.parse(message.receivedDateTime));
    }
    // Past the last page read, the next check carries on from the newest email read.
    const next = page["@odata.nextLink"];
    if (!next || pages >= MAX_PAGES || ctx.signal.aborted) break;
    page = await api.call<GraphPage<Listed>>("GET", next);
  }
  await save(ctx, newest, seen);
}

async function save(ctx: Context, newest: number | undefined, seen: Map<string, string>): Promise<void> {
  const keepFrom = newest === undefined ? -Infinity : newest - OVERLAP_MS;
  const kept = [...seen]
    .filter(([, at]) => Date.parse(at) >= keepFrom)
    .sort((a, b) => Date.parse(a[1]) - Date.parse(b[1]))
    .slice(-MAX_SEEN);
  await ctx.cursor.set({
    since: newest === undefined ? null : new Date(newest).toISOString(),
    seen: kept,
    checkedAt: new Date().toISOString(),
  } satisfies OutlookCursor);
}

/** Fetch one email and emit it, unless it's a draft or was deleted. */
async function emit(ctx: Context, id: string, protect: ProtectOptions | false | undefined): Promise<void> {
  const path = `/me/messages/${encodeURIComponent(id)}`;
  try {
    const message = await ctx.session.api.call<OutlookMessage>("GET", path, { query: { $select: MESSAGE_FIELDS }, prefer: [TEXT_BODIES] });
    if (message.isDraft) return;
    if (message.hasAttachments) message.attachments = await attachments(ctx, path);
    if (ctx.signal.aborted) return;
    await ctx.emit(await toItem(message, ctx, protect));
  } catch (error) {
    if (error instanceof GraphApiError && error.status === 404) return; // deleted before we got to it
    if (isFatal(error)) throw error;
    ctx.fail(error);
  }
}

async function attachments(ctx: Context, path: string): Promise<GraphAttachment[]> {
  try {
    return await ctx.session.api.all<GraphAttachment>(`${path}/attachments`, { query: { $select: "name,contentType,size,isInline" } }, 1);
  } catch (error) {
    if (isFatal(error)) throw error;
    ctx.log.warn(`Couldn't list an email's attachments: ${(error as Error).message}`);
    return [];
  }
}

async function toItem(message: OutlookMessage, ctx: Context, protect: ProtectOptions | false | undefined): Promise<OutlookItem> {
  const { me, people } = ctx.session;
  const from = senderOf(message);
  let sender: Person | undefined;
  let reason: string | undefined;
  if (from) {
    try {
      sender = await people.about(from.address);
      reason = protectedBecause(sender, protect);
    } catch (error) {
      // Can't tell whether you know them, so play safe: judge it, but don't act on it.
      ctx.log.warn(`Couldn't check whether you've emailed ${from.address} before: ${(error as Error).message}`);
      reason = protect === false ? undefined : "couldn't check your Sent Items";
    }
  }
  return outlookItem(message, { me, ...(sender ? { sender } : {}), ...(reason ? { protectedBecause: reason } : {}) });
}
