import { silentLogger, type Logger, type Source, type SourceContext } from "jev-events";

import { isFatal, SlackApi, SlackApiError } from "./api.js";
import type { SlackAuth } from "./auth.js";
import { conversationLabel, Directory, kindFromChannelType, type SlackConversation } from "./directory.js";
import { handleEventsRequest } from "./events-api.js";
import { botAuthor, channelTypeOf, messageItem, type SlackMessageEvent, type SlackMessageItem } from "./item.js";
import { socketMode, type EventCallback } from "./socket.js";
import { mentionsIn } from "./text.js";

/** How new messages reach the source: Socket Mode, or Slack's Events API posting to your URL. */
export type Delivery = "socket" | "events";

export interface MessagesOptions {
  /** The connected workspace, e.g. `slack.auth.fromFile()`. */
  auth: SlackAuth;
  /** Only these channels, by name ("general" or "#general") or ID. Default: every conversation the app is in. */
  channels?: readonly string[];
  /** Also emit this many of the latest messages already there when starting. Default 0. */
  backfill?: number;
  /**
   * "socket" (Socket Mode) needs the app-level token and no public URL. "events" (the Events API) needs
   * the signing secret, and a public URL whose requests you pass to `source.handle()`. Default:
   * "socket" when there's an app-level token, otherwise "events".
   */
  delivery?: Delivery;
  /** Also judge messages from bots and integrations. The app's own messages are always skipped. Default false. */
  includeBots?: boolean;
}

export interface SlackSession {
  api: SlackApi;
  directory: Directory;
  /** The workspace's name. */
  team: string;
  teamId: string;
  /** The app's user (or yours, with a user token). */
  userId: string;
  /** Its handle, as in /invite @jev_events. */
  user: string;
  botId?: string;
  /** The workspace's address, e.g. "https://acme.slack.com/". */
  url: string;
  /** What's watched: the channels you named, or every conversation the app was in when it started. */
  conversations: SlackConversation[];
}

export interface SlackMessagesSource extends Source<SlackMessageItem, "slack"> {
  /** Set once the source has started. Actions use it. */
  readonly session: SlackSession | undefined;
  /**
   * For the Events API: pass each request Slack sends to your URL, and return the response.
   * Works as a Next.js route handler: `export const POST = (request) => source.handle(request)`.
   */
  handle(request: Request): Promise<Response>;
}

interface AuthTest {
  url: string;
  team: string;
  user: string;
  team_id: string;
  user_id: string;
  bot_id?: string;
}

/** Message subtypes that are someone saying something. Joins, topic changes and edits are skipped. */
const SAID = new Set([undefined, "file_share", "thread_broadcast", "me_message", "bot_message"]);
const SEEN_LIMIT = 5_000;
/** Backfill reads at most this many conversations. */
const BACKFILL_CONVERSATIONS = 20;

/** New messages in the channels, private channels and direct messages the Slack app is in. */
export function messages(options: MessagesOptions): SlackMessagesSource {
  let session: SlackSession | undefined;
  let deliver: ((payload: EventCallback) => void) | undefined;
  let log: Logger = silentLogger;
  const named = options.channels?.map((channel) => channel.trim().replace(/^#/, "")).filter(Boolean) ?? [];

  return {
    id: named.length > 0 ? `slack:${named.map((name) => `#${name}`).join(",")}` : "slack:messages",
    platform: "slack",
    noun: "message",
    canAct: true,
    get session() {
      return session;
    },
    async handle(request) {
      const signingSecret = options.auth.signingSecret;
      if (!signingSecret) {
        return Response.json(
          { error: "No signing secret. Pass it to receive Slack's Events API: slack.auth.withTokens({ token, signingSecret })." },
          { status: 500 },
        );
      }
      return handleEventsRequest(request, { signingSecret, deliver, log });
    },
    async start(ctx) {
      log = ctx.log;
      const delivery = chooseDelivery(options);
      const api = new SlackApi(options.auth.token);
      const me = await api.call<AuthTest>("auth.test");
      const directory = new Directory(api, me.team_id, (message) => ctx.log.warn(message));
      const watched = named.length > 0 ? await findChannels(directory, named, me.user) : undefined;
      const current: SlackSession = {
        api,
        directory,
        team: me.team,
        teamId: me.team_id,
        userId: me.user_id,
        user: me.user,
        ...(me.bot_id ? { botId: me.bot_id } : {}),
        url: me.url,
        conversations: watched ?? (await directory.mine()),
      };
      session = current;
      const only = watched ? new Set(watched.map((conversation) => conversation.id)) : undefined;

      /** Skip what isn't someone saying something: joins, edits, the app's own posts and, by default, bots. */
      const wanted = (event: SlackMessageEvent): boolean => {
        if (event.type !== "message" || event.hidden || !event.channel || !event.ts) return false;
        if (!SAID.has(event.subtype)) return false;
        if (only && !only.has(event.channel)) return false;
        if (event.user === current.userId || (event.bot_id !== undefined && event.bot_id === current.botId)) return false;
        if ((event.bot_id !== undefined || event.subtype === "bot_message") && !options.includeBots) return false;
        return Boolean(event.text?.trim() || event.files?.length);
      };

      // One at a time and in order, each message once, however it arrived.
      const seen = new Set<string>();
      let queue = Promise.resolve();
      const enqueue = (event: SlackMessageEvent) => {
        if (!wanted(event)) return;
        const id = `${event.channel}:${event.ts}`;
        if (seen.has(id)) return;
        seen.add(id);
        if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value as string);
        queue = queue.then(async () => {
          try {
            const item = await toItem(event, current);
            if (!ctx.signal.aborted) ctx.emit(item);
          } catch (error) {
            ctx.fail(error, { fatal: isFatal(error) });
          }
        });
      };

      // While the latest messages load, hold new ones back, so everything comes out oldest first.
      let held: SlackMessageEvent[] | undefined = options.backfill ? [] : undefined;
      const receive = (payload: EventCallback) => {
        const event = payload.event as SlackMessageEvent | undefined;
        if (event?.type !== "message") return;
        if (held) held.push(event);
        else enqueue(event);
      };

      if (delivery === "socket") {
        await socketMode({
          api: new SlackApi(options.auth.appToken as string),
          signal: ctx.signal,
          log: ctx.log,
          onEvent: receive,
          onFatal: (error) => ctx.fail(error, { fatal: true }),
        });
      }
      deliver = receive;
      ctx.signal.addEventListener("abort", () => (deliver = undefined), { once: true });

      if (options.backfill) {
        void latest(current, options.backfill, wanted, ctx)
          .then(
            (events) => events.forEach(enqueue),
            (error: unknown) => ctx.fail(error, { fatal: isFatal(error) }),
          )
          .finally(() => {
            const live = held ?? [];
            held = undefined;
            live.forEach(enqueue);
          });
      }
    },
  };
}

function chooseDelivery(options: MessagesOptions): Delivery {
  const { appToken, signingSecret } = options.auth;
  const delivery = options.delivery ?? (appToken ? "socket" : signingSecret ? "events" : undefined);
  if (!delivery) {
    throw new Error(
      "Slack needs a way to deliver new messages: an app-level token (xapp-…) for Socket Mode, or a signing secret for the Events API. npx jev-events auth slack sets up Socket Mode.",
    );
  }
  if (delivery === "socket" && !appToken) {
    throw new Error(
      "Socket Mode needs the app-level token (xapp-…): slack.auth.withTokens({ token, appToken }). Make one under Basic Information → App-Level Tokens, with the connections:write scope.",
    );
  }
  if (delivery === "events" && !signingSecret) {
    throw new Error("The Events API needs the app's signing secret, from Basic Information → App Credentials: slack.auth.withTokens({ token, signingSecret }).");
  }
  return delivery;
}

/** The named channels, which the app must be in to read. */
async function findChannels(directory: Directory, names: readonly string[], handle: string): Promise<SlackConversation[]> {
  const found = await Promise.all(names.map((name) => directory.find(name)));
  const outside = found.filter((conversation) => !conversation.member);
  if (outside.length > 0) {
    const labels = outside.map(conversationLabel).join(" and ");
    throw new Error(`The app (@${handle}) isn't in ${labels} yet. In Slack, open ${labels} and type: /invite @${handle}`);
  }
  return found;
}

/** The last `count` messages across the watched conversations, oldest first. */
async function latest(
  session: SlackSession,
  count: number,
  wanted: (event: SlackMessageEvent) => boolean,
  ctx: SourceContext<SlackMessageItem>,
): Promise<SlackMessageEvent[]> {
  const warned = new Set<string>();
  const perConversation = await Promise.all(
    session.conversations.slice(0, BACKFILL_CONVERSATIONS).map(async (conversation) => {
      try {
        const history = await session.api.call<{ messages?: SlackMessageEvent[] }>("conversations.history", {
          channel: conversation.id,
          limit: Math.min(200, Math.max(20, count * 4)),
        });
        return (history.messages ?? []).map((message) => ({ ...message, channel: conversation.id, channel_type: channelTypeOf(conversation.kind) }));
      } catch (error) {
        if (error instanceof SlackApiError && error.signedOut) throw error;
        const code = error instanceof SlackApiError ? error.code : "other";
        if (!warned.has(code)) {
          warned.add(code);
          ctx.log.warn(`Couldn't read the latest messages in ${conversationLabel(conversation)}: ${(error as Error).message}`);
        }
        return [];
      }
    }),
  );
  return perConversation
    .flat()
    .filter(wanted)
    .sort((a, b) => compareTs(a.ts, b.ts))
    .slice(-count);
}

/** Look up who wrote it, where, and the people and channels it mentions. */
async function toItem(event: SlackMessageEvent, session: SlackSession): Promise<SlackMessageItem> {
  const { directory } = session;
  const channelId = event.channel as string;
  const [channel, author] = await Promise.all([
    directory.conversation(channelId, kindFromChannelType(event.channel_type)),
    event.user ? directory.user(event.user) : Promise.resolve(botAuthor(event)),
  ]);
  const mentioned = mentionsIn(event.text ?? "");
  const names = new Map<string, string>();
  await Promise.all([
    ...mentioned.users.map(async (id) => names.set(id, (await directory.user(id)).name)),
    ...mentioned.channels.map(async (id) => {
      const conversation = await directory.conversation(id);
      if (conversation.name) names.set(id, conversation.name);
    }),
  ]);
  return messageItem(event, {
    channel,
    author,
    me: session.userId,
    teamId: session.teamId,
    url: session.url,
    names: (id) => names.get(id),
  });
}

/** Slack timestamps, "1712345678.123456", in order. */
function compareTs(a: string, b: string): number {
  const [aSeconds = "0", aMicros = ""] = a.split(".");
  const [bSeconds = "0", bMicros = ""] = b.split(".");
  return Number(aSeconds) - Number(bSeconds) || aMicros.padEnd(6, "0").localeCompare(bMicros.padEnd(6, "0"));
}
