import { recipes } from "jev-events";

import { fromEnv, fromFile } from "./auth.js";
import { conversationLabel } from "./directory.js";
import { messages, type SlackMessagesSource } from "./messages.js";

/**
 * `jev-events watch slack[:channel,channel]`, using the app saved by `jev-events auth slack`, or
 * SLACK_BOT_TOKEN and SLACK_APP_TOKEN when set. The CLI loads this only when you watch Slack.
 */
export const cli = {
  slack: {
    source: (target: string) =>
      messages({
        auth: process.env.SLACK_BOT_TOKEN ? fromEnv() : fromFile(),
        backfill: 5,
        ...(target ? { channels: target.split(",") } : {}),
      }),
    questions: { needsAnswer: recipes.team.needsAnswer, urgent: recipes.team.urgent, kind: recipes.team.kind },
    connected: (source: SlackMessagesSource) => {
      const session = source.session;
      if (!session || session.conversations.length === 0) {
        return `The app isn't in any channel yet. In Slack, open a channel and type /invite @${session?.user ?? "<your app>"}, or send it a direct message. New messages show up here.`;
      }
      const labels = [...new Set(session.conversations.map(conversationLabel))];
      const named = labels.filter((label) => label.startsWith("#"));
      const shown = (named.length > 0 ? named : labels).slice(0, 3);
      const more = labels.length - shown.length;
      return `Showing the 5 latest messages from ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}, then new ones as they're posted.`;
    },
  },
};
