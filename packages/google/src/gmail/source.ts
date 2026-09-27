import type { ConnectedSource, SourceContext } from "jev-events";

import { GoogleApiError, isFatal, type GoogleApi } from "../api.js";
import { People, protectedBecause, type Person, type ProtectOptions } from "../protect.js";
import { addressOf, connectedApi, connectionOf } from "../session.js";
import { describeEmail, gmailItem, type GmailItem } from "./item.js";
import { header, parseAddresses, type GmailMessage } from "./message.js";

/** What the Gmail source and its actions use for one connection. */
export interface GmailSession {
  api: GoogleApi;
  /** The signed-in address. */
  me: string;
  people: People;
}

export type GmailSource = ConnectedSource<GmailItem, "gmail", GmailSession>;

export interface InboxOptions {
  /** Also emit this many of the latest emails already there on the first check. Default 0. */
  backfill?: number;
  /**
   * Who native actions never touch. Default: colleagues at your company and people you've emailed
   * before. `false` protects no one.
   */
  protect?: ProtectOptions | false;
  /** Watch another label instead of the inbox. Default "INBOX". */
  label?: string;
}

/** Where the last check left off: Gmail's history ID, and the emails backfilled on the first check. */
export type GmailCursor = {
  historyId: string;
  backfilled?: string[];
};

interface Profile {
  emailAddress: string;
  historyId: string;
}

interface HistoryPage {
  history?: Array<{ messagesAdded?: Array<{ message: { id: string; labelIds?: string[] } }> }>;
  historyId?: string;
  nextPageToken?: string;
}

/** Labels whose mail is never emitted, even when it also carries the watched label. */
const SKIPPED_LABELS = ["SPAM", "TRASH", "DRAFT", "CHAT"];

/**
 * New mail arriving in each connected account's inbox, read from Gmail's history every 15 seconds
 * by default. The first check starts from now, plus `backfill` recent emails.
 */
export function inbox(options: InboxOptions = {}): GmailSource {
  const label = options.label ?? "INBOX";
  const id = `gmail:${label.toLowerCase()}`;
  return {
    id,
    platform: "gmail",
    noun: "email",
    canAct: true,
    integration: "google",
    defaults: { every: "15s" },
    describe: describeEmail,
    isProtected: (item) => item.protectedBecause ?? false,
    async session(ctx) {
      const connection = connectionOf(ctx, id);
      const api = connectedApi(ctx, connection);
      const me = await addressOf(connection, async () => (await api.gmail<Profile>("GET", "/profile")).emailAddress);
      return { api, me, people: new People(api, me) };
    },
    async check(ctx) {
      const cursor = await ctx.cursor.get<GmailCursor>();
      if (cursor) await readHistory(ctx, cursor, label, options.protect);
      else await begin(ctx, label, options);
    },
  };
}

/** The first check: remember where the history is now, and emit the latest few emails. */
async function begin(ctx: SourceContext<GmailItem, GmailSession>, label: string, options: InboxOptions): Promise<void> {
  const { api } = ctx.session;
  const { historyId } = await api.gmail<Profile>("GET", "/profile");
  const backfilled: string[] = [];
  if (options.backfill) {
    const list = await api.gmail<{ messages?: Array<{ id: string }> }>("GET", "/messages", {
      query: { labelIds: label, maxResults: options.backfill },
    });
    for (const { id } of (list.messages ?? []).reverse()) {
      if (ctx.signal.aborted) return;
      await emit(ctx, id, label, options.protect);
      backfilled.push(id);
    }
  }
  await ctx.cursor.set({ historyId, ...(backfilled.length > 0 ? { backfilled } : {}) } satisfies GmailCursor);
}

/** Emit the mail added to the label since the cursor. */
async function readHistory(
  ctx: SourceContext<GmailItem, GmailSession>,
  cursor: GmailCursor,
  label: string,
  protect: ProtectOptions | false | undefined,
): Promise<void> {
  const { api } = ctx.session;
  const added: string[] = [];
  let latest = cursor.historyId;
  let pageToken: string | undefined;
  do {
    let page: HistoryPage;
    try {
      page = await api.gmail<HistoryPage>("GET", "/history", {
        query: { startHistoryId: cursor.historyId, historyTypes: "messageAdded", labelId: label, pageToken },
      });
    } catch (error) {
      if (!(error instanceof GoogleApiError && error.status === 404)) throw error;
      // Gmail keeps about a week of history. After a long pause, start over from now.
      ctx.log.warn("Gmail's history cursor expired, so mail that arrived while paused is skipped.");
      const { historyId } = await api.gmail<Profile>("GET", "/profile");
      await ctx.cursor.set({ historyId } satisfies GmailCursor);
      return;
    }
    for (const record of page.history ?? []) {
      for (const { message } of record.messagesAdded ?? []) added.push(message.id);
    }
    if (page.historyId) latest = page.historyId;
    pageToken = page.nextPageToken;
  } while (pageToken);

  const skip = new Set(cursor.backfilled);
  for (const id of new Set(added)) {
    if (ctx.signal.aborted) return;
    if (!skip.has(id)) await emit(ctx, id, label, protect);
  }
  await ctx.cursor.set({ historyId: latest } satisfies GmailCursor);
}

/** Fetch one email and emit it, unless it has left the label or is spam, trash or a draft. */
async function emit(ctx: SourceContext<GmailItem, GmailSession>, id: string, label: string, protect: ProtectOptions | false | undefined): Promise<void> {
  try {
    const message = await ctx.session.api.gmail<GmailMessage>("GET", `/messages/${id}`, { query: { format: "full" } });
    const labels = message.labelIds ?? [];
    if (!labels.includes(label) || labels.some((l) => SKIPPED_LABELS.includes(l))) return;
    if (ctx.signal.aborted) return;
    await ctx.emit(await toItem(message, ctx, protect));
  } catch (error) {
    if (error instanceof GoogleApiError && error.status === 404) return; // deleted before we got to it
    if (isFatal(error)) throw error;
    ctx.fail(error);
  }
}

async function toItem(message: GmailMessage, ctx: SourceContext<GmailItem, GmailSession>, protect: ProtectOptions | false | undefined): Promise<GmailItem> {
  const { me, people } = ctx.session;
  const from = parseAddresses(header(message.payload, "From"))[0];
  let sender: Person | undefined;
  let reason: string | undefined;
  if (from) {
    try {
      sender = await people.about(from.address);
      reason = protectedBecause(sender, protect);
    } catch (error) {
      // Can't tell whether you know them, so play safe: judge it, but don't act on it.
      ctx.log.warn(`Couldn't check whether you've emailed ${from.address} before: ${(error as Error).message}`);
      reason = protect === false ? undefined : "couldn't check your Sent folder";
    }
  }
  return gmailItem(message, { me, ...(sender ? { sender } : {}), ...(reason ? { protectedBecause: reason } : {}) });
}
