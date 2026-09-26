import { DEFAULT_CREDENTIALS_PATH, readCredentials } from "jev-events";

export interface SlackTokens {
  /**
   * The Bot User OAuth Token (xoxb-…) from your app's OAuth & Permissions page. A user token
   * (xoxp-…) works too: then messages are read, and actions run, as that person.
   */
  token: string;
  /** An app-level token (xapp-…) with the connections:write scope, for Socket Mode. */
  appToken?: string;
  /** From Basic Information. The Events API uses it to check that requests come from Slack. */
  signingSecret?: string;
  /** The workspace, saved by `jev-events auth slack`. */
  team?: string;
  teamId?: string;
  /** The app's bot user, saved by `jev-events auth slack`. */
  userId?: string;
  /** The bot's handle, as in "/invite @jev_events". */
  user?: string;
}

export interface SlackAuth {
  readonly token: string;
  readonly appToken: string | undefined;
  readonly signingSecret: string | undefined;
}

/** The connection is gone or was never made: missing, revoked or invalid tokens. Retrying won't help. */
export class SlackAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlackAuthError";
  }
}

const APP_TOKEN = /^xapp-/;
/** Bot and user tokens, including rotating ones (xoxe.xoxb-…). */
const BOT_OR_USER_TOKEN = /^(xoxe\.)?xox[bp]-/;

class Tokens implements SlackAuth {
  readonly #tokens: SlackTokens;

  constructor(tokens: SlackTokens) {
    this.#tokens = { ...tokens };
  }

  get token(): string {
    return this.#tokens.token;
  }

  get appToken(): string | undefined {
    return this.#tokens.appToken;
  }

  get signingSecret(): string | undefined {
    return this.#tokens.signingSecret;
  }
}

/** Throw a clear error when a token is missing, or is in the wrong place. */
export function checkTokens(tokens: Pick<SlackTokens, "token" | "appToken">): void {
  const { token, appToken } = tokens;
  if (!token) throw new Error("Slack needs a token: the Bot User OAuth Token (xoxb-…) from your app's OAuth & Permissions page.");
  if (APP_TOKEN.test(token)) {
    throw new Error("That's an app-level token (xapp-…), which goes in appToken. The token is the Bot User OAuth Token (xoxb-…).");
  }
  if (!BOT_OR_USER_TOKEN.test(token)) {
    throw new Error("A Slack token starts with xoxb- (a bot) or xoxp- (a user). Copy the Bot User OAuth Token from your app's OAuth & Permissions page.");
  }
  if (appToken !== undefined && !APP_TOKEN.test(appToken)) {
    throw new Error("appToken must be an app-level token (xapp-…), from Basic Information → App-Level Tokens.");
  }
}

/** Use tokens you manage yourself. */
export function withTokens(tokens: SlackTokens): SlackAuth {
  checkTokens(tokens);
  return new Tokens(tokens);
}

/** The workspace connected with `npx jev-events auth slack`. */
export function fromFile(path = DEFAULT_CREDENTIALS_PATH): SlackAuth {
  const tokens = readCredentials<SlackTokens>("slack", path);
  if (!tokens?.token) throw new SlackAuthError("Connect Slack first: npx jev-events auth slack");
  return withTokens(tokens);
}

/** SLACK_BOT_TOKEN, plus SLACK_APP_TOKEN for Socket Mode or SLACK_SIGNING_SECRET for the Events API. */
export function fromEnv(env: NodeJS.ProcessEnv = process.env): SlackAuth {
  const token = env.SLACK_BOT_TOKEN;
  if (!token) {
    throw new Error("Set SLACK_BOT_TOKEN (xoxb-…), plus SLACK_APP_TOKEN (xapp-…) for Socket Mode or SLACK_SIGNING_SECRET for the Events API.");
  }
  return withTokens({
    token,
    ...(env.SLACK_APP_TOKEN ? { appToken: env.SLACK_APP_TOKEN } : {}),
    ...(env.SLACK_SIGNING_SECRET ? { signingSecret: env.SLACK_SIGNING_SECRET } : {}),
  });
}
