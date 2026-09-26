/** A reference in Slack's message text, such as <@U123>, <#C123|general> or <https://x.com|x>. */
const REFERENCE = /<([^<>\n]+)>/g;

export interface Mentions {
  /** User IDs mentioned with @. */
  users: string[];
  /** Channel IDs mentioned with #. */
  channels: string[];
  /** Uses @here, @channel or @everyone. */
  everyone: boolean;
}

/** Who and which channels a message's text mentions. */
export function mentionsIn(text: string): Mentions {
  const users = new Set<string>();
  const channels = new Set<string>();
  let everyone = false;
  for (const [, inner = ""] of text.matchAll(REFERENCE)) {
    const target = inner.split("|")[0] ?? "";
    if (/^@[UW][A-Z0-9]+$/.test(target)) users.add(target.slice(1));
    else if (/^#[CGD][A-Z0-9]+$/.test(target)) channels.add(target.slice(1));
    else if (/^!(here|channel|everyone)$/.test(target)) everyone = true;
  }
  return { users: [...users], channels: [...channels], everyone };
}

/**
 * Slack's message text as plain text: mentions become @Name and #channel, links become
 * "label (url)", and &lt; &gt; &amp; are decoded. `names` looks up people and channels by ID.
 */
export function mrkdwnToText(text: string, names: (id: string) => string | undefined = () => undefined): string {
  const plain = text.replace(REFERENCE, (_reference, inner: string) => {
    const bar = inner.indexOf("|");
    const target = bar === -1 ? inner : inner.slice(0, bar);
    const label = bar === -1 ? "" : inner.slice(bar + 1);
    if (target.startsWith("@")) return `@${names(target.slice(1)) ?? (label.replace(/^@/, "") || target.slice(1))}`;
    if (target.startsWith("#")) return `#${names(target.slice(1)) ?? (label.replace(/^#/, "") || target.slice(1))}`;
    if (target.startsWith("!")) return special(target.slice(1), label);
    return link(target, label);
  });
  return plain.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** <!here>, <!subteam^S123|@devs>, <!date^1392734382^{date_short}|Feb 18, 2014> and the like. */
function special(command: string, label: string): string {
  const [keyword = ""] = command.split("^");
  if (keyword === "here" || keyword === "channel" || keyword === "everyone") return `@${keyword}`;
  if (keyword === "subteam") return label ? `@${label.replace(/^@/, "")}` : "@group";
  return label;
}

function link(url: string, label: string): string {
  const address = url.startsWith("mailto:") ? url.slice("mailto:".length) : url;
  if (!label || label === address || label === url || url.replace(/^https?:\/\//, "") === label) return address;
  return `${label} (${address})`;
}
