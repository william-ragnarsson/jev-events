import { SignInError, toConnection, type Connection } from "jev-events";

/** What a Slack connection's credentials hold. */
export interface SlackTokens {
  /**
   * The Bot User OAuth Token (xoxb-…) from your app's OAuth & Permissions page. A user token
   * (xoxp-…) works too: then messages are read, and actions run, as that person.
   */
  token: string;
  /**
   * An app-level token (xapp-…) with the connections:write scope. With it, new messages arrive over
   * Socket Mode; without it, Slack sends them to your runtime's `/webhook/slack` (the Events API).
   */
  appToken?: string;
}

/** The workspace has to be connected again: its token is missing, revoked or invalid. Retrying won't help. */
export class SlackAuthError extends SignInError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SlackAuthError";
  }
}

const APP_TOKEN = /^xapp-/;
/** Bot and user tokens, including rotating ones (xoxe.xoxb-…). */
const BOT_OR_USER_TOKEN = /^(xoxe\.)?xox[bp]-/;

/** What the two tokens are called where they came from, so errors name the right place. */
export interface TokenNames {
  token: string;
  appToken: string;
}

/** Throw a clear error when a token is missing, or is in the wrong place. Never repeats a token. */
export function checkTokens(tokens: Partial<SlackTokens>, names: TokenNames = { token: "token", appToken: "appToken" }): void {
  const { token, appToken } = tokens;
  if (!token) throw new Error("Slack needs a token: the Bot User OAuth Token (xoxb-…) from your app's OAuth & Permissions page.");
  if (APP_TOKEN.test(token)) {
    const which = names.token === "token" ? "The token" : names.token;
    throw new Error(`That's an app-level token (xapp-…), which goes in ${names.appToken}. ${which} is the Bot User OAuth Token (xoxb-…).`);
  }
  if (!BOT_OR_USER_TOKEN.test(token)) {
    throw new Error("A Slack token starts with xoxb- (a bot) or xoxp- (a user). Copy the Bot User OAuth Token from your app's OAuth & Permissions page.");
  }
  if (appToken !== undefined && !APP_TOKEN.test(appToken)) {
    throw new Error(`${names.appToken} must be an app-level token (xapp-…), from Basic Information → App-Level Tokens.`);
  }
}

/**
 * One workspace of your own from the environment: SLACK_BOT_TOKEN, plus SLACK_APP_TOKEN to get new
 * messages over Socket Mode. Pass it where a monitor starts, such as
 * `start({ connections: [slack.fromEnv()] })`.
 */
export function fromEnv(env: NodeJS.ProcessEnv = process.env): Connection {
  const token = env.SLACK_BOT_TOKEN;
  if (!token) throw new Error("Set SLACK_BOT_TOKEN (xoxb-…), plus SLACK_APP_TOKEN (xapp-…) to get new messages over Socket Mode.");
  const tokens: SlackTokens = { token, ...(env.SLACK_APP_TOKEN ? { appToken: env.SLACK_APP_TOKEN } : {}) };
  checkTokens(tokens, { token: "SLACK_BOT_TOKEN", appToken: "SLACK_APP_TOKEN" });
  return toConnection("slack", { account: "env", label: "SLACK_BOT_TOKEN", credentials: { ...tokens } });
}

/** The tokens in a connection's credentials, or a clear error when there are none. */
export function tokensOf(connection: Connection): SlackTokens {
  const { token, appToken } = connection.credentials;
  if (typeof token !== "string" || !token) {
    throw new SlackAuthError(`The Slack connection ${connection.label ?? connection.id} has no token. Connect the workspace again.`);
  }
  return { token, ...(typeof appToken === "string" && appToken ? { appToken } : {}) };
}
