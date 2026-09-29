// What the Try it page sends to /api/try, and what the route asks Jev: the same state and
// question a monitor on `twitchChat()` would send for that message. apps/web/test/try.test.ts
// compares them with the library's.

import type { JsonValue, Question } from '@typesafe-ai/sdk';

import type { RecipeEntry } from '../builder/generate.ts';

/** A chat recipe by id, or the visitor's own yes/no question. */
export type TryQuestion = { recipe: string } | { custom: string };

export interface TryMessage {
  author: string;
  text: string;
  roles?: string[];
  firstMessage?: boolean;
  replyingTo?: { author: string; text: string };
}

export interface TryRequest {
  question: TryQuestion;
  message: TryMessage;
  /** Up to three messages before this one, which Jev reads as context. */
  recent: { author: string; text: string }[];
}

/** Jev's answer, reduced to what the page shows. */
export type TryAnswer = { type: 'noul'; p: number } | { type: 'choice'; label: string; p: number };

export interface TryResult {
  answer: TryAnswer;
  model: string;
  inputTokens: number;
  latencyMs: number;
}

export interface TryError {
  error: string;
  /** Set when TypeSafe asks to slow down. */
  retryAfterMs?: number;
}

/** A question the page offers. */
export interface QuestionOption {
  id: string;
  type: 'noul' | 'choice';
  /** What it asks Jev. */
  text: string;
  /** A choice's labels. */
  labels: string[];
}

/** Jev's list price per million input tokens, as in packages/core/src/pricing.ts. */
export const JEV_USD_PER_MILLION_INPUT_TOKENS = 0.042;

/** How many earlier messages go with each one, as `twitchChat()` sends by default. */
export const RECENT = 3;

/** The longest custom question. */
export const MAX_QUESTION = 300;

const MAX_TEXT = 500;
const MAX_NAME = 64;
const ROLES = new Set(['broadcaster', 'moderator', 'vip', 'subscriber', 'staff']);

/** The chat recipes that take no argument and answer yes or no, or pick a label. */
export function chatRecipes(entries: readonly RecipeEntry[]): QuestionOption[] {
  return entries.flatMap((entry): QuestionOption[] => {
    if (entry.group !== 'chat' || entry.usage.includes('(') || typeof entry.instructions !== 'string') return [];
    if (entry.type !== 'noul' && entry.type !== 'choice') return [];
    const labels = entry.type === 'choice' && entry.criteria && typeof entry.criteria === 'object' ? Object.keys(entry.criteria) : [];
    return [{ id: entry.id, type: entry.type, text: entry.instructions, labels }];
  });
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;

function lines(value: unknown): { author: string; text: string } | undefined {
  if (!isRecord(value) || typeof value.author !== 'string' || value.author.length > MAX_NAME || !isText(value.text, MAX_TEXT)) return undefined;
  return { author: value.author, text: value.text };
}

/** The request in a body sent to /api/try, or what's wrong with it. */
export function parseTryRequest(body: unknown): TryRequest | string {
  if (!isRecord(body) || !isRecord(body.question) || !isRecord(body.message)) return 'Send a question and a message.';

  const { recipe, custom } = body.question;
  let question: TryQuestion;
  if (typeof recipe === 'string' && /^[A-Za-z]{1,40}$/.test(recipe)) question = { recipe };
  else if (typeof custom === 'string' && custom.trim() && custom.length <= MAX_QUESTION) question = { custom: custom.trim() };
  else return `Pick a question, or write one under ${MAX_QUESTION} characters.`;

  const { author, text, roles, firstMessage, replyingTo } = body.message;
  if (typeof author !== 'string' || author.length > MAX_NAME || !isText(text, MAX_TEXT)) return 'The message is missing or too long.';
  if (roles !== undefined && !(Array.isArray(roles) && roles.length <= ROLES.size && roles.every((role) => ROLES.has(role)))) {
    return "The chatter's roles aren't ones Twitch has.";
  }
  const reply = replyingTo === undefined ? undefined : lines(replyingTo);
  if (replyingTo !== undefined && !reply) return 'The message it replies to is missing or too long.';
  const message: TryMessage = {
    author,
    text,
    ...(roles?.length ? { roles: roles as string[] } : {}),
    ...(firstMessage === true ? { firstMessage } : {}),
    ...(reply ? { replyingTo: reply } : {}),
  };

  const recent = Array.isArray(body.recent) ? body.recent.map(lines) : [];
  if (recent.length > RECENT || recent.some((line) => !line)) return `Send up to ${RECENT} earlier messages.`;

  return { question, message, recent: recent as TryRequest['recent'] };
}

/** The question to ask, from a recipe as `generated/recipes.json` lists it or the visitor's own. */
export function questionFor(question: TryQuestion, entries: readonly RecipeEntry[]): Question | undefined {
  if ('custom' in question) return { type: 'noul', instructions: question.custom };
  const option = chatRecipes(entries).find((recipe) => recipe.id === question.recipe);
  const entry = option && entries.find((e) => e.group === 'chat' && e.id === option.id);
  if (!entry) return undefined;
  const { instructions, criteria } = entry as { instructions: string; criteria: unknown };
  return option.type === 'choice'
    ? { type: 'choice', instructions, criteria: criteria as Record<string, string> }
    : { type: 'noul', instructions, ...(criteria ? { criteria: criteria as { true?: string; false?: string } } : {}) };
}

/**
 * The state a monitor builds for a chat message: the message itself (its facts, text, author and
 * roles) and the messages just before it.
 */
export function chatState(message: TryMessage, recent: TryRequest['recent']): Record<string, JsonValue> {
  const view: Record<string, JsonValue> = {
    ...(message.firstMessage ? { firstMessage: true } : {}),
    ...(message.replyingTo ? { replyingTo: { author: message.replyingTo.author, text: message.replyingTo.text } } : {}),
    text: message.text,
    author: message.author,
  };
  if (message.roles?.length) view.roles = [...message.roles];
  const state: Record<string, JsonValue> = { message: view };
  if (recent.length > 0) state.recent = recent.map((line) => ({ author: line.author, text: line.text }));
  return state;
}

/**
 * The whole request for Jev, or undefined for an unknown recipe. With earlier messages in the
 * state, the question points at `message`, so they're read as context rather than judged.
 */
export function jevRequest(request: TryRequest, entries: readonly RecipeEntry[]) {
  const question = questionFor(request.question, entries);
  if (!question) return undefined;
  const id = 'recipe' in request.question ? request.question.recipe : 'custom';
  const asked = { ...question, instructions: { question: question.instructions ?? null, inspect: 'message' } } as Question;
  return { state: chatState(request.message, request.recent), questions: { [id]: asked } };
}

export function costUsd(inputTokens: number): number {
  return (inputTokens / 1_000_000) * JEV_USD_PER_MILLION_INPUT_TOKENS;
}

/** How the page paces requests, as a monitor with these options would. */
export const LIMITS = { perSecond: 2, burst: 2, maxQueue: 3, maxLagMs: 3000 } as const;

/** The page's example of your own question. */
export const EXAMPLE_QUESTION = 'Is this message about the game being played?';

/**
 * The chat recipes the page offers, in its order and by short names. They all answer yes or no, since
 * the chat shows Jev's probability of yes. What Jev is asked is the recipe's own question.
 */
export const TRY_QUESTIONS = [
  { id: 'question', label: 'A question for the streamer?' },
  { id: 'hateful', label: 'Hateful?' },
  { id: 'spam', label: 'Spam?' },
  { id: 'streamIssue', label: 'A problem with the stream?' },
] as const;

/**
 * The monitor that does what the page does, for the channel and question picked. The tests
 * type-check it against the library.
 */
export function tryCode(login: string | undefined, question: TryQuestion, entries: readonly RecipeEntry[]): string {
  const custom = 'custom' in question;
  const id = custom ? 'custom' : question.recipe;
  const type = custom ? 'noul' : (chatRecipes(entries).find((recipe) => recipe.id === id)?.type ?? 'noul');
  const asked = custom ? `noul(${JSON.stringify(question.custom.trim() || EXAMPLE_QUESTION)})` : `recipes.chat.${id}`;
  return [
    `import { ${custom ? 'monitor, noul' : 'monitor, recipes'} } from "jev-events";`,
    'import { twitchChat } from "jev-events/public";',
    '',
    '// Reads your key from TYPESAFE_API_KEY.',
    'const chat = monitor({',
    `  source: twitchChat(${JSON.stringify(login ?? 'some_live_channel')}),`,
    `  questions: { ${id}: ${asked} },`,
    "  // This demo's limits, so a busy chat can't run up your bill.",
    `  rate: { perSecond: ${LIMITS.perSecond}, burst: ${LIMITS.burst} },`,
    `  maxQueue: ${LIMITS.maxQueue},`,
    `  maxLagMs: ${LIMITS.maxLagMs},`,
    '});',
    '',
    `chat.on("judged", (e) => console.log(e.item.text, e.answers.${id}.${type === 'choice' ? 'choice' : 'noul'}));`,
    '',
    'await chat.start();',
  ].join('\n');
}
