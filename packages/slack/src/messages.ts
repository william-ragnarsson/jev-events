import { needsSignIn, type ConnectedSource, type PushContext, type SessionContext, type SourceContext } from "jev-events";

import { isFatal, SlackApi, SlackApiError } from "./api.js";
import type { SlackApp } from "./app.js";
import { tokensOf } from "./auth.js";
import { conversationLabel, Directory, kindFromChannelType, type SlackConversation } from "./directory.js";
import { handleEventsRequest } from "./events-api.js";
import { botAuthor, channelTypeOf, messageItem, type SlackMessageEvent, type SlackMessageItem } from "./item.js";
import { sharedSocket, teamsOf, type EventCallback } from "./socket.js";
import { mentionsIn } from "./text.js";

export interface MessagesOptions {
  /** Only these channels, by name ("general" or "#general") or ID. Default: every conversation the app is in. */
  channels?: readonly string[];
  /** Also emit this many of the latest messages already there when starting. Default 0. */
  backfill?: number;
  /** Also judge messages from bots and integrations. The app's own messages are always skipped. Default false. */
  includeBots?: boolean;
}

/** What the messages source and the Slack actions use for one connected workspace. */
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
  /** What's watched once the source has started: the channels you named, or every conversation the app was in. */
  conversations?: SlackConversation[];
}

export type SlackMessagesSource = ConnectedSource<SlackMessageItem, "slack", SlackSession>;

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

const NO_SIGNING_SECRET =
  "Slack's Events API needs your app's signing secret, from Basic Information → App Credentials: set SLACK_SIGNING_SECRET, or pass runtime({ apps: [slack.app({ signingSecret })] }).";

/** App-level tokens by session, kept out of the session itself so handlers never see them. */
const appTokens = new WeakMap<SlackSession, string>();

/**
 * New messages in the channels, private channels and direct messages the Slack app is in, in each
 * connected workspace. They arrive over Socket Mode when the connection (or `slack.app()`) has an
 * app-level token, and otherwise through the Events API at your runtime's `/webhook/slack`.
 */
export function messages(options: MessagesOptions = {}): SlackMessagesSource {
  const named = options.channels?.map((channel) => channel.trim().replace(/^#/, "")).filter(Boolean) ?? [];
  const id = named.length > 0 ? `slack:${named.map((name) => `#${name}`).join(",")}` : "slack:messages";
  const strangers = new Set<string>();

  /** Named channels by ID or name. The app gets events only from conversations it's in. */
  const watches = async (session: SlackSession, channel: string): Promise<boolean> => {
    if (named.length === 0 || named.includes(channel)) return true;
    const conversation = await session.directory.conversation(channel);
    return conversation.name !== undefined && named.includes(conversation.name);
  };

  return {
    id,
    platform: "slack",
    noun: "message",
    canAct: true,
    integration: "slack",
    session: (ctx) => openSession(ctx, id),
    async start(ctx) {
      const session = ctx.session;
      const watched = named.length > 0 ? await findChannels(session.directory, named, session.user) : undefined;
      session.conversations = watched ?? (await session.directory.mine());
      const only = watched ? new Set(watched.map((conversation) => conversation.id)) : undefined;
      const wanted = (event: SlackMessageEvent) => said(event, session, options) && (!only || only.has(event.channel as string));

      // One at a time and in order, each message once, however it arrived.
      const seen = new Set<string>();
      let queue = Promise.resolve();
      const enqueue = (event: SlackMessageEvent) => {
        if (!wanted(event)) return;
        const key = `${event.channel}:${event.ts}`;
        if (seen.has(key)) return;
        seen.add(key);
        if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value as string);
        queue = queue.then(async () => {
          if (ctx.signal.aborted) return;
          try {
            await ctx.emit(await toItem(event, session));
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

      const appToken = appTokens.get(session);
      if (appToken) {
        await sharedSocket({
          appToken,
          api: new SlackApi(appToken),
          teamId: session.teamId,
          signal: ctx.signal,
          log: ctx.log,
          onEvent: receive,
          onFatal: (error) => ctx.fail(error, { fatal: true }),
        });
      } else {
        ctx.log.info(`slack: ${session.team} has no app-level token, so its new messages come through the Events API at /webhook/slack.`);
      }

      if (!options.backfill) {
        ctx.end();
        return;
      }
      void latest(session, options.backfill, wanted, ctx)
        .then(
          (events) => events.forEach(enqueue),
          (error: unknown) => ctx.fail(error, { fatal: isFatal(error) }),
        )
        .finally(() => {
          const live = held ?? [];
          held = undefined;
          live.forEach(enqueue);
          queue = queue.then(() => ctx.end());
        });
    },
    async receive(request, ctx) {
      const app = ctx.app as Partial<SlackApp> | undefined;
      const signingSecret = app?.signingSecret ?? (process.env.SLACK_SIGNING_SECRET || undefined);
      if (!signingSecret) {
        ctx.log.error(NO_SIGNING_SECRET);
        return Response.json({ error: NO_SIGNING_SECRET }, { status: 500 });
      }
      const payloads: EventCallback[] = [];
      const response = await handleEventsRequest(request, { signingSecret, deliver: (payload) => payloads.push(payload), log: ctx.log });
      for (const payload of payloads) await pushed(payload, ctx);
      return response;
    },
  };

  /** Hand an event from the Events API to the connections of its workspace. */
  async function pushed(payload: EventCallback, ctx: PushContext<SlackMessageItem, SlackSession>): Promise<void> {
    const event = payload.event as SlackMessageEvent | undefined;
    if (event?.type !== "message" || !event.channel) return;
    const teams = teamsOf(payload);
    const failures: unknown[] = [];
    let matched = false;
    for (const connection of await ctx.connections()) {
      const saved = connection.facts?.teamId;
      if (typeof saved === "string" && teams.length > 0 && !teams.includes(saved)) continue;
      try {
        const session = await ctx.session(connection);
        if (teams.length > 0 && !teams.includes(session.teamId)) continue;
        matched = true;
        if (!said(event, session, options) || !(await watches(session, event.channel))) continue;
        await ctx.emit(connection, await toItem(event, session));
      } catch (error) {
        await ctx.fail(connection, error);
        // Slack sends the event again after an error, which won't help while the token is revoked or
        // a scope is missing. Answering errors too often makes Slack turn the app's events off.
        if (!isFatal(error) && !needsSignIn(error)) failures.push(error);
        matched = true;
      }
    }
    const team = teams[0];
    if (!matched && team && !strangers.has(team)) {
      strangers.add(team);
      ctx.log.warn(`slack: an event came in from workspace ${team}, which isn't connected. Connect it with /connect/slack.`);
    }
    // What was already judged is skipped when Slack sends it again.
    if (failures.length > 0) throw failures[0];
  }
}

/** The API client and who the app is in the connected workspace. */
async function openSession(ctx: SessionContext, source: string): Promise<SlackSession> {
  const { connection } = ctx;
  if (!connection) {
    throw new Error(`${source} reads connected Slack workspaces, so it needs a connection. Connect one with npx jev-events auth slack, or pass connections to start().`);
  }
  const { token, appToken: saved } = tokensOf(connection);
  const app = ctx.app as Partial<SlackApp> | undefined;
  const appToken = saved ?? app?.appToken ?? (process.env.SLACK_APP_TOKEN || undefined);
  const api = new SlackApi(token);
  const me = savedIdentity(connection.facts) ?? (await api.call<AuthTest>("auth.test"));
  const session: SlackSession = {
    api,
    directory: new Directory(api, me.team_id, (message) => ctx.log.warn(message)),
    team: me.team,
    teamId: me.team_id,
    userId: me.user_id,
    user: me.user,
    ...(me.bot_id ? { botId: me.bot_id } : {}),
    url: me.url,
  };
  if (appToken) appTokens.set(session, appToken);
  return session;
}

/** Who the app is, as `jev-events auth slack` and `/connect/slack` saved it, to skip asking Slack each time. */
function savedIdentity(facts: Record<string, unknown> | undefined): AuthTest | undefined {
  const { team, teamId, userId, user, url, botId } = facts ?? {};
  if (typeof teamId !== "string" || typeof userId !== "string" || typeof user !== "string" || typeof url !== "string") return undefined;
  return {
    team: typeof team === "string" ? team : teamId,
    team_id: teamId,
    user_id: userId,
    user,
    url,
    ...(typeof botId === "string" ? { bot_id: botId } : {}),
  };
}

/** Someone saying something: not a join, an edit, the app's own post or, by default, a bot. */
function said(event: SlackMessageEvent, session: SlackSession, options: MessagesOptions): boolean {
  if (event.type !== "message" || event.hidden || !event.channel || !event.ts) return false;
  if (!SAID.has(event.subtype)) return false;
  if (event.user === session.userId || (event.bot_id !== undefined && event.bot_id === session.botId)) return false;
  if ((event.bot_id !== undefined || event.subtype === "bot_message") && !options.includeBots) return false;
  return Boolean(event.text?.trim() || event.files?.length);
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
  ctx: SourceContext<SlackMessageItem, SlackSession>,
): Promise<SlackMessageEvent[]> {
  const warned = new Set<string>();
  const perConversation = await Promise.all(
    (session.conversations ?? []).slice(0, BACKFILL_CONVERSATIONS).map(async (conversation) => {
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
