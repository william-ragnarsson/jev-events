/** Plain text from mail, chat messages and event descriptions, for Jev to read. */

/** Quoted replies are cut and bodies are capped at this many characters, so Jev reads what's new. */
export const MAX_BODY_CHARS = 4_000;

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", copy: "©", reg: "®", trade: "™", euro: "€", pound: "£",
  bull: "•", middot: "·", zwnj: "", zwj: "", shy: "", szlig: "ß", aelig: "æ", AElig: "Æ", oslash: "ø", Oslash: "Ø",
};

/** `&auml;`, `&Aring;`, `&eacute;`…: a letter plus an accent, as in Swedish, German and French mail. */
const ACCENTS: Record<string, string> = {
  acute: "\u0301", grave: "\u0300", circ: "\u0302", uml: "\u0308", tilde: "\u0303", ring: "\u030a", cedil: "\u0327",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity.startsWith("#")) {
      const code = entity[1] === "x" || entity[1] === "X" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    const accented = /^([a-z])(acute|grave|circ|uml|tilde|ring|cedil)$/i.exec(entity);
    if (accented) return `${accented[1]}${ACCENTS[(accented[2] as string).toLowerCase()]}`.normalize("NFC");
    return ENTITIES[entity] ?? ENTITIES[entity.toLowerCase()] ?? whole;
  });
}

/**
 * HTML mail as readable text. Links keep their site next to the text, "Log in (paypa1.xyz)", so a
 * question about phishing can see where a link really goes.
 */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<(head|style|script|title)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s+/g, " ")
    .replace(/<a\b[^>]*?href\s*=\s*["']?https?:\/\/([^/"'\s>:?#]+)[^>]*>([\s\S]*?)<\/a\s*>/gi, (_, host: string, inner: string) => {
      const label = inner.replace(/<[^>]+>/g, "").trim();
      const site = host.toLowerCase().replace(/^www\./, "");
      return label && !label.toLowerCase().includes(site) ? `${label} (${site})` : label;
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/?(p|div|h[1-6]|ul|ol|tr|table|blockquote|section|article|header|footer)\b[^>]*>/gi, "\n")
    .replace(/<\/t[dh]\s*>/gi, " ")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(text)
    .replace(/[͏​-‍⁠﻿­]/g, "")
    .replace(/[ \t ]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Cap text at `max` characters, ending with "…" when cut. */
export function truncate(text: string, max = MAX_BODY_CHARS): string {
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
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
