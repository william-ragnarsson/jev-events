import type { Author, Item, JsonValue } from "jev-events";

import type { Person } from "../protect.js";
import { truncate } from "../text.js";
import {
  attachmentsOf,
  bodyText,
  formatAddress,
  header,
  parseAddresses,
  stripQuoted,
  type Attachment,
  type EmailAddress,
  type GmailMessage,
} from "./message.js";

export type GmailCategory = "personal" | "social" | "promotions" | "updates" | "forums";

/** One email, as the Gmail source emits it. */
export interface GmailItem extends Item<GmailMessage> {
  /** `id` and `email` are the sender's address. */
  author: Author & { email: string };
  threadId: string;
  subject: string;
  /** The new text: quoted replies cut, capped at 4,000 characters. */
  body: string;
  from: EmailAddress;
  to: EmailAddress[];
  cc: EmailAddress[];
  /** Where replies go when it isn't `from`. */
  replyTo?: EmailAddress;
  snippet: string;
  /** Gmail label IDs, such as "INBOX", "UNREAD" or "IMPORTANT". */
  labels: string[];
  unread: boolean;
  attachments: Attachment[];
  /** The Message-ID header, used to thread a draft reply. */
  messageId?: string;
  references?: string;
  /** Gmail's inbox tab. */
  category?: GmailCategory;
  /** Sent through a mailing list or bulk sender (List-Id, List-Unsubscribe or Precedence: bulk). */
  mailingList: boolean;
  /** Why native actions skip this email, e.g. "colleague at acme.com". */
  protectedBecause?: string;
}

const CATEGORIES: Record<string, GmailCategory> = {
  CATEGORY_PERSONAL: "personal",
  CATEGORY_SOCIAL: "social",
  CATEGORY_PROMOTIONS: "promotions",
  CATEGORY_UPDATES: "updates",
  CATEGORY_FORUMS: "forums",
};

export interface GmailItemContext {
  /** The signed-in address. */
  me: string;
  /** What the account knows about the sender. */
  sender?: Person;
  protectedBecause?: string;
}

/** Turn a Gmail message into an item, with account facts about the sender. */
export function gmailItem(message: GmailMessage, context: GmailItemContext): GmailItem {
  const payload = message.payload;
  const from = parseAddresses(header(payload, "From"))[0] ?? { address: "unknown" };
  const to = parseAddresses(header(payload, "To"));
  const cc = parseAddresses(header(payload, "Cc"));
  const replyTo = parseAddresses(header(payload, "Reply-To"))[0];
  const subject = header(payload, "Subject")?.trim() ?? "";
  const snippet = decodeSnippet(message.snippet ?? "");
  const body = truncate(stripQuoted(bodyText(payload)));
  const labels = message.labelIds ?? [];
  const attachments = attachmentsOf(payload);
  const messageId = header(payload, "Message-ID") ?? header(payload, "Message-Id");
  const references = header(payload, "References");
  const category = labels.map((label) => CATEGORIES[label]).find((c) => c !== undefined);
  const precedence = header(payload, "Precedence")?.toLowerCase();
  const mailingList =
    header(payload, "List-Id") !== undefined ||
    header(payload, "List-Unsubscribe") !== undefined ||
    precedence === "bulk" ||
    precedence === "list";
  const me = context.me.toLowerCase();
  const isReply = header(payload, "In-Reply-To") !== undefined || /^(re|sv|aw|antw|vs):/i.test(subject);

  const facts: Record<string, JsonValue> = {
    toYouDirectly: to.some((address) => address.address.toLowerCase() === me),
    mailingList,
    isReply,
  };
  if (context.sender) facts.fromColleague = context.sender.colleague;
  if (context.sender?.emailedBefore !== undefined) facts.emailedBefore = context.sender.emailedBefore;
  if (attachments.length > 0) facts.attachments = attachments.map((a) => a.filename);
  if (category) facts.category = category;

  return {
    id: message.id,
    text: `${subject || "(no subject)"}\n\n${body || snippet}`.trim(),
    author: { id: from.address.toLowerCase(), name: from.name ?? from.address, email: from.address.toLowerCase() },
    at: new Date(Number(message.internalDate ?? Date.now())),
    facts,
    raw: message,
    threadId: message.threadId,
    subject,
    body,
    from,
    to,
    cc,
    ...(replyTo && replyTo.address.toLowerCase() !== from.address.toLowerCase() ? { replyTo } : {}),
    snippet,
    labels,
    unread: labels.includes("UNREAD"),
    attachments,
    ...(messageId ? { messageId } : {}),
    ...(references ? { references } : {}),
    ...(category ? { category } : {}),
    mailingList,
    ...(context.protectedBecause ? { protectedBecause: context.protectedBecause } : {}),
  };
}

/** What Jev sees: who wrote it, the subject and new text, and the account facts. */
export function describeEmail(item: GmailItem): JsonValue {
  return { from: formatAddress(item.from), subject: item.subject, body: item.body || item.snippet, ...item.facts };
}

/** Gmail's snippets are HTML-escaped. */
function decodeSnippet(snippet: string): string {
  return snippet
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
