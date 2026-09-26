import { defineAction, type TriggeredEvent } from "jev-events";

import { GoogleApiError, type GoogleApi } from "../api.js";
import type { GmailItem } from "./item.js";
import type { EmailAddress } from "./message.js";
import type { GmailSession, GmailSource } from "./source.js";

type Event = TriggeredEvent<GmailItem>;
type Text = string | ((event: Event) => string);

const resolve = (text: Text, event: Event) => (typeof text === "function" ? text(event) : text);

function sessionOf(source: GmailSource): GmailSession {
  if (!source.session) throw new Error("Gmail actions need the Gmail source: google.gmail.inbox({ auth }).");
  return source.session;
}

const sender = (e: Event) => e.item.from.name ?? e.item.from.address;

function modify(name: string, describe: (e: Event) => string, change: { addLabelIds?: string[]; removeLabelIds?: string[] }) {
  return defineAction<"gmail", GmailItem, GmailSource>({
    platform: "gmail",
    name,
    describe,
    async run(e, source) {
      await sessionOf(source).api.gmail("POST", `/messages/${e.item.id}/modify`, { body: change });
    },
  });
}

/** Move the email to Trash. Gmail keeps it there for 30 days; nothing is deleted permanently. */
export function trash() {
  return defineAction<"gmail", GmailItem, GmailSource>({
    platform: "gmail",
    name: "gmail.trash",
    describe: (e) => `move the email from ${sender(e)} to Trash`,
    async run(e, source) {
      await sessionOf(source).api.gmail("POST", `/messages/${e.item.id}/trash`);
    },
  });
}

/** Take the email out of the inbox. It stays in All Mail. */
export function archive() {
  return modify("gmail.archive", (e) => `archive the email from ${sender(e)}`, { removeLabelIds: ["INBOX"] });
}

export function markRead() {
  return modify("gmail.markRead", (e) => `mark the email from ${sender(e)} as read`, { removeLabelIds: ["UNREAD"] });
}

export function star() {
  return modify("gmail.star", (e) => `star the email from ${sender(e)}`, { addLabelIds: ["STARRED"] });
}

/** Add a label, creating it the first time. */
export function label(name: string) {
  return defineAction<"gmail", GmailItem, GmailSource>({
    platform: "gmail",
    name: "gmail.label",
    describe: (e) => `label the email from ${sender(e)} "${name}"`,
    async run(e, source) {
      const session = sessionOf(source);
      const id = await labelId(session, name);
      await session.api.gmail("POST", `/messages/${e.item.id}/modify`, { body: { addLabelIds: [id] } });
    },
  });
}

/** Save a reply as a draft in the thread, for the user to review and send. It is never sent. */
export function draftReply(text: Text) {
  return defineAction<"gmail", GmailItem, GmailSource>({
    platform: "gmail",
    name: "gmail.draftReply",
    describe: (e) => `draft a reply to ${sender(e)} (not sent)`,
    async run(e, source) {
      const session = sessionOf(source);
      await session.api.gmail("POST", "/drafts", {
        body: { message: { raw: replyMime(e.item, resolve(text, e)), threadId: e.item.threadId } },
      });
    },
  });
}

const labelIds = new WeakMap<GmailSession, Map<string, Promise<string>>>();

function labelId(session: GmailSession, name: string): Promise<string> {
  let cache = labelIds.get(session);
  if (!cache) labelIds.set(session, (cache = new Map()));
  const key = name.toLowerCase();
  let id = cache.get(key);
  if (!id) {
    const labels = cache;
    id = findOrCreateLabel(session.api, name).catch((error: unknown) => {
      labels.delete(key);
      throw error;
    });
    cache.set(key, id);
  }
  return id;
}

async function findOrCreateLabel(api: GoogleApi, name: string): Promise<string> {
  const find = async () => {
    const { labels } = await api.gmail<{ labels?: Array<{ id: string; name: string }> }>("GET", "/labels");
    return labels?.find((l) => l.name.toLowerCase() === name.toLowerCase())?.id;
  };
  const existing = await find();
  if (existing) return existing;
  try {
    const created = await api.gmail<{ id: string }>("POST", "/labels", {
      body: { name, labelListVisibility: "labelShow", messageListVisibility: "show" },
    });
    return created.id;
  } catch (error) {
    // Someone else created it a moment ago.
    if (error instanceof GoogleApiError && error.status === 409) {
      const again = await find();
      if (again) return again;
    }
    throw error;
  }
}

/** The raw MIME of a plain-text reply, threaded under the email, base64url-encoded as Gmail wants it. */
export function replyMime(item: GmailItem, body: string): string {
  const to = item.replyTo ?? item.from;
  const subject = /^re:/i.test(item.subject) ? item.subject : `Re: ${item.subject}`;
  const references = [item.references, item.messageId].filter(Boolean).join(" ");
  const lines = [
    `To: ${encodeAddress(to)}`,
    `Subject: ${encodeHeader(subject)}`,
    ...(item.messageId ? [`In-Reply-To: ${item.messageId}`] : []),
    ...(references ? [`References: ${references}`] : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    (Buffer.from(body, "utf8").toString("base64").match(/.{1,76}/g) ?? []).join("\r\n"),
  ];
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}

/** RFC 2047 encoded words for non-ASCII header text, split so no word is too long. */
function encodeHeader(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const words: string[] = [];
  let chunk = "";
  for (const char of value) {
    if (Buffer.byteLength(chunk + char) > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += char;
  }
  words.push(chunk);
  return words.map((word) => `=?UTF-8?B?${Buffer.from(word, "utf8").toString("base64")}?=`).join("\r\n ");
}

function encodeAddress({ name, address }: EmailAddress): string {
  if (!name) return address;
  const display = /^[\x20-\x7e]*$/.test(name) ? `"${name.replace(/["\\]/g, "\\$&")}"` : encodeHeader(name);
  return `${display} <${address}>`;
}
