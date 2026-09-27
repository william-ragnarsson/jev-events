import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import { connectionInfo, fileStore, toConnection, type ConnectionInfo, type Store } from "jev-events";

import { SlackApi, SlackApiError } from "./api.js";
import { checkTokens } from "./auth.js";
import { conversationLabel, toConversation, type ApiConversation } from "./directory.js";
import { manifestUrl } from "./manifest.js";

export interface AuthorizeOptions {
  /** The Bot User OAuth Token (xoxb-…). Default: SLACK_BOT_TOKEN, or asked for. */
  token?: string;
  /** The app-level token (xapp-…) for Socket Mode. Default: SLACK_APP_TOKEN, or asked for. */
  "app-token"?: string;
  /** The file store to save the connection in. Default ".jev-events", where the CLI and `fileStore()` look. */
  dir?: string;
  /** Save the connection in this store instead, such as your Postgres store. */
  store?: Store;
  /** Where to print instructions. Default stdout. */
  print?: (line: string) => void;
  /** Ask for a token and return it. Default: the terminal, when there is one. */
  askSecret?: (question: string) => Promise<string>;
  env?: NodeJS.ProcessEnv;
}

export interface SlackWorkspace {
  team: string;
  teamId: string;
  /** The app's handle, as in /invite @jev_events. */
  user: string;
  /** Where the app is: "#general", "DM"… */
  conversations: string[];
  /** The saved connection, without its tokens. */
  connection: ConnectionInfo;
}

interface AuthTest {
  url: string;
  team: string;
  user: string;
  team_id: string;
  user_id: string;
  bot_id?: string;
}

/** The one-time setup of a Slack app, as numbered steps. The first link fills in the app for you. */
export const SETUP_STEPS = [
  `Create the app (everything is filled in; pick your workspace, then click Next and Create): ${manifestUrl()}`,
  'Click "Install to Workspace", then Allow',
  'Under OAuth & Permissions, copy the "Bot User OAuth Token" (xoxb-…)',
  'Under Basic Information → App-Level Tokens, click "Generate Token and Scopes", add the connections:write scope, generate, and copy the token (xapp-…)',
];

/**
 * Connect a Slack workspace from the terminal: check the app's two tokens, then save the connection
 * in the file store, where monitors started without `connections` find it. This is what
 * `npx jev-events auth slack` runs. The first time, it walks you through creating the app.
 */
export async function authorize(options: AuthorizeOptions = {}): Promise<SlackWorkspace> {
  const print = options.print ?? ((line: string) => process.stdout.write(`${line}\n`));
  const env = options.env ?? process.env;
  const dir = options.dir ?? ".jev-events";
  let token = options.token ?? env.SLACK_BOT_TOKEN;
  let appToken = options["app-token"] ?? env.SLACK_APP_TOKEN;

  if (!token || !appToken) {
    const steps = SETUP_STEPS.map((step, index) => `  ${index + 1}. ${step}`);
    const ask = options.askSecret ?? (process.stdin.isTTY ? askInTerminal : undefined);
    if (!ask) {
      throw new Error(
        `Slack needs an app of your own first (one-time, about 2 minutes):\n\n${steps.join("\n")}\n\n  Then run: npx jev-events auth slack --token <xoxb-…> --app-token <xapp-…>`,
      );
    }
    print("");
    print("  Slack needs an app of your own. One-time setup, about 2 minutes:");
    print("");
    for (const step of steps) print(step);
    print("");
    token ??= await ask("  Bot User OAuth Token (xoxb-…): ");
    appToken ??= await ask("  App-level token (xapp-…): ");
  }
  token = token.trim();
  appToken = appToken.trim();
  checkTokens({ token, appToken });

  const api = new SlackApi(token);
  const me = await checkBotToken(api);
  await checkAppToken(new SlackApi(appToken));
  let where: string[] = [];
  try {
    const channels = await api.list<ApiConversation>("users.conversations", "channels", { types: "public_channel,private_channel", exclude_archived: true });
    where = channels.map((channel) => conversationLabel(toConversation({ is_member: true, ...channel })));
  } catch {
    // Only for the message below.
  }

  const store = options.store ?? fileStore(dir);
  const connection = toConnection("slack", {
    account: me.team_id,
    label: me.team,
    credentials: { token, appToken },
    facts: {
      team: me.team,
      teamId: me.team_id,
      userId: me.user_id,
      user: me.user,
      url: me.url,
      ...(me.bot_id ? { botId: me.bot_id } : {}),
    },
  });
  await store.connections.save(connection);
  await store.flush?.();

  print("");
  print(`  Connected to ${me.team} as @${me.user}.${options.store ? "" : ` Saved to ${join(dir, "store.json")}.`}`);
  if (where.length > 0) {
    print(`  It's in ${where.slice(0, 5).join(", ")}${where.length > 5 ? ` and ${where.length - 5} more` : ""}.`);
  } else {
    print(`  It isn't in any channel yet. In Slack, open a channel and type: /invite @${me.user}`);
    print("  (or send it a direct message).");
  }
  print("");
  print("  Try it:  npx jev-events watch slack");
  return { team: me.team, teamId: me.team_id, user: me.user, conversations: where, connection: connectionInfo(connection) };
}

/** Who the bot token belongs to, with an error that says where to copy it from when Slack refuses it. */
async function checkBotToken(api: SlackApi): Promise<AuthTest> {
  try {
    return await api.call<AuthTest>("auth.test");
  } catch (error) {
    if (error instanceof SlackApiError && error.signedOut) {
      throw new Error(
        `Slack refused the bot token (${error.code}). Copy the Bot User OAuth Token again from OAuth & Permissions (if it's gone, click "Install to Workspace" there first).`,
      );
    }
    throw error;
  }
}

/** Socket Mode opens with the app-level token; check it can. */
async function checkAppToken(api: SlackApi): Promise<void> {
  try {
    await api.call("apps.connections.open");
  } catch (error) {
    if (error instanceof SlackApiError) {
      if (error.code === "missing_scope") {
        throw new Error("The app-level token lacks the connections:write scope. Make a new one under Basic Information → App-Level Tokens with that scope.");
      }
      if (error.signedOut) throw new Error(`Slack refused the app-level token (${error.code}). Copy it again from Basic Information → App-Level Tokens.`);
    }
    throw error;
  }
}

async function askInTerminal(question: string): Promise<string> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await terminal.question(question);
  } finally {
    terminal.close();
  }
}
