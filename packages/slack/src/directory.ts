import { isFatal, type SlackApi } from "./api.js";

export type ConversationKind = "channel" | "private" | "dm" | "group-dm";

export interface SlackConversation {
  id: string;
  /** "general". Direct messages have none. */
  name?: string;
  kind: ConversationKind;
  /** Whether the app is in it, so it can read and post there. */
  member: boolean;
  /** A direct message: the other person's user ID. */
  user?: string;
}

export interface SlackUser {
  id: string;
  /** Display name, else full name, else handle. */
  name: string;
  /** The handle, as in @ann. */
  handle?: string;
  /** A single- or multi-channel guest of the workspace. */
  guest: boolean;
  /** From another organization, through Slack Connect. */
  external: boolean;
  bot: boolean;
  /** "owner", "admin", "guest" or "bot". */
  roles: string[];
}

export interface ApiUser {
  id: string;
  team_id?: string;
  name?: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  is_admin?: boolean;
  is_owner?: boolean;
  is_primary_owner?: boolean;
  is_restricted?: boolean;
  is_ultra_restricted?: boolean;
  profile?: { display_name?: string; real_name?: string };
}

export interface ApiConversation {
  id: string;
  name?: string;
  is_channel?: boolean;
  is_group?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
  is_member?: boolean;
  is_archived?: boolean;
  user?: string;
}

const ALL_TYPES = "public_channel,private_channel,mpim,im";

/** People and conversations in the workspace, looked up once and remembered. */
export class Directory {
  readonly #api: SlackApi;
  readonly #teamId: string;
  readonly #warn: (message: string) => void;
  readonly #users = new Map<string, Promise<SlackUser>>();
  readonly #conversations = new Map<string, Promise<SlackConversation>>();
  readonly #warned = new Set<string>();

  constructor(api: SlackApi, teamId: string, warn: (message: string) => void = () => {}) {
    this.#api = api;
    this.#teamId = teamId;
    this.#warn = warn;
  }

  /** A person by user ID. When Slack can't say, the ID stands in for the name. */
  user(id: string): Promise<SlackUser> {
    const cached = this.#users.get(id);
    if (cached) return cached;
    const user = this.#api.call<{ user: ApiUser }>("users.info", { user: id }).then(
      (response) => toUser(response.user, this.#teamId),
      (error: unknown) => {
        this.#users.delete(id);
        if (isFatal(error)) throw error;
        this.#warnOnce("users.info", `Couldn't look up Slack user ${id}: ${(error as Error).message}`);
        return { id, name: id, guest: false, external: false, bot: false, roles: [] };
      },
    );
    this.#users.set(id, user);
    return user;
  }

  /** A conversation by ID. When Slack can't say, `kind` stands in. */
  conversation(id: string, kind?: ConversationKind): Promise<SlackConversation> {
    const cached = this.#conversations.get(id);
    if (cached) return cached;
    const conversation = this.#api.call<{ channel: ApiConversation }>("conversations.info", { channel: id }).then(
      (response) => toConversation(response.channel),
      (error: unknown) => {
        this.#conversations.delete(id);
        if (isFatal(error)) throw error;
        this.#warnOnce("conversations.info", `Couldn't look up Slack conversation ${id}: ${(error as Error).message}`);
        return { id, kind: kind ?? kindFromId(id), member: true };
      },
    );
    this.#conversations.set(id, conversation);
    return conversation;
  }

  /** Every conversation the app is in: channels, private channels and direct messages. */
  async mine(): Promise<SlackConversation[]> {
    const listed = await this.#api.list<ApiConversation>("users.conversations", "channels", { types: ALL_TYPES, exclude_archived: true });
    const conversations = listed.map((c) => toConversation({ is_member: true, ...c }));
    for (const conversation of conversations) this.#conversations.set(conversation.id, Promise.resolve(conversation));
    return conversations;
  }

  /** A channel by name ("general" or "#general") or ID. */
  async find(channel: string): Promise<SlackConversation> {
    const wanted = channel.trim().replace(/^#/, "");
    if (/^[CGD][A-Z0-9]{6,}$/.test(wanted)) {
      const response = await this.#api.call<{ channel: ApiConversation }>("conversations.info", { channel: wanted });
      return this.#remember(toConversation(response.channel));
    }
    const name = wanted.toLowerCase();
    let cursor: string | undefined;
    do {
      const page = await this.#api.call<{ channels?: ApiConversation[] }>("conversations.list", {
        types: "public_channel,private_channel",
        exclude_archived: true,
        limit: 1_000,
        cursor,
      });
      const match = page.channels?.find((c) => c.name === name);
      if (match) return this.#remember(toConversation(match));
      cursor = page.response_metadata?.next_cursor || undefined;
    } while (cursor);
    throw new Error(`There's no #${name} channel that the app can see. If it's private, invite the app to it first.`);
  }

  #remember(conversation: SlackConversation): SlackConversation {
    this.#conversations.set(conversation.id, Promise.resolve(conversation));
    return conversation;
  }

  #warnOnce(method: string, message: string): void {
    if (this.#warned.has(method)) return;
    this.#warned.add(method);
    this.#warn(message);
  }
}

export function toUser(user: ApiUser, teamId: string): SlackUser {
  const name = user.profile?.display_name || user.profile?.real_name || user.real_name || user.name || user.id;
  const guest = Boolean(user.is_restricted || user.is_ultra_restricted);
  const bot = Boolean(user.is_bot);
  const roles = [
    ...(user.is_owner || user.is_primary_owner ? ["owner"] : user.is_admin ? ["admin"] : []),
    ...(guest ? ["guest"] : []),
    ...(bot ? ["bot"] : []),
  ];
  return {
    id: user.id,
    name,
    ...(user.name ? { handle: user.name } : {}),
    guest,
    external: Boolean(user.team_id && user.team_id !== teamId),
    bot,
    roles,
  };
}

export function toConversation(conversation: ApiConversation): SlackConversation {
  const kind: ConversationKind = conversation.is_im
    ? "dm"
    : conversation.is_mpim
      ? "group-dm"
      : conversation.is_private || conversation.is_group
        ? "private"
        : "channel";
  const named = (kind === "channel" || kind === "private") && conversation.name;
  return {
    id: conversation.id,
    ...(named ? { name: conversation.name } : {}),
    kind,
    // Slack leaves it out for direct messages, which you can only see when you're in them.
    member: conversation.is_member ?? (kind === "dm" || kind === "group-dm"),
    ...(conversation.user ? { user: conversation.user } : {}),
  };
}

/** Slack's `channel_type` on message events. */
export function kindFromChannelType(channelType: string | undefined): ConversationKind | undefined {
  switch (channelType) {
    case "channel":
      return "channel";
    case "group":
      return "private";
    case "im":
      return "dm";
    case "mpim":
      return "group-dm";
    default:
      return undefined;
  }
}

function kindFromId(id: string): ConversationKind {
  return id.startsWith("D") ? "dm" : id.startsWith("G") ? "private" : "channel";
}

/** "#general", "a DM" or "a group DM", for messages and facts. */
export function conversationLabel(conversation: SlackConversation): string {
  if (conversation.kind === "dm") return "DM";
  if (conversation.kind === "group-dm") return "group DM";
  return `#${conversation.name ?? conversation.id}`;
}
