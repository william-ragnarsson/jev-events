import { choice, noul, score } from "@typesafe-ai/sdk";

/**
 * Ready-made questions for common streams. Each asks one narrow judgment and spells out its
 * outcomes. Thresholds are yours to pick; the benchmarks in the docs suggest starting points.
 */

/** Live chat: Twitch, YouTube Live, Discord channels. */
export const chat = {
  kind: choice("What is this live chat message mainly doing?", {
    question: "Asks the streamer or chat a genuine question",
    hype: "Cheers, celebrates or reacts with excitement",
    joke: "A joke, meme, emote spam or friendly banter",
    backseat: "Tells the streamer how to play or what to do, without being asked",
    spam: "Advertising, self-promotion, scams, suspicious links or repeated junk",
    other: "Anything else",
  }),
  hateful: noul("Does this message attack, insult or demean a person or group?", {
    true: "Harassment, slurs, threats or dehumanizing language aimed at someone",
    false: "No attack on anyone; swearing, banter and criticism of gameplay are fine",
  }),
  question: noul("Is this message a genuine question directed at the streamer?"),
  streamIssue: noul(
    "Is this message reporting a technical problem with the stream itself, such as no sound, lag, buffering, a black screen or audio out of sync?",
  ),
  spam: noul("Is this message spam: advertising, self-promotion, a scam or a suspicious link?"),
  /** Spoilers for a specific game, show or book. */
  spoiler: (subject: string) =>
    noul(`Does this message reveal story, ending or boss details about ${subject} that a first-time player would not want to know?`),
  toxicity: score("How toxic is this message toward other people?", [
    "Friendly or neutral",
    "Rude or dismissive, but not aimed at hurting anyone",
    "Insulting or mean toward someone",
    "Harassment, slurs or threats",
  ]),
} as const;

/** Comments under videos or posts. */
export const comments = {
  kind: choice("What is this comment mainly doing?", {
    question: "Asks the creator a genuine question",
    praise: "Compliments or thanks the creator",
    feedback: "Constructive criticism or a correction",
    idea: "Suggests an idea for future content",
    spam: "Advertising, scams, bots or suspicious links",
    hateful: "Harasses, insults or demeans someone",
    other: "Anything else",
  }),
  needsReply: noul("Would a reply from the creator be valuable to this commenter?"),
} as const;

/** Email. */
export const email = {
  needsReply: noul("Does this email need a personal reply from the recipient?", {
    true: "A real person asks the recipient something or expects a response",
    false: "Newsletters, notifications, receipts, marketing or messages sent just for information",
  }),
  kind: choice("What kind of email is this?", {
    personal: "Written by someone to the recipient personally",
    work: "About the recipient's job, projects or colleagues",
    receipt: "Receipts, invoices, orders and shipping updates",
    newsletter: "Newsletters and marketing",
    notification: "Automated notifications and alerts",
    other: "Anything else",
  }),
  urgent: noul("Does the sender say this is urgent or time-sensitive?"),
  phishing: noul(
    "Does this email try to get the recipient to share credentials, pay money or open a link under false pretenses?",
  ),
} as const;

/** Calendar events. Compute times in code and pass them as facts; don't ask Jev to do date math. */
export const calendar = {
  needsPrep: noul(
    "Would the attendee need to prepare before this event, for example by reading material, building slides or making a decision?",
  ),
  likelySales: noul("Is this invitation most likely a sales or vendor pitch?"),
  kind: choice("What kind of event is this?", {
    meeting: "A work meeting with other people",
    interview: "A job interview",
    social: "A social or personal event with other people",
    focus: "Time blocked for focused work",
    personal: "An appointment or reminder for the owner only",
    other: "Anything else",
  }),
} as const;

export const recipes = { chat, comments, email, calendar } as const;
