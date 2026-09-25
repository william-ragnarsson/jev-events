import { listen, recipes, type DailyBudget, type JevClient, type JudgedEvent, type Logger } from "jev-events";
import { twitchChat, type TwitchChatItem, type TwitchPublicChatOptions } from "jev-events/public";

export const questions = { kind: recipes.chat.kind, hateful: recipes.chat.hateful };
export type Judged = JudgedEvent<TwitchChatItem, typeof questions>;

export interface JudgeOptions {
  /** Messages judged per second. The rest of chat is skipped, never shown unlabeled. */
  perSecond: number;
  /** Shared across channel switches, so reconnecting never resets the day's spend. */
  budget: DailyBudget;
  onJudged: (event: Judged) => void;
  client?: JevClient;
  log?: Logger;
  chat?: TwitchPublicChatOptions;
}

/** The whole demo: read a public Twitch chat and label every message it has time for. */
export function judgeChat(channel: string, options: JudgeOptions) {
  const chat = listen(twitchChat(channel, options.chat), questions, {
    rate: { perSecond: options.perSecond, burst: options.perSecond },
    maxQueue: 3, // label what chat is saying now and skip the backlog
    maxLagMs: 3_000,
    cache: true, // a copy-paste flood is judged once
    budget: options.budget,
    ...(options.client ? { client: options.client } : {}),
    ...(options.log ? { log: options.log } : {}),
  });

  // No native actions on purpose: the relay only reads chat and never moderates anyone.
  return chat.on("judged", options.onJudged);
}
