/**
 * What the code builder offers for each integration: its sources, its native actions, and how
 * its app is set up. The builder UI and the generator read it, and `test/builder.test.ts`
 * type-checks everything the generator writes against the packages themselves.
 */

import { manifestUrl } from './slack-manifest.ts';

export type IntegrationId = 'gmail' | 'calendar' | 'slack' | 'twitch';

/** One input next to a source or an action, such as a label name or a timeout. */
export interface ParamSpec {
  key: string;
  label: string;
  kind: 'text' | 'number';
  default: string;
  /** Shown when the input is empty. An empty value is allowed only when this is set. */
  placeholder?: string;
}

export interface SourceSpec {
  id: string;
  label: string;
  /** What it reads, in one line. */
  describe: string;
  param?: ParamSpec;
  /**
   * The source expression, such as `google.gmail.inbox()`. With `backfill`, it also reads that many
   * items that are already there, when the source can.
   */
  code(value: string, backfill?: number): string;
  /** What `backfill: BACKFILL` adds, for a comment in the generated code. Unset when it can't backfill. */
  backfill?: string;
  /** What the generated code prints once it runs on your machine. */
  watching: string;
  /** The monitor's name in the generated code. */
  variable: string;
}

export interface ActionSpec {
  id: string;
  /** In the picker, such as "Archive it". */
  label: string;
  /** What it does, exactly, in a line or two. */
  describe: string;
  params: readonly ParamSpec[];
  /** The handler expression, such as `google.gmail.label("Needs reply")`. */
  code(values: Readonly<Record<string, string>>): string;
  /** The sources it works on, when not all of them. */
  only?: readonly string[];
}

export interface EnvVar {
  name: string;
  comment: string;
}

/** One setup step. */
export interface Step {
  /** Text with `code` and [links](https://…). */
  text: string;
  /** Shell commands, one per line. */
  command?: string;
  /** Something to copy that isn't a command, such as a redirect URL. */
  value?: string;
}

/** Your web app's URLs that an app's settings need. */
export interface AppUrls {
  /** Where the platform sends users back after they sign in: `…/api/jev/callback/<integration>`. */
  callback: string;
  /** Where the platform sends events, for webhook integrations: `…/api/jev/webhook/<integration>`. */
  webhook: string;
}

export interface IntegrationSpec {
  id: IntegrationId;
  /** "Gmail" */
  name: string;
  /** Its docs page. */
  docs: string;
  /** What one item is: "email". */
  noun: string;
  /** "@jev-events/google" */
  pkg: string;
  /** The package's export: `google`. */
  ns: string;
  /** The app for `runtime({ apps })`, such as `google.app({ scopes: ["gmail"] })`. */
  app: string;
  /** The connection's integration, which names its routes: "google" for both Gmail and Calendar. */
  integration: string;
  /** The recipes that fit, from `recipes.<group>`. */
  recipeGroup: string;
  sources: readonly SourceSpec[];
  actions: readonly ActionSpec[];
  /**
   * How new items reach your web app once it runs for your users: a cron job that checks, a
   * webhook the platform calls, or a connection that stays open in a worker.
   */
  delivery: 'poll' | 'webhook' | 'stream';
  /** What your own handler prints about an item: the inside of a template literal over `e`. */
  describeItem: string;
  /** An example item, shown next to the source so it's clear what Jev reads. */
  sample: { from: string; title?: string; text: string };
  /** How to create the app your users sign in to, up to copying its credentials. */
  createApp(urls: AppUrls): readonly Step[];
  /** The app's environment variables, read by `<ns>.app()`. */
  env: readonly EnvVar[];
  /** The step that runs `npx jev-events auth <integration>` on your machine. */
  signIn: string;
  /** The text of the link that connects an account in your web app. */
  connectLabel: string;
  /** How to see it work once your web app runs it. */
  tryIt: string;
  /** What the builder starts with. */
  starter: { questions: readonly StarterQuestion[]; rules: readonly StarterRule[] };
}

/** A recipe by id, or your own question. */
export type StarterQuestion =
  | { recipe: string }
  | { id: string; noul: string }
  | { id: string; choice: string; labels: readonly { name: string; description: string }[] };

export interface StarterRule {
  event: string;
  min?: number;
  review?: number;
  /** An action id, or "log" for your own code. */
  do: string;
  values?: Readonly<Record<string, string>>;
}

/** How many existing items the code for your own machine reads first, so there's something to see right away. */
export const BACKFILL = 5;

/** A string literal for generated code. */
export function str(value: string): string {
  return JSON.stringify(value);
}

/** `fn()`, or `fn({ a, b })` with options. */
function call(fn: string, options: readonly string[]): string {
  return options.length === 0 ? `${fn}()` : `${fn}({ ${options.join(', ')} })`;
}

function backfillOption(count: number | undefined): string[] {
  return count ? [`backfill: ${count}`] : [];
}

function comment(values: Readonly<Record<string, string>>): string {
  const text = values.comment?.trim();
  return text ? `{ comment: ${str(text)} }` : '';
}

const COMMENT: ParamSpec = { key: 'comment', label: 'Note to the organizer', kind: 'text', default: '', placeholder: 'None' };

const GOOGLE_ENV: readonly EnvVar[] = [
  { name: 'GOOGLE_CLIENT_ID', comment: 'Your Google OAuth client: console.cloud.google.com/auth/clients' },
  { name: 'GOOGLE_CLIENT_SECRET', comment: '' },
];

const GOOGLE_SIGN_IN = 'Sign in with your Google account. The first time, the command walks you through creating your own OAuth client in Google Cloud.';

/** The same steps as `npx jev-events auth google`, with a "Web application" client instead of a desktop one. */
const googleApp =
  (api: string, apiId: string) =>
  (urls: AppUrls): Step[] => [
    {
      text: `In Google Cloud, [create a project](https://console.cloud.google.com/projectcreate), [turn on the ${api} API](https://console.cloud.google.com/flows/enableapi?apiid=${apiId}) and [set up the consent screen](https://console.cloud.google.com/auth/overview): click Get started, and choose External.`,
    },
    {
      text: '[Create an OAuth client](https://console.cloud.google.com/auth/clients/create) of type "Web application", with this authorized redirect URI. Copy its Client ID and Client Secret for the next step.',
      value: urls.callback,
    },
    {
      text: 'While the app is in Testing, only the test users you add under Audience can connect, and their sign-ins expire after 7 days. Publish it, and get it verified, before real users connect.',
    },
  ];

export const CATALOG: Readonly<Record<IntegrationId, IntegrationSpec>> = {
  gmail: {
    id: 'gmail',
    name: 'Gmail',
    docs: '/docs/integrations/gmail',
    noun: 'email',
    pkg: '@jev-events/google',
    ns: 'google',
    app: 'google.app({ scopes: ["gmail"] })',
    integration: 'google',
    recipeGroup: 'email',
    sources: [
      {
        id: 'inbox',
        label: 'New email in the inbox',
        describe: 'Every email that lands in the inbox from now on.',
        code: (_value, backfill) => call('google.gmail.inbox', backfillOption(backfill)),
        backfill: `Also judges the ${BACKFILL} latest emails on the first run`,
        watching: 'Watching the inbox for new email. Stop with Ctrl-C.',
        variable: 'inbox',
      },
    ],
    actions: [
      {
        id: 'archive',
        label: 'Archive it',
        describe: 'Takes it out of the inbox. It stays in All Mail.',
        params: [],
        code: () => 'google.gmail.archive()',
      },
      {
        id: 'label',
        label: 'Add a label',
        describe: 'Adds a Gmail label, and creates the label the first time.',
        params: [{ key: 'name', label: 'Label', kind: 'text', default: 'Needs reply' }],
        code: (values) => `google.gmail.label(${str(values.name ?? '')})`,
      },
      {
        id: 'star',
        label: 'Star it',
        describe: 'Stars the email.',
        params: [],
        code: () => 'google.gmail.star()',
      },
      {
        id: 'markRead',
        label: 'Mark it read',
        describe: 'Marks the email as read.',
        params: [],
        code: () => 'google.gmail.markRead()',
      },
      {
        id: 'draftReply',
        label: 'Draft a reply',
        describe: 'Saves a draft reply in the thread. It never sends anything.',
        params: [{ key: 'text', label: 'Reply', kind: 'text', default: "Thanks, I'll get back to you by Friday." }],
        code: (values) => `google.gmail.draftReply(${str(values.text ?? '')})`,
      },
      {
        id: 'trash',
        label: 'Move it to Trash',
        describe: 'Gmail keeps it in Trash for 30 days. Nothing is deleted for good.',
        params: [],
        code: () => 'google.gmail.trash()',
      },
    ],
    delivery: 'poll',
    describeItem: '${e.item.subject} (from ${e.item.from.address})',
    sample: { from: 'Dana Reyes <dana@acme.com>', title: 'Q3 deck', text: 'Could you look over the Q3 deck before Friday? Mostly the pricing slide.' },
    createApp: googleApp('Gmail', 'gmail.googleapis.com'),
    env: GOOGLE_ENV,
    signIn: GOOGLE_SIGN_IN,
    connectLabel: 'Connect Gmail',
    tryIt: 'Connect your own account through the link, and send yourself an email.',
    starter: {
      questions: [{ recipe: 'kind' }, { recipe: 'needsReply' }],
      rules: [
        { event: 'kind:newsletter', min: 0.9, do: 'archive' },
        { event: 'needsReply', min: 0.8, do: 'label', values: { name: 'Needs reply' } },
      ],
    },
  },
  calendar: {
    id: 'calendar',
    name: 'Google Calendar',
    docs: '/docs/integrations/google-calendar',
    noun: 'event',
    pkg: '@jev-events/google',
    ns: 'google',
    app: 'google.app({ scopes: ["calendar"] })',
    integration: 'google',
    recipeGroup: 'calendar',
    sources: [
      {
        id: 'invites',
        label: "Invites you haven't answered",
        describe: 'New invitations, and changes to them, until you answer.',
        code: (_value, backfill) => call('google.calendar.invites', backfillOption(backfill)),
        backfill: `Also judges the next ${BACKFILL} invites you haven't answered, on the first run`,
        watching: 'Watching for new invites. Stop with Ctrl-C.',
        variable: 'invites',
      },
      {
        id: 'events',
        label: 'Every new or changed event',
        describe: 'Every event on the calendar that is added, moved or cancelled, including your own.',
        code: (_value, backfill) => call('google.calendar.events', backfillOption(backfill)),
        backfill: `Also judges the next ${BACKFILL} events on the first run`,
        watching: 'Watching the calendar for new and changed events. Stop with Ctrl-C.',
        variable: 'events',
      },
    ],
    actions: [
      {
        id: 'accept',
        label: 'Accept',
        describe: 'Answers yes. The organizer is told, and for a recurring event it answers the whole series.',
        params: [COMMENT],
        code: (values) => `google.calendar.accept(${comment(values)})`,
        only: ['invites'],
      },
      {
        id: 'decline',
        label: 'Decline',
        describe: 'Answers no. The organizer is told, and for a recurring event it answers the whole series.',
        params: [{ ...COMMENT, default: "Thanks, but I'll pass." }],
        code: (values) => `google.calendar.decline(${comment(values)})`,
        only: ['invites'],
      },
      {
        id: 'maybe',
        label: 'Answer maybe',
        describe: 'Answers maybe. The organizer is told, and for a recurring event it answers the whole series.',
        params: [COMMENT],
        code: (values) => `google.calendar.maybe(${comment(values)})`,
        only: ['invites'],
      },
    ],
    delivery: 'poll',
    describeItem: '${e.item.title} (from ${e.item.organizer.email})',
    sample: { from: 'sam@vendor.io', title: 'Quick sync: 15 minutes on your data stack', text: 'Tue 14:00–14:15 · Google Meet · 2 guests' },
    createApp: googleApp('Google Calendar', 'calendar-json.googleapis.com'),
    env: GOOGLE_ENV,
    signIn: GOOGLE_SIGN_IN,
    connectLabel: 'Connect Google Calendar',
    tryIt: 'Connect your own account through the link, and have someone invite you to a meeting.',
    starter: {
      questions: [{ recipe: 'important' }, { recipe: 'likelySales' }],
      rules: [
        { event: 'important', min: 0.8, do: 'log' },
        { event: 'likelySales', min: 0.9, do: 'decline', values: { comment: "Thanks, but I'll pass." } },
      ],
    },
  },
  slack: {
    id: 'slack',
    name: 'Slack',
    docs: '/docs/integrations/slack',
    noun: 'message',
    pkg: '@jev-events/slack',
    ns: 'slack',
    app: 'slack.app()',
    integration: 'slack',
    recipeGroup: 'team',
    sources: [
      {
        id: 'messages',
        label: 'New messages',
        describe: 'Messages in the channels and DMs the app is in. Invite it with /invite @your-app.',
        param: { key: 'channels', label: 'Only these channels', kind: 'text', default: '', placeholder: 'Every channel the app is in' },
        code: (value, backfill) => {
          const channels = value
            .split(',')
            .map((channel) => channel.trim())
            .filter(Boolean);
          return call('slack.messages', [
            ...(channels.length > 0 ? [`channels: [${channels.map(str).join(', ')}]`] : []),
            ...backfillOption(backfill),
          ]);
        },
        backfill: `Also judges the ${BACKFILL} latest messages each time it starts`,
        watching: 'Watching for new messages. Stop with Ctrl-C.',
        variable: 'team',
      },
    ],
    actions: [
      {
        id: 'react',
        label: 'Add a reaction',
        describe: 'Reacts to the message with an emoji, by its name without colons.',
        params: [{ key: 'emoji', label: 'Emoji', kind: 'text', default: 'eyes' }],
        code: (values) => `slack.react(${str(values.emoji ?? '')})`,
      },
      {
        id: 'reply',
        label: 'Reply in the thread',
        describe: 'Replies in the thread, or right in the conversation in a DM.',
        params: [{ key: 'text', label: 'Reply', kind: 'text', default: "Thanks, we're on it." }],
        code: (values) => `slack.reply(${str(values.text ?? '')})`,
      },
      {
        id: 'post',
        label: 'Post in another channel',
        describe: 'Posts what fired, who wrote the message and where, with a link to it.',
        params: [{ key: 'channel', label: 'Channel', kind: 'text', default: '#incidents' }],
        code: (values) => `slack.post(${str(values.channel ?? '')})`,
      },
    ],
    delivery: 'webhook',
    describeItem: '${e.item.author.name}: ${e.item.text}',
    sample: { from: 'Priya · #deploys', text: 'Checkout is returning 500s since the 14:05 deploy, can someone roll back?' },
    createApp: (urls) => [
      {
        text: `[Create the Slack app](${manifestUrl({ requestUrl: urls.webhook, redirectUrls: [urls.callback] })}) from a manifest, with its scopes, events and your URLs filled in. Pick your workspace, then Create.`,
      },
      { text: 'Under Manage Distribution, turn on public distribution, so other workspaces can add the app.' },
      { text: 'From Basic Information, copy the Client ID, Client Secret and Signing Secret for the next step.' },
    ],
    env: [
      { name: 'SLACK_CLIENT_ID', comment: 'Your Slack app, under Basic Information: api.slack.com/apps' },
      { name: 'SLACK_CLIENT_SECRET', comment: '' },
      { name: 'SLACK_SIGNING_SECRET', comment: '' },
    ],
    signIn: 'Create your own Slack app and add it to your workspace: the command walks you through it. Then invite the app to a channel with `/invite @jev_events`.',
    connectLabel: 'Add to Slack',
    tryIt: 'Add the app to your workspace through the link, invite it to a channel with `/invite @jev_events`, and post a message there.',
    starter: {
      questions: [{ recipe: 'urgent' }, { recipe: 'needsAnswer' }],
      rules: [
        { event: 'urgent', min: 0.9, do: 'post', values: { channel: '#incidents' } },
        { event: 'needsAnswer', min: 0.8, do: 'react', values: { emoji: 'eyes' } },
      ],
    },
  },
  twitch: {
    id: 'twitch',
    name: 'Twitch',
    docs: '/docs/integrations/twitch',
    noun: 'chat message',
    pkg: '@jev-events/twitch',
    ns: 'twitch',
    app: 'twitch.app()',
    integration: 'twitch',
    recipeGroup: 'chat',
    sources: [
      {
        id: 'chat',
        label: 'Chat',
        describe: "Live chat, read as the signed-in account. Actions need it to be the channel's owner or a moderator.",
        param: { key: 'channel', label: 'Channel', kind: 'text', default: '', placeholder: "The signed-in account's own channel" },
        code: (value) => {
          const channel = twitchLogin(value);
          return channel ? `twitch.chat(${str(channel)})` : 'twitch.chat()';
        },
        watching: 'Watching chat. Stop with Ctrl-C.',
        variable: 'mods',
      },
    ],
    actions: [
      {
        id: 'timeout',
        label: 'Time out',
        describe: "Times the chatter out. Moderators, VIPs and the broadcaster are never touched.",
        params: [{ key: 'seconds', label: 'Seconds', kind: 'number', default: '600' }],
        code: (values) => `twitch.timeout({ seconds: ${seconds(values.seconds)} })`,
      },
      {
        id: 'deleteMessage',
        label: 'Delete the message',
        describe: 'Deletes the message from chat.',
        params: [],
        code: () => 'twitch.deleteMessage()',
      },
      {
        id: 'warn',
        label: 'Warn',
        describe: 'The chatter has to acknowledge the warning before chatting again.',
        params: [{ key: 'reason', label: 'Reason', kind: 'text', default: 'Please keep chat kind.' }],
        code: (values) => `twitch.warn({ reason: ${str(values.reason ?? '')} })`,
      },
      {
        id: 'reply',
        label: 'Reply in chat',
        describe: 'Replies to the message, as the signed-in account.',
        params: [{ key: 'text', label: 'Reply', kind: 'text', default: 'Good question! Answering it after this round.' }],
        code: (values) => `twitch.reply(${str(values.text ?? '')})`,
      },
      {
        id: 'clip',
        label: 'Clip the stream',
        describe: 'Clips the last seconds of the stream, while it is live.',
        params: [],
        code: () => 'twitch.clip()',
      },
      {
        id: 'ban',
        label: 'Ban',
        describe: 'Bans the chatter. Prefer a timeout unless you are sure.',
        params: [],
        code: () => 'twitch.ban()',
      },
    ],
    delivery: 'stream',
    describeItem: '${e.item.author.name}: ${e.item.text}',
    sample: { from: 'viewer_42', text: 'is anyone else getting no sound?? been like this for 2 min' },
    createApp: (urls) => [
      {
        text: '[Register an app](https://dev.twitch.tv/console/apps/create) in the Twitch developer console, with the category "Chat Bot", the client type "Confidential" and this OAuth Redirect URL. Twitch asks you to turn on two-factor authentication first, if it\'s off.',
        value: urls.callback,
      },
      { text: 'Under Manage, copy the Client ID, and create a Client Secret, for the next step.' },
    ],
    env: [
      { name: 'TWITCH_CLIENT_ID', comment: 'Your Twitch app: dev.twitch.tv/console/apps' },
      { name: 'TWITCH_CLIENT_SECRET', comment: '' },
    ],
    signIn: 'Sign in with your Twitch account. The first time, the command walks you through registering your own Twitch app.',
    connectLabel: 'Connect Twitch',
    tryIt: 'Connect your own Twitch account through the link, and write in your chat.',
    starter: {
      questions: [{ recipe: 'hateful' }, { recipe: 'spam' }],
      rules: [
        { event: 'hateful', min: 0.9, do: 'timeout', values: { seconds: '600' } },
        { event: 'spam', min: 0.85, do: 'deleteMessage' },
      ],
    },
  },
};

export const INTEGRATIONS: readonly IntegrationSpec[] = Object.values(CATALOG);

/** A channel's login from what someone typed, such as "#Name", "@name" or a twitch.tv link. */
export function twitchLogin(value: string): string {
  const last = value.trim().replace(/\/+$/, '').split('/').at(-1) ?? '';
  return last
    .replace(/^[#@]/, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 25);
}

/** A whole number of seconds for a timeout, within Twitch's two weeks. */
function seconds(value: string | undefined): number {
  const parsed = Math.round(Number(value));
  return Number.isFinite(parsed) && parsed >= 1 ? Math.min(parsed, 1_209_600) : 600;
}
