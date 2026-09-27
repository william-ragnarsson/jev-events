import { defineAction, type ActionContext, type TriggeredEvent } from "jev-events";

import { GraphApiError } from "../api.js";
import { findFolder } from "./folders.js";
import type { OutlookItem } from "./item.js";
import type { OutlookSession } from "./source.js";

type Event = TriggeredEvent<OutlookItem>;
type Text = string | ((event: Event) => string);

const resolve = (text: Text, event: Event) => (typeof text === "function" ? text(event) : text);

function sessionOf(ctx: ActionContext<OutlookSession>): OutlookSession {
  if (!ctx.session?.api) throw new Error("Outlook actions run on items from microsoft.outlook.inbox().");
  return ctx.session;
}

const sender = (e: Event) => e.item.from.name ?? e.item.from.address;
const messagePath = (e: Event) => `/me/messages/${encodeURIComponent(e.item.id)}`;

function update(name: string, describe: (e: Event) => string, change: Record<string, unknown>) {
  return defineAction<"outlook", OutlookItem, OutlookSession>({
    platform: "outlook",
    name,
    describe,
    async run(e, ctx) {
      await sessionOf(ctx).api.call("PATCH", messagePath(e), { body: change });
    },
  });
}

async function moveTo(e: Event, ctx: ActionContext<OutlookSession>, destinationId: string): Promise<void> {
  await sessionOf(ctx).api.call("POST", `${messagePath(e)}/move`, { body: { destinationId } });
}

/** Move the email to Deleted Items. Nothing is deleted permanently. */
export function trash() {
  return defineAction<"outlook", OutlookItem, OutlookSession>({
    platform: "outlook",
    name: "outlook.trash",
    describe: (e) => `move the email from ${sender(e)} to Deleted Items`,
    run: (e, ctx) => moveTo(e, ctx, "deleteditems"),
  });
}

/** Move the email to the Archive folder. */
export function archive() {
  return defineAction<"outlook", OutlookItem, OutlookSession>({
    platform: "outlook",
    name: "outlook.archive",
    describe: (e) => `archive the email from ${sender(e)}`,
    async run(e, ctx) {
      try {
        await moveTo(e, ctx, "archive");
      } catch (error) {
        if (error instanceof GraphApiError && error.code !== "ErrorItemNotFound" && (error.status === 404 || error.code === "ErrorFolderNotFound")) {
          const hint = 'Use microsoft.outlook.move("Done") instead, which makes the folder the first time.';
          throw new Error(`This mailbox has no Archive folder, so the email wasn't moved. ${hint}`, { cause: error });
        }
        throw error;
      }
    },
  });
}

/**
 * Move the email to a folder, such as "Receipts" or "Inbox/Receipts", creating it the first time.
 * Well-known names like "junkemail" work in every mailbox language.
 */
export function move(folder: string) {
  return defineAction<"outlook", OutlookItem, OutlookSession>({
    platform: "outlook",
    name: "outlook.move",
    describe: (e) => `move the email from ${sender(e)} to "${folder}"`,
    async run(e, ctx) {
      await moveTo(e, ctx, await folderId(sessionOf(ctx), folder));
    },
  });
}

/** Flag the email for follow-up. */
export function flag() {
  return update("outlook.flag", (e) => `flag the email from ${sender(e)}`, { flag: { flagStatus: "flagged" } });
}

export function markRead() {
  return update("outlook.markRead", (e) => `mark the email from ${sender(e)} as read`, { isRead: true });
}

/** Add an Outlook category, keeping the ones already there. */
export function categorize(name: string) {
  return defineAction<"outlook", OutlookItem, OutlookSession>({
    platform: "outlook",
    name: "outlook.categorize",
    describe: (e) => `categorize the email from ${sender(e)} as "${name}"`,
    async run(e, ctx) {
      const { api } = sessionOf(ctx);
      const current = await api.call<{ categories?: string[] }>("GET", messagePath(e), { query: { $select: "categories" } });
      const categories = current.categories ?? [];
      if (categories.some((category) => category.toLowerCase() === name.toLowerCase())) return;
      await api.call("PATCH", messagePath(e), { body: { categories: [...categories, name] } });
    },
  });
}

/** Save a reply as a draft in Drafts, for the user to review and send. It is never sent. */
export function draftReply(text: Text) {
  return defineAction<"outlook", OutlookItem, OutlookSession>({
    platform: "outlook",
    name: "outlook.draftReply",
    describe: (e) => `draft a reply to ${sender(e)} (not sent)`,
    async run(e, ctx) {
      await sessionOf(ctx).api.call("POST", `${messagePath(e)}/createReply`, { body: { comment: resolve(text, e) } });
    },
  });
}

const folderIds = new WeakMap<OutlookSession, Map<string, Promise<string>>>();

function folderId(session: OutlookSession, path: string): Promise<string> {
  let cache = folderIds.get(session);
  if (!cache) folderIds.set(session, (cache = new Map()));
  const key = path.toLowerCase();
  let id = cache.get(key);
  if (!id) {
    const folders = cache;
    id = findFolder(session.api, path, { create: true }).catch((error: unknown) => {
      folders.delete(key);
      throw error;
    });
    cache.set(key, id);
  }
  return id;
}
