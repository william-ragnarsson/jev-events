import { toMs, type Duration, type Source, type SourceContext } from "jev-events";

import { GoogleApi, GoogleApiError, isFatal } from "../api.js";
import type { GoogleAuth } from "../auth.js";
import { poll } from "../poll.js";
import { People, protectedBecause, type Person, type ProtectOptions } from "../protect.js";
import { describeEmail, gmailItem, type GmailItem } from "./item.js";
import { header, parseAddresses, type GmailMessage } from "./message.js";

export interface GmailSession {
  api: GoogleApi;
  /** The signed-in address. */
  me: string;
  people: People;
}

export interface GmailSource extends Source<GmailItem, "gmail"> {
  /** Set once the source has started. Actions use it. */
  readonly session: GmailSession | undefined;
}

export interface InboxOptions {
  /** The signed-in account, e.g. `google.auth.fromFile()`. */
  auth: GoogleAuth;
  /** How often to check for new mail. Default "15s". */
  every?: Duration;
  /** Also emit this many of the latest emails already there when starting. Default 0. */
  backfill?: number;
  /**
   * Who native actions never touch. Default: colleagues at your company and people you've emailed
   * before. `false` protects no one.
   */
  protect?: ProtectOptions | false;
  /** Watch another label instead of the inbox. Default "INBOX". */
  label?: string;
}

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
const SEEN_LIMIT = 2_000;

/** New mail arriving in the inbox, checked every 15 seconds through Gmail's history. */
export function inbox(options: InboxOptions): GmailSource {
  const label = options.label ?? "INBOX";
  let session: GmailSession | undefined;
  return {
    id: `gmail:${label.toLowerCase()}`,
    platform: "gmail",
    noun: "email",
    canAct: true,
    describe: describeEmail,
    isProtected: (item) => item.protectedBecause ?? false,
    get session() {
      return session;
    },
    async start(ctx) {
      const api = new GoogleApi(options.auth);
      const profile = await api.gmail<Profile>("GET", "/profile");
      session = { api, me: profile.emailAddress.toLowerCase(), people: new People(api, profile.emailAddress) };
      pollHistory(ctx, session, profile.historyId, { ...options, label });
    },
  };
}

/** Check Gmail's history for added messages on a timer, emitting each new one once. */
function pollHistory(ctx: SourceContext<GmailItem>, session: GmailSession, historyId: string, options: InboxOptions & { label: string }): void {
  const { api } = session;
  const seen = new Set<string>();
  let cursor = historyId;

  const remember = (id: string): boolean => {
    if (seen.has(id)) return false;
    seen.add(id);
    if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value as string);
    return true;
  };

  const emit = async (id: string) => {
    try {
      const message = await api.gmail<GmailMessage>("GET", `/messages/${id}`, { query: { format: "full" } });
      const labels = message.labelIds ?? [];
      if (!labels.includes(options.label) || labels.some((l) => SKIPPED_LABELS.includes(l))) return;
      if (ctx.signal.aborted) return;
      ctx.emit(await toItem(message, session, options.protect, ctx));
    } catch (error) {
      if (error instanceof GoogleApiError && error.status === 404) return; // deleted before we got to it
      if (isFatal(error)) throw error;
      ctx.fail(error);
    }
  };

  const backfill = async (count: number) => {
    const list = await api.gmail<{ messages?: Array<{ id: string }> }>("GET", "/messages", {
      query: { labelIds: options.label, maxResults: count },
    });
    for (const { id } of (list.messages ?? []).reverse()) {
      if (remember(id)) await emit(id);
    }
  };

  const checkHistory = async () => {
    const added: string[] = [];
    let latest = cursor;
    let pageToken: string | undefined;
    do {
      let page: HistoryPage;
      try {
        page = await api.gmail<HistoryPage>("GET", "/history", {
          query: { startHistoryId: cursor, historyTypes: "messageAdded", labelId: options.label, pageToken },
        });
      } catch (error) {
        if (!(error instanceof GoogleApiError && error.status === 404)) throw error;
        // Gmail keeps about a week of history. After a long pause, start over from now.
        ctx.log.warn("Gmail's history cursor expired, so mail that arrived while paused is skipped.");
        cursor = (await api.gmail<Profile>("GET", "/profile")).historyId;
        return;
      }
      for (const record of page.history ?? []) {
        for (const { message } of record.messagesAdded ?? []) added.push(message.id);
      }
      if (page.historyId) latest = page.historyId;
      pageToken = page.nextPageToken;
    } while (pageToken);
    for (const id of added) {
      if (ctx.signal.aborted) return;
      if (remember(id)) await emit(id);
    }
    cursor = latest;
  };

  poll(ctx, toMs(options.every ?? "15s"), async (first) => {
    if (first && options.backfill) await backfill(options.backfill);
    await checkHistory();
  });
}

async function toItem(message: GmailMessage, session: GmailSession, protect: ProtectOptions | false | undefined, ctx: SourceContext<GmailItem>): Promise<GmailItem> {
  const from = parseAddresses(header(message.payload, "From"))[0];
  let sender: Person | undefined;
  let reason: string | undefined;
  if (from) {
    try {
      sender = await session.people.about(from.address);
      reason = protectedBecause(sender, protect);
    } catch (error) {
      // Can't tell whether you know them, so play safe: judge it, but don't act on it.
      ctx.log.warn(`Couldn't check whether you've emailed ${from.address} before: ${(error as Error).message}`);
      reason = protect === false ? undefined : "couldn't check your Sent folder";
    }
  }
  return gmailItem(message, { me: session.me, ...(sender ? { sender } : {}), ...(reason ? { protectedBecause: reason } : {}) });
}
