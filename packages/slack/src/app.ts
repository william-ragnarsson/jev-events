import type { App, NewConnection, OAuthFlow } from "jev-events";

import { SlackApi, SlackApiError } from "./api.js";
import { authorizeUrl } from "./endpoints.js";
import { BOT_SCOPES } from "./scopes.js";

export interface SlackAppOptions {
  /** Your Slack app's Client ID, from Basic Information → App Credentials. Default: SLACK_CLIENT_ID. */
  clientId?: string;
  /** Default: SLACK_CLIENT_SECRET. */
  clientSecret?: string;
  /** Checks that requests to `/webhook/slack` come from Slack. Default: SLACK_SIGNING_SECRET. */
  signingSecret?: string;
  /**
   * An app-level token (xapp-…) with connections:write. With it, `jev.start()` gets new messages
   * from every connected workspace over one Socket Mode connection instead of the Events API.
   * Default: SLACK_APP_TOKEN.
   */
  appToken?: string;
  /** The bot scopes each workspace is asked for. Default: what `slack.messages()` and the actions need. */
  scopes?: readonly string[];
}

/** Your Slack app. Register it with `runtime({ apps: [slack.app()] })`. */
export interface SlackApp extends App {
  readonly integration: "slack";
  readonly clientId: string | undefined;
  readonly clientSecret: string | undefined;
  readonly signingSecret: string | undefined;
  readonly appToken: string | undefined;
  readonly scopes: readonly string[];
  readonly oauth: OAuthFlow;
}

/** What Slack's `oauth.v2.access` returns for a bot install. */
interface Installed {
  access_token?: string;
  bot_user_id?: string;
  app_id?: string;
  team?: { id?: string; name?: string } | null;
}

interface AuthTest {
  url: string;
  team: string;
  user: string;
  team_id: string;
  user_id: string;
  bot_id?: string;
}

const NO_CLIENT =
  "Slack needs your app's credentials: set SLACK_CLIENT_ID and SLACK_CLIENT_SECRET, or pass slack.app({ clientId, clientSecret }). They're under Basic Information → App Credentials at https://api.slack.com/apps";

/**
 * Your Slack app, so people can add it to their workspaces through `/connect/slack`, and so
 * `/webhook/slack` can check that events come from Slack. Each setting defaults to its environment
 * variable, read when first needed.
 */
export function app(options: SlackAppOptions = {}): SlackApp {
  const scopes = [...new Set(options.scopes ?? BOT_SCOPES)];
  const env = (name: string) => process.env[name] || undefined;
  const clientId = () => options.clientId ?? env("SLACK_CLIENT_ID");
  const clientSecret = () => options.clientSecret ?? env("SLACK_CLIENT_SECRET");
  const client = () => {
    const id = clientId();
    const secret = clientSecret();
    if (!id || !secret) throw new Error(NO_CLIENT);
    return { id, secret };
  };
  return {
    integration: "slack",
    get clientId() {
      return clientId();
    },
    get clientSecret() {
      return clientSecret();
    },
    get signingSecret() {
      return options.signingSecret ?? env("SLACK_SIGNING_SECRET");
    },
    get appToken() {
      return options.appToken ?? env("SLACK_APP_TOKEN");
    },
    scopes,
    oauth: {
      authorizeUrl: ({ redirectUri, state, scopes: extra }) => {
        const url = new URL(authorizeUrl());
        url.search = new URLSearchParams({
          client_id: client().id,
          scope: [...new Set([...scopes, ...(extra ?? [])])].join(","),
          redirect_uri: redirectUri,
          state,
        }).toString();
        return url.href;
      },
      complete: async ({ code, redirectUri }) => {
        const { id, secret } = client();
        return install(await exchange({ id, secret, code, redirectUri }));
      },
    },
  };
}

/** Trade the code from Slack's redirect for the workspace's bot token. */
async function exchange(options: { id: string; secret: string; code: string; redirectUri: string }): Promise<Installed> {
  try {
    return await new SlackApi(undefined).call<Installed>("oauth.v2.access", {
      client_id: options.id,
      client_secret: options.secret,
      code: options.code,
      redirect_uri: options.redirectUri,
    });
  } catch (error) {
    if (!(error instanceof SlackApiError)) throw error;
    switch (error.code) {
      case "invalid_client_id":
      case "bad_client_secret":
        throw new Error(
          "Slack refused the sign-in: the client ID or secret is wrong. Check SLACK_CLIENT_ID and SLACK_CLIENT_SECRET (Basic Information → App Credentials).",
        );
      case "bad_redirect_uri":
      case "oauth_authorization_url_mismatch":
        throw new Error(`Slack refused the sign-in: add ${options.redirectUri} under OAuth & Permissions → Redirect URLs.`);
      case "invalid_code":
      case "code_already_used":
      case "code_expired":
        throw new Error("Slack refused the sign-in: the code expired or was already used. Try connecting again.");
      default:
        throw new Error(`Slack refused the sign-in: ${error.code}.`);
    }
  }
}

/** The connection to save for a new install: the workspace, and who the app is in it. */
async function install(installed: Installed): Promise<NewConnection> {
  const token = installed.access_token;
  if (!token) throw new Error("Slack finished the sign-in without a bot token. Add bot scopes under OAuth & Permissions, then try again.");
  const me = await new SlackApi(token).call<AuthTest>("auth.test");
  const team = installed.team?.name ?? me.team;
  return {
    account: me.team_id,
    label: team,
    credentials: { token },
    facts: {
      team,
      teamId: me.team_id,
      userId: me.user_id,
      user: me.user,
      url: me.url,
      ...(me.bot_id ? { botId: me.bot_id } : {}),
      ...(installed.app_id ? { appId: installed.app_id } : {}),
    },
  };
}
