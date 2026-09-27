/** Reading Graph messages: addresses, headers, the body as plain text, attachments. */

import { htmlToText, stripQuoted, truncate } from "../text.js";

export interface GraphRecipient {
  emailAddress?: { name?: string | null; address?: string | null } | null;
}

export interface GraphBody {
  contentType?: string;
  content?: string | null;
}

export interface GraphAttachment {
  name?: string | null;
  contentType?: string | null;
  /** Bytes. */
  size?: number;
  /** A picture in the body, such as a logo in a signature. */
  isInline?: boolean;
}

/** A message as `GET /me/messages/{id}` returns it, with the fields the source asks for. */
export interface OutlookMessage {
  id: string;
  receivedDateTime?: string;
  subject?: string | null;
  from?: GraphRecipient | null;
  sender?: GraphRecipient | null;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  replyTo?: GraphRecipient[];
  bodyPreview?: string;
  body?: GraphBody;
  /** The part of the body that isn't quoted from earlier messages. */
  uniqueBody?: GraphBody;
  categories?: string[];
  isRead?: boolean;
  isDraft?: boolean;
  hasAttachments?: boolean;
  importance?: "low" | "normal" | "high";
  conversationId?: string;
  internetMessageId?: string;
  /** Only on mail that came in over the internet, not mail from inside your organization. */
  internetMessageHeaders?: Array<{ name: string; value: string }>;
  /** Focused Inbox's verdict. */
  inferenceClassification?: "focused" | "other";
  flag?: { flagStatus?: "notFlagged" | "flagged" | "complete" };
  parentFolderId?: string;
  webLink?: string;
  /** Read separately when `hasAttachments` is set. */
  attachments?: GraphAttachment[];
}

/** What the source asks Graph for. */
export const MESSAGE_FIELDS = [
  "id",
  "receivedDateTime",
  "subject",
  "from",
  "sender",
  "toRecipients",
  "ccRecipients",
  "replyTo",
  "bodyPreview",
  "body",
  "uniqueBody",
  "categories",
  "isRead",
  "isDraft",
  "hasAttachments",
  "importance",
  "conversationId",
  "internetMessageId",
  "internetMessageHeaders",
  "inferenceClassification",
  "flag",
  "parentFolderId",
  "webLink",
].join(",");

/** Asks Graph for bodies as plain text rather than HTML. */
export const TEXT_BODIES = 'outlook.body-content-type="text"';

export interface EmailAddress {
  name?: string;
  address: string;
}

export interface Attachment {
  filename: string;
  mimeType: string;
  /** Bytes. */
  size: number;
}

/** A Graph recipient as an address. Graph repeats the address as the name when there is none. */
export function toAddress(recipient: GraphRecipient | null | undefined): EmailAddress | undefined {
  const address = recipient?.emailAddress?.address?.trim();
  if (!address) return undefined;
  const name = recipient?.emailAddress?.name?.trim();
  return name && name.toLowerCase() !== address.toLowerCase() ? { name, address } : { address };
}

export function toAddresses(recipients: GraphRecipient[] | undefined): EmailAddress[] {
  return (recipients ?? []).map(toAddress).filter((address): address is EmailAddress => address !== undefined);
}

/** "Ann Smith <ann@acme.com>", or just the address. */
export function formatAddress(address: EmailAddress): string {
  return address.name ? `${address.name} <${address.address}>` : address.address;
}

/** A header's value, matched case-insensitively. */
export function header(message: OutlookMessage, name: string): string | undefined {
  const lower = name.toLowerCase();
  return message.internetMessageHeaders?.find((h) => h.name.toLowerCase() === lower)?.value;
}

/** The new text as plain text: quoted replies cut, capped at 4,000 characters. */
export function bodyText(message: OutlookMessage): string {
  return truncate(stripQuoted(plain(message.uniqueBody) || plain(message.body)));
}

function plain(body: GraphBody | undefined): string {
  const content = body?.content ?? "";
  const text = body?.contentType?.toLowerCase() === "html" ? htmlToText(content) : content;
  return text.replace(/\r\n?/g, "\n").trim();
}

/** Files attached to the message. Pictures in the body are left out. */
export function attachmentsOf(message: OutlookMessage): Attachment[] {
  return (message.attachments ?? [])
    .filter((attachment) => !attachment.isInline)
    .map((attachment) => ({
      filename: attachment.name || "attachment",
      mimeType: attachment.contentType || "application/octet-stream",
      size: attachment.size ?? 0,
    }));
}
