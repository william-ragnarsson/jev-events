/** Reading Gmail's `format=full` messages: headers, addresses, the body as plain text, attachments. */

import { htmlToText } from "../text.js";

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}

/** A message as `users.messages.get?format=full` returns it. */
export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  /** Epoch milliseconds, as a string. */
  internalDate?: string;
  payload?: GmailPart;
}

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

/** A header's value, matched case-insensitively. */
export function header(part: GmailPart | undefined, name: string): string | undefined {
  const lower = name.toLowerCase();
  return part?.headers?.find((h) => h.name.toLowerCase() === lower)?.value;
}

/** "Ann Smith <ann@acme.com>", or just the address. */
export function formatAddress(address: EmailAddress): string {
  return address.name ? `${address.name} <${address.address}>` : address.address;
}

/** Decode RFC 2047 encoded words such as `=?UTF-8?B?w4VzYQ==?=`. */
export function decodeWords(value: string): string {
  const word = /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g;
  return value.replace(/(=\?[^?\s]+\?[BbQq]\?[^?\s]*\?=)\s+(?==\?)/g, "$1").replace(word, (whole, charset: string, encoding: string, text: string) => {
    try {
      const bytes =
        encoding.toUpperCase() === "B"
          ? Buffer.from(text, "base64")
          : Buffer.from(text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))), "latin1");
      return decodeBytes(bytes, charset);
    } catch {
      return whole;
    }
  });
}

/** Parse an address list: `"Smith, Ann" <ann@acme.com>, bob@example.com`. */
export function parseAddresses(value: string | undefined): EmailAddress[] {
  if (!value) return [];
  return splitAddressList(decodeWords(value))
    .map(parseMailbox)
    .filter((address): address is EmailAddress => address !== undefined);
}

function splitAddressList(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let angle = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i] as string;
    if (quoted && char === "\\") {
      current += char + (value[i + 1] ?? "");
      i++;
      continue;
    }
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === "<") angle = true;
    else if (!quoted && char === ">") angle = false;
    if (char === "," && !quoted && !angle) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.filter((part) => part.trim() !== "");
}

function parseMailbox(text: string): EmailAddress | undefined {
  const trimmed = text.trim().replace(/;$/, "");
  const angled = /^(.*)<([^<>]+)>$/s.exec(trimmed);
  if (angled) {
    const address = (angled[2] ?? "").trim();
    const name = (angled[1] ?? "")
      .trim()
      .replace(/^[^"]*:\s*/, "") // a group name, "Team: Ann <ann@acme.com>"
      .replace(/^"(.*)"$/s, "$1")
      .replace(/\\(.)/g, "$1")
      .trim();
    return address.includes("@") ? { ...(name && name !== address ? { name } : {}), address } : undefined;
  }
  const bare = trimmed
    .replace(/\(.*?\)/g, "")
    .replace(/^[^@]*:\s*/, "")
    .trim();
  return bare.includes("@") ? { address: bare } : undefined;
}

/** The message body as plain text: text/plain when there is one, otherwise the HTML turned into text. */
export function bodyText(payload: GmailPart | undefined): string {
  let plain: string | undefined;
  let html: string | undefined;
  walk(payload, (part) => {
    if (isAttachment(part) || !part.body?.data) return;
    const type = part.mimeType?.toLowerCase();
    if (type === "text/plain") plain ??= decodePart(part);
    else if (type === "text/html") html ??= decodePart(part);
  });
  if (plain?.trim()) return plain.replace(/\r\n?/g, "\n").trim();
  return html ? htmlToText(html) : "";
}

/** Files attached to the message. Images embedded in the HTML don't count. */
export function attachmentsOf(payload: GmailPart | undefined): Attachment[] {
  const found: Attachment[] = [];
  walk(payload, (part) => {
    if (isAttachment(part)) {
      found.push({ filename: part.filename as string, mimeType: part.mimeType ?? "application/octet-stream", size: part.body?.size ?? 0 });
    }
  });
  return found;
}

function walk(part: GmailPart | undefined, visit: (part: GmailPart) => void): void {
  if (!part) return;
  visit(part);
  for (const child of part.parts ?? []) walk(child, visit);
}

function isAttachment(part: GmailPart): boolean {
  if (!part.filename) return false;
  const embedded = header(part, "Content-ID") !== undefined && (part.mimeType ?? "").startsWith("image/");
  return !embedded;
}

function decodePart(part: GmailPart): string {
  const charset = /charset="?([^";\s]+)"?/i.exec(header(part, "Content-Type") ?? "")?.[1];
  return decodeBytes(Buffer.from(part.body?.data ?? "", "base64"), charset);
}

function decodeBytes(bytes: Uint8Array, charset = "utf-8"): string {
  try {
    return new TextDecoder((charset.split("*")[0] ?? "utf-8").trim()).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

// Word edges that also know letters like å and ł, which \b doesn't.
const OPENER = /^(on|le|am|el|il|em|op|den|på|w dniu)(?![\p{L}\p{N}])/iu;
const QUOTE_HEADER =
  /^(on|le|am|el|il|em|op|den|på|w dniu)(?![\p{L}\p{N}]).*(?<![\p{L}\p{N}])(wrote|a écrit|schrieb|escribió|ha scritto|escreveu|schreef|skrev|napisał)(?![\p{L}\p{N}]).*:\s*$/iu;
const ORIGINAL_MESSAGE = /^-{2,}\s*(original message|ursprüngliche nachricht|message d'origine|ursprungligt meddelande|mensaje original)\s*-{2,}\s*$/i;
const FORWARDED = /^(-{2,}\s*forwarded message\s*-*|begin forwarded message:?)\s*$/i;
const OUTLOOK_FROM = /^\*?(from|från|von|de|van):\*?\s/i;
const OUTLOOK_SENT = /^\*?(sent|date|skickat|datum|gesendet|envoyé|enviado):\*?\s/i;

/**
 * Cut the quoted conversation under a reply ("On Mon, Ann wrote:", Outlook's "From: … Sent: …"
 * block, "> " lines) so only the new text is judged. Forwarded messages are kept.
 */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] as string).trim();
    if (FORWARDED.test(line)) break;
    const next = lines[i + 1]?.trim() ?? "";
    const quoteHeader = QUOTE_HEADER.test(line) || (OPENER.test(line) && QUOTE_HEADER.test(`${line} ${next}`));
    const outlook = OUTLOOK_FROM.test(line) && lines.slice(i + 1, i + 4).some((l) => OUTLOOK_SENT.test(l.trim()));
    const rule = /^_{20,}$/.test(line) && OUTLOOK_FROM.test(next);
    if (quoteHeader || outlook || rule || ORIGINAL_MESSAGE.test(line)) {
      cut = i;
      break;
    }
  }
  const kept = lines.slice(0, cut).filter((line) => !line.startsWith(">"));
  const result = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return result || text.trim();
}
