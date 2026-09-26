// The landing page's copy and mock data. Every probability here is made up for the page, not a
// recorded Jev answer.

export type SourceId =
  | 'gmail'
  | 'outlook'
  | 'gcal'
  | 'slack'
  | 'teams'
  | 'discord'
  | 'linear'
  | 'github'
  | 'notion'
  | 'drive'
  | 'twitch'
  | 'youtube'
  | 'webhook';

export const COPY = {
  headline: 'Ask every event a question.',
  sub: "A developer-first library to have Jev integrated into your users' inbox, calendar, Slack channels and more!",
  install: 'npm i jev-events',
  quickstart: 'Read the quickstart',
};

export interface StreamEvent {
  id: string;
  source: SourceId;
  title: string;
  meta: string;
  /** The label Jev gave it. */
  label: string;
  p: number;
  signal: boolean;
  /** What ran, for signal events. */
  action?: string;
  /** Hide the text (hateful messages are never shown). */
  redacted?: boolean;
}

export const STREAM: StreamEvent[] = [
  { id: 'e1', source: 'gcal', title: 'Q4 planning', meta: 'Sarah Chen, CEO · Thu 10:00', label: 'critical', p: 0.91, signal: true, action: 'Accept invite' },
  { id: 'e2', source: 'gmail', title: 'Your weekly digest', meta: 'Product Hunt', label: 'needs reply', p: 0.03, signal: false },
  { id: 'e3', source: 'slack', title: 'checkout returns 500 for EU cards', meta: '#support · Maya', label: 'bug report', p: 0.94, signal: true, action: 'Create Linear issue' },
  { id: 'e4', source: 'twitch', title: 'gg that clutch was insane', meta: 'chat · viewer_4821', label: 'hateful', p: 0.01, signal: false },
  { id: 'e5', source: 'outlook', title: 'Urgent: update our bank details', meta: 'billing@vend0r-pay.co', label: 'phishing', p: 0.97, signal: true, action: 'Move to Junk' },
  { id: 'e6', source: 'linear', title: 'Rename the settings tab', meta: 'ENG-1422', label: 'security', p: 0.02, signal: false },
  { id: 'e7', source: 'drive', title: 'customers-export.csv is public', meta: 'Anyone with the link', label: 'sensitive', p: 0.89, signal: true, action: 'restrictSharing()' },
  { id: 'e8', source: 'discord', title: 'anyone up for ranked later?', meta: '#general', label: 'hateful', p: 0.01, signal: false },
  { id: 'e9', source: 'youtube', title: 'free gift cards at bit.ly/…', meta: 'Comment', label: 'spam', p: 0.96, signal: true, action: 'Hold for review' },
  { id: 'e10', source: 'gmail', title: 'Re: contract redlines, sign-off by 5pm?', meta: 'legal@northwind.com', label: 'needs reply', p: 0.88, signal: true, action: 'notify()' },
  { id: 'e11', source: 'gcal', title: 'Optional: lunch & learn', meta: 'People team · Fri 12:30', label: 'critical', p: 0.04, signal: false },
  { id: 'e12', source: 'slack', title: 'lol same', meta: '#random', label: 'bug report', p: 0.01, signal: false },
  { id: 'e13', source: 'linear', title: 'Auth tokens visible in client logs', meta: 'SEC-212', label: 'security', p: 0.93, signal: true, action: 'Page on-call' },
  { id: 'e14', source: 'outlook', title: 'Automatic reply: back Monday', meta: 'Out of office', label: 'phishing', p: 0.02, signal: false },
  { id: 'e15', source: 'discord', title: '', meta: '#general', label: 'hateful', p: 0.95, signal: true, action: 'Timeout 10 min', redacted: true },
  { id: 'e16', source: 'drive', title: 'Q3 roadmap (draft) was edited', meta: 'Priya', label: 'sensitive', p: 0.03, signal: false },
  { id: 'e17', source: 'teams', title: 'Can someone approve the refund?', meta: 'Support · Tom', label: 'needs action', p: 0.86, signal: true, action: 'notify()' },
  { id: 'e18', source: 'github', title: 'docs: fix a typo', meta: 'PR #812', label: 'breaking', p: 0.02, signal: false },
];

/** The question each source's monitor asks, as the hero console shows it. */
export const QUESTIONS: Partial<Record<SourceId, string>> = {
  gmail: 'Does this email need a reply today?',
  gcal: 'How important is this meeting to this person?',
  slack: 'Is this a bug report?',
  outlook: 'Is this a phishing attempt?',
  linear: 'Is this a security issue?',
  drive: 'Does this file expose customer data?',
  discord: 'Is this message hateful?',
  twitch: 'Is this message hateful?',
  youtube: 'Is this comment spam?',
  teams: 'Does someone need to act on this?',
  github: 'Is this a breaking change?',
};

/** Everyday items that match nothing, so the console looks like a real stream: mostly nothing. */
export const MORE_NOISE: StreamEvent[] = [
  { id: 'n1', source: 'gmail', title: 'Your Uber receipt', meta: 'Uber Receipts', label: 'needs reply', p: 0.02, signal: false },
  { id: 'n2', source: 'slack', title: 'standup notes are in the doc', meta: '#eng · Priya', label: 'bug report', p: 0.03, signal: false },
  { id: 'n3', source: 'outlook', title: 'Your package has shipped', meta: 'orders@shop.com', label: 'phishing', p: 0.04, signal: false },
  { id: 'n4', source: 'gcal', title: 'Focus time', meta: 'Recurring · daily 9:00', label: 'critical', p: 0.02, signal: false },
  { id: 'n5', source: 'discord', title: 'gm everyone', meta: '#general', label: 'hateful', p: 0.01, signal: false },
  { id: 'n6', source: 'youtube', title: 'this tutorial saved my week', meta: 'Comment', label: 'spam', p: 0.02, signal: false },
  { id: 'n7', source: 'teams', title: 'Lunch at 12?', meta: 'Design · Ana', label: 'needs action', p: 0.05, signal: false },
  { id: 'n8', source: 'linear', title: 'Bump eslint to v10', meta: 'ENG-1431', label: 'security', p: 0.01, signal: false },
  { id: 'n9', source: 'drive', title: 'Offsite photos', meta: 'Shared with you', label: 'sensitive', p: 0.02, signal: false },
  { id: 'n10', source: 'github', title: 'chore: update lockfile', meta: 'PR #815', label: 'breaking', p: 0.03, signal: false },
  { id: 'n11', source: 'twitch', title: 'that ending was so good', meta: 'chat · kappa_king', label: 'hateful', p: 0.01, signal: false },
  { id: 'n12', source: 'slack', title: 'brb, grabbing coffee', meta: '#random · Leo', label: 'bug report', p: 0.01, signal: false },
];

/** The walkthrough: one calendar invite, from the user connecting Google to Acme telling them. */
// A sketch of the monitor() API from ADR 0002. The real signature lands with the core refactor.
export const STORY_CODE = `import { choice, monitor } from "jev-events";
import { google } from "@jev-events/google";

export const invites = monitor({
  source: google.calendar.invites(),
  profile: (connection) => profileOf(connection.userId),
  questions: {
    importance: choice("How important is this meeting to this person?", {
      critical: "They should be there",
      useful: "Worth going if they're free",
      skip: null,
    }),
  },
});

invites.on("importance:critical", { min: 0.85, review: 0.6 },
  google.calendar.respond("accepted"));
invites.on("importance:critical", { min: 0.85 },
  (e) => notify(e.connection, e.item));
invites.on("review", (e) => askUser(e.connection, e));

// Runs for every connected user. Monitors start in dry-run,
// where native actions only report what they would do.`;

export interface StoryStep {
  id: 'source' | 'context' | 'question' | 'judgment' | 'policy' | 'action';
  kicker: string;
  title: string;
  body: string;
  /** 1-based lines of STORY_CODE this step is about. */
  lines: number[];
  /** The first and last line of STORY_CODE the stacked walkthrough shows for this step. */
  excerpt: [number, number];
}

export const STORY: StoryStep[] = [
  {
    id: 'source',
    kicker: 'Connect',
    title: 'Your user connects Google once',
    body: "Dana, one of Acme's users, signs in with Google through your own OAuth app, and the tokens stay in your database. From then on, the integration picks up every new or changed invite and remembers where it left off, so nothing is missed or handled twice.",
    lines: [5],
    excerpt: [5, 5],
  },
  {
    id: 'context',
    kicker: 'Context',
    title: 'The invite comes with context',
    body: "An invite on its own doesn't say much. The integration works out who organized it, how soon it starts and whether it clashes with anything else. Your profile function adds what Acme knows about Dana, such as their job.",
    lines: [6],
    excerpt: [6, 6],
  },
  {
    id: 'question',
    kicker: 'Ask',
    title: 'You ask one question',
    body: "Write the question the way you'd ask a colleague, and name the answers you care about. Each answer becomes an event you can listen for, like `importance:critical`, and TypeScript checks the names.",
    lines: [8, 9, 10, 11],
    excerpt: [8, 12],
  },
  {
    id: 'judgment',
    kicker: 'Judge',
    title: 'Jev answers in about 200 ms',
    body: "Jev is TypeSafe's model for questions like this one. It gives each answer a probability between 0 and 1, and for this invite it says 0.91 for critical. A call costs a fraction of a cent, so you can afford to ask about every invite.",
    lines: [9, 10, 11],
    excerpt: [9, 11],
  },
  {
    id: 'policy',
    kicker: 'Decide',
    title: 'Your thresholds decide what happens',
    body: 'You choose the cut-offs. At 0.85 or higher, Acme acts on its own. Between 0.6 and 0.85, it asks Dana first. Below 0.6, nothing happens.',
    lines: [16, 18, 20],
    excerpt: [16, 20],
  },
  {
    id: 'action',
    kicker: 'Act',
    title: 'Acme accepts the invite and tells Dana',
    body: '0.91 clears 0.85, so the native action accepts the invite and your own notify function tells Dana why. New monitors run in dry-run mode, where native actions only report what they would do, until you turn it off.',
    lines: [17, 19],
    excerpt: [16, 19],
  },
];

/** The answer shown next to each choice label once Jev has answered. */
export const STORY_ANSWER: Record<number, { label: string; p: number }> = {
  9: { label: 'critical', p: 0.91 },
  10: { label: 'useful', p: 0.07 },
  11: { label: 'skip', p: 0.02 },
};

export const STORY_INVITE = {
  title: 'Q4 planning',
  when: 'Thu, Oct 2 · 10:00 to 11:00',
  organizer: 'Sarah Chen',
  organizerRole: 'CEO',
  guests: 4,
  /** `profile` facts come from the developer's profile function, the rest from the integration. */
  facts: [
    { k: 'organizer', v: 'Sarah Chen, CEO', from: 'integration' },
    { k: 'starts in', v: '26 h', from: 'integration' },
    { k: 'conflicts', v: 'none', from: 'integration' },
    { k: 'job', v: 'Staff engineer, Payments', from: 'profile' },
  ],
  latencyMs: 212,
} as const;

/** What each integration watches (read after "Watches") and the native actions it comes with. */
export const INTEGRATIONS: Array<{ id: SourceId; watches: string; actions: string[] }> = [
  { id: 'gmail', watches: 'new mail, threads and labels', actions: ['label', 'archive', 'star', 'draft reply'] },
  { id: 'outlook', watches: 'new mail and folders', actions: ['move', 'flag', 'categorize'] },
  { id: 'gcal', watches: 'invites, changes and upcoming events', actions: ['accept', 'decline', 'maybe'] },
  { id: 'slack', watches: 'messages, threads and reactions', actions: ['reply', 'react', 'post'] },
  { id: 'teams', watches: 'chats and channels', actions: ['reply', 'react'] },
  { id: 'discord', watches: 'server messages', actions: ['delete', 'timeout', 'react'] },
  { id: 'linear', watches: 'issues and comments', actions: ['create', 'label', 'assign'] },
  { id: 'github', watches: 'issues, pull requests and reviews', actions: ['label', 'comment', 'close'] },
  { id: 'notion', watches: 'pages and databases', actions: ['add row', 'comment'] },
  { id: 'drive', watches: 'files and sharing changes', actions: ['restrict', 'move', 'label'] },
  { id: 'twitch', watches: 'live chat', actions: ['timeout', 'ban', 'delete'] },
  { id: 'youtube', watches: 'live chat and comments', actions: ['hold', 'delete', 'reply'] },
];

/** TypeSafe's published figures for Jev; re-check them against their docs before launch. */
export const JEV_FACTS = [
  { value: '~200 ms', label: 'to answer a question', note: 'TypeSafe lists 150 to 300 ms' },
  { value: '$0.042', label: 'per million input tokens', note: 'Output tokens are free' },
  { value: '0 to 1', label: 'a probability for each answer', note: 'You decide where the cut-offs go' },
];
