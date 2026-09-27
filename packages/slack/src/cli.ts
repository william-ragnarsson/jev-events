import { recipes, type Connection } from "jev-events";

import { fromEnv } from "./auth.js";
import { conversationLabel } from "./directory.js";
import { messages, type SlackSession } from "./messages.js";

/**
 * `jev-events watch slack[:channel,channel]`, reading the workspaces saved by `jev-events auth slack`,
 * or the one SLACK_BOT_TOKEN and SLACK_APP_TOKEN name when set. The CLI loads this only when you
 * watch Slack.
 */
export const cli = {
  slack: {
    source: (target: string) => messages({ backfill: 5, ...(target ? { channels: target.split(",") } : {}) }),
    questions: { needsAnswer: recipes.team.needsAnswer, urgent: recipes.team.urgent, kind: recipes.team.kind },
    account: "a Slack workspace",
    fromEnv: (): Connection | undefined => {
      if (!process.env.SLACK_BOT_TOKEN) return undefined;
      if (!process.env.SLACK_APP_TOKEN) {
        throw new Error("Set SLACK_APP_TOKEN (xapp-…) too: the CLI gets new messages over Socket Mode, which needs the app-level token.");
      }
      return fromEnv();
    },
    connected: (_source: unknown, sessions: unknown[]) => {
      const workspaces = sessions as Array<SlackSession | undefined>;
      const conversations = workspaces.flatMap((session) => session?.conversations ?? []);
      if (conversations.length === 0) {
        const user = workspaces.find(Boolean)?.user;
        return `The app isn't in any channel yet. In Slack, open a channel and type /invite @${user ?? "<your app>"}, or send it a direct message. New messages show up here.`;
      }
      const labels = [...new Set(conversations.map(conversationLabel))];
      const named = labels.filter((label) => label.startsWith("#"));
      const shown = (named.length > 0 ? named : labels).slice(0, 3);
      const more = labels.length - shown.length;
      return `Showing the 5 latest messages from ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}, then new ones as they're posted.`;
    },
  },
};
