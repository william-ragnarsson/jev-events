// Reading a public Twitch chat in the browser for the Try it page, the same way
// `twitchChat()` in jev-events reads it: anonymously, over Twitch's chat WebSocket. The parsing is
// a copy of packages/core/src/public, and apps/web/test/try.test.ts checks that both see the same
// messages.

/** A chat message, with what a monitor shows Jev about it. */
export interface ChatMessage {
  id: string;
  /** Display name. */
  author: string;
  login: string;
  text: string;
  roles: string[];
  /** The chatter's first message in this channel. */
  firstMessage: boolean;
  /** The message this one replies to. */
  replyingTo?: { author: string; text: string };
  /** The colour the chatter picked for their name, like "#1E90FF". Only the page shows it. */
  color?: string;
}

// Twitch paths that aren't channels, such as twitch.tv/directory.
const NOT_CHANNELS = new Set(['directory', 'videos', 'search', 'settings', 'downloads', 'jobs', 'p', 'turbo', 'wallet', 'drops', 'inventory']);

/**
 * The channel in a name or a link: "xqc", "#xqc", "twitch.tv/xqc" and
 * "https://www.twitch.tv/xqc?sr=a" all give "xqc". Undefined when there's no channel in it.
 */
export function channelLogin(input: string): string | undefined {
  let value = input.trim();
  if (/twitch\.tv/i.test(value)) {
    let url: URL;
    try {
      url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    } catch {
      return undefined;
    }
    if (!/^(www\.|m\.)?twitch\.tv$/i.test(url.hostname)) return undefined;
    const parts = url.pathname.split('/').filter(Boolean);
    // Pop-out and moderator views put the channel second: twitch.tv/popout/xqc/chat.
    value = (['popout', 'embed', 'moderator'].includes(parts[0] ?? '') ? parts[1] : parts[0]) ?? '';
  }
  const login = value.replace(/^[#@]/, '').toLowerCase();
  return /^[a-z0-9_]{1,25}$/.test(login) && !NOT_CHANNELS.has(login) ? login : undefined;
}

export interface IrcMessage {
  tags: Record<string, string>;
  prefix?: string;
  command: string;
  params: string[];
}

const TAG_ESCAPES: Record<string, string> = { ':': ';', s: ' ', '\\': '\\', r: '\r', n: '\n' };

/** Parse one IRCv3 line as sent by Twitch chat. */
export function parseIrcLine(line: string): IrcMessage | undefined {
  let rest = line.trim();
  if (!rest) return undefined;

  const tags: Record<string, string> = {};
  if (rest.startsWith('@')) {
    const space = rest.indexOf(' ');
    if (space === -1) return undefined;
    for (const pair of rest.slice(1, space).split(';')) {
      const equals = pair.indexOf('=');
      const key = equals === -1 ? pair : pair.slice(0, equals);
      tags[key] = equals === -1 ? '' : pair.slice(equals + 1).replace(/\\(.)/g, (_, c: string) => TAG_ESCAPES[c] ?? c);
    }
    rest = rest.slice(space + 1);
  }

  let prefix: string | undefined;
  if (rest.startsWith(':')) {
    const space = rest.indexOf(' ');
    if (space === -1) return undefined;
    prefix = rest.slice(1, space);
    rest = rest.slice(space + 1);
  }

  let trailing: string | undefined;
  const trailingAt = rest.indexOf(' :');
  if (trailingAt !== -1) {
    trailing = rest.slice(trailingAt + 2);
    rest = rest.slice(0, trailingAt);
  }
  const parts = rest.split(' ').filter(Boolean);
  const command = parts.shift();
  if (!command) return undefined;
  return { tags, ...(prefix === undefined ? {} : { prefix }), command, params: trailing === undefined ? parts : [...parts, trailing] };
}

/** Twitch badges as the roles Jev Events uses. */
function rolesFromBadges(badges: Iterable<string>): string[] {
  const roles = new Set<string>();
  for (const badge of badges) {
    if (badge === 'broadcaster') roles.add('broadcaster');
    else if (badge === 'moderator' || badge === 'lead_moderator') roles.add('moderator');
    else if (badge === 'vip') roles.add('vip');
    else if (badge === 'subscriber' || badge === 'founder') roles.add('subscriber');
    else if (badge === 'staff' || badge === 'admin' || badge === 'global_mod') roles.add('staff');
  }
  return [...roles];
}

/** The chat message in a PRIVMSG, or undefined for anything else. */
export function chatMessage(message: IrcMessage): ChatMessage | undefined {
  if (message.command !== 'PRIVMSG') return undefined;
  let text = message.params[1] ?? '';
  const action = /^\u0001ACTION (.*)\u0001$/.exec(text);
  if (action) text = action[1] ?? '';

  const { tags } = message;
  const login = message.prefix?.split('!')[0] ?? tags.login ?? '';
  const badges = (tags.badges ?? '').split(',').filter(Boolean).map((badge) => badge.split('/')[0] ?? '');
  if (tags.mod === '1') badges.push('moderator');
  const replyingTo =
    tags['reply-parent-msg-body'] !== undefined
      ? { author: tags['reply-parent-display-name'] ?? tags['reply-parent-user-login'] ?? '', text: tags['reply-parent-msg-body'] }
      : undefined;

  return {
    id: tags.id ?? `${login}-${tags['tmi-sent-ts'] ?? Math.random()}`,
    author: tags['display-name'] || login,
    login,
    text,
    roles: rolesFromBadges(badges),
    firstMessage: tags['first-msg'] === '1',
    ...(replyingTo ? { replyingTo } : {}),
    ...(/^#[0-9a-f]{6}$/i.test(tags.color ?? '') ? { color: tags.color } : {}),
  };
}

/** Chat bots whose messages a monitor skips by default. */
export const KNOWN_BOTS = [
  'nightbot',
  'streamelements',
  'fossabot',
  'moobot',
  'streamlabs',
  'wizebot',
  'sery_bot',
  'soundalerts',
  'botrixoficial',
  'kofistreambot',
  'pokemoncommunitygame',
];

/** "!commands" and well-known bots never reach Jev, as in a monitor. */
export function ignoredChat(message: ChatMessage): boolean {
  return message.text.startsWith('!') || KNOWN_BOTS.includes(message.login.toLowerCase());
}
