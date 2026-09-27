import type { Author, Item, JsonValue } from "jev-events";

import type { Person } from "../protect.js";
import {
  attachmentsOf,
  bodyText,
  formatAddress,
  header,
  toAddress,
  toAddresses,
  type Attachment,
  type EmailAddress,
  type OutlookMessage,
} from "./message.js";

export type Importance = "low" | "normal" | "high";

/** One email, as the Outlook source emits it. */
export interface OutlookItem extends Item<OutlookMessage> {
  /** `id` and `email` are the sender's address. */
  author: Author & { email: string };
  conversationId: string;
  subject: string;
  /** The new text: quoted replies cut, capped at 4,000 characters. */
  body: string;
  from: EmailAddress;
  to: EmailAddress[];
  cc: EmailAddress[];
  /** Where replies go when it isn't `from`. */
  replyTo?: EmailAddress;
  /** Outlook's short preview of the body. */
  preview: string;
  /** Outlook categories on the email, such as "Red category" or ones you named. */
  categories: string[];
  unread: boolean;
  flagged: boolean;
  importance: Importance;
  /** Focused Inbox's verdict: true for Focused, false for Other. */
  focused?: boolean;
  attachments: Attachment[];
  /** Sent through a mailing list or bulk sender (List-Id, List-Unsubscribe or Precedence: bulk). */
  mailingList: boolean;
  /** Opens the email in Outlook on the web. */
  link?: string;
  /** Why native actions skip this email, e.g. "colleague at acme.com". */
  protectedBecause?: string;
}

export interface OutlookItemContext {
  /** The signed-in address. */
  me: string;
  /** What the account knows about the sender. */
  sender?: Person;
  protectedBecause?: string;
}

/** Turn a Graph message into an item, with account facts about the sender. */
export function outlookItem(message: OutlookMessage, context: OutlookItemContext): OutlookItem {
  const from = senderOf(message) ?? { address: "unknown" };
  const to = toAddresses(message.toRecipients);
  const cc = toAddresses(message.ccRecipients);
  const replyTo = toAddresses(message.replyTo)[0];
  const subject = message.subject?.trim() ?? "";
  const preview = message.bodyPreview?.trim() ?? "";
  const body = bodyText(message);
  const attachments = attachmentsOf(message);
  const importance = message.importance ?? "normal";
  const focused = message.inferenceClassification === undefined ? undefined : message.inferenceClassification === "focused";
  const precedence = header(message, "Precedence")?.toLowerCase();
  const mailingList =
    header(message, "List-Id") !== undefined ||
    header(message, "List-Unsubscribe") !== undefined ||
    precedence === "bulk" ||
    precedence === "list";
  const me = context.me.toLowerCase();
  const isReply = header(message, "In-Reply-To") !== undefined || /^(re|sv|aw|antw|vs):/i.test(subject);

  const facts: Record<string, JsonValue> = {
    toYouDirectly: me !== "" && to.some((address) => address.address.toLowerCase() === me),
    mailingList,
    isReply,
  };
  if (context.sender) facts.fromColleague = context.sender.colleague;
  if (context.sender?.emailedBefore !== undefined) facts.emailedBefore = context.sender.emailedBefore;
  if (attachments.length > 0) facts.attachments = attachments.map((a) => a.filename);
  if (importance !== "normal") facts.importance = importance;
  if (focused !== undefined) facts.focused = focused;

  const address = from.address.toLowerCase();
  return {
    id: message.id,
    text: `${subject || "(no subject)"}\n\n${body || preview}`.trim(),
    author: { id: address, name: from.name ?? from.address, email: address },
    at: new Date(message.receivedDateTime ?? Date.now()),
    facts,
    raw: message,
    conversationId: message.conversationId ?? message.id,
    subject,
    body,
    from,
    to,
    cc,
    ...(replyTo && replyTo.address.toLowerCase() !== address ? { replyTo } : {}),
    preview,
    categories: message.categories ?? [],
    unread: message.isRead === false,
    flagged: message.flag?.flagStatus === "flagged",
    importance,
    ...(focused !== undefined ? { focused } : {}),
    attachments,
    mailingList,
    ...(message.webLink ? { link: message.webLink } : {}),
    ...(context.protectedBecause ? { protectedBecause: context.protectedBecause } : {}),
  };
}

/** Who wrote it: `from`, else the account that sent it. */
export function senderOf(message: OutlookMessage): EmailAddress | undefined {
  return toAddress(message.from) ?? toAddress(message.sender);
}

/** What Jev sees: who wrote it, the subject and new text, and the account facts. */
export function describeEmail(item: OutlookItem): JsonValue {
  return { from: formatAddress(item.from), subject: item.subject, body: item.body || item.preview, ...item.facts };
}
