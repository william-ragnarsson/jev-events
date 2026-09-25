export interface IrcMessage {
  tags: Record<string, string>;
  prefix?: string;
  command: string;
  params: string[];
}

const TAG_ESCAPES: Record<string, string> = { ":": ";", s: " ", "\\": "\\", r: "\r", n: "\n" };

/** Parse one IRCv3 line as sent by Twitch chat. */
export function parseIrcLine(line: string): IrcMessage | undefined {
  let rest = line.trim();
  if (!rest) return undefined;

  const tags: Record<string, string> = {};
  if (rest.startsWith("@")) {
    const space = rest.indexOf(" ");
    if (space === -1) return undefined;
    for (const pair of rest.slice(1, space).split(";")) {
      const equals = pair.indexOf("=");
      const key = equals === -1 ? pair : pair.slice(0, equals);
      const value = equals === -1 ? "" : pair.slice(equals + 1).replace(/\\(.)/g, (_, c: string) => TAG_ESCAPES[c] ?? c);
      tags[key] = value;
    }
    rest = rest.slice(space + 1);
  }

  let prefix: string | undefined;
  if (rest.startsWith(":")) {
    const space = rest.indexOf(" ");
    if (space === -1) return undefined;
    prefix = rest.slice(1, space);
    rest = rest.slice(space + 1);
  }

  let trailing: string | undefined;
  const trailingAt = rest.indexOf(" :");
  if (trailingAt !== -1) {
    trailing = rest.slice(trailingAt + 2);
    rest = rest.slice(0, trailingAt);
  }
  const parts = rest.split(" ").filter(Boolean);
  const command = parts.shift();
  if (!command) return undefined;
  return { tags, ...(prefix === undefined ? {} : { prefix }), command, params: trailing === undefined ? parts : [...parts, trailing] };
}
