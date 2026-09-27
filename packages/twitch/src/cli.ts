import { recipes, type Connection } from "jev-events";

import { fromEnv } from "./auth.js";
import { chat } from "./chat.js";
import type { TwitchSession } from "./session.js";

/**
 * `jev-events watch twitch`: chat in your own channel, read as the account `jev-events auth twitch`
 * saved, or the one TWITCH_CLIENT_ID and TWITCH_ACCESS_TOKEN name when set. The CLI loads this only
 * when you watch it; `jev-events watch twitch:<channel>` reads any channel without signing in.
 */
export const cli = {
  twitch: {
    source: () => chat(),
    questions: { kind: recipes.chat.kind, hateful: recipes.chat.hateful },
    account: "your Twitch account",
    fromEnv: (): Connection | undefined => (process.env.TWITCH_ACCESS_TOKEN || process.env.TWITCH_REFRESH_TOKEN ? fromEnv() : undefined),
    connected: (_source: unknown, sessions: unknown[]) => {
      const reading = (sessions as Array<TwitchSession | undefined>).filter((session) => session !== undefined);
      const where = reading.map((session) => `#${session.channel} as ${session.login}`).join(", ");
      return `Reading ${where || "chat"}. New messages show up here.`;
    },
  },
};
