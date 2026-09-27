import { describe, expect, it } from "vitest";

import { checkTokens, fromEnv, SlackAuthError, tokensOf } from "@jev-events/slack";
import { needsSignIn, toConnection } from "jev-events";

function errorOf(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("It didn't throw.");
}

describe("checkTokens", () => {
  it("takes a bot token, a user token and rotating tokens, with or without an app-level token", () => {
    expect(() => checkTokens({ token: "xoxb-1-bot", appToken: "xapp-1-app" })).not.toThrow();
    expect(() => checkTokens({ token: "xoxp-1-user" })).not.toThrow();
    expect(() => checkTokens({ token: "xoxe.xoxb-1-rotating" })).not.toThrow();
  });

  it("says which token goes where when one is missing, swapped or wrong", () => {
    expect(errorOf(() => checkTokens({ token: "" })).message).toBe(
      "Slack needs a token: the Bot User OAuth Token (xoxb-…) from your app's OAuth & Permissions page.",
    );
    expect(errorOf(() => checkTokens({ token: "xapp-1-app" })).message).toBe(
      "That's an app-level token (xapp-…), which goes in appToken. The token is the Bot User OAuth Token (xoxb-…).",
    );
    expect(errorOf(() => checkTokens({ token: "sk-123" })).message).toBe(
      "A Slack token starts with xoxb- (a bot) or xoxp- (a user). Copy the Bot User OAuth Token from your app's OAuth & Permissions page.",
    );
    expect(errorOf(() => checkTokens({ token: "xoxb-1-bot", appToken: "xoxb-2-bot" })).message).toBe(
      "appToken must be an app-level token (xapp-…), from Basic Information → App-Level Tokens.",
    );
  });

  it("never repeats a token in its errors", () => {
    const secret = "sk-live-do-not-print-1234";

    expect(errorOf(() => checkTokens({ token: secret })).message).not.toContain(secret);
    expect(errorOf(() => checkTokens({ token: "xoxb-1-bot", appToken: secret })).message).not.toContain(secret);
  });
});

describe("fromEnv", () => {
  it("makes a connection from SLACK_BOT_TOKEN and SLACK_APP_TOKEN", () => {
    const connection = fromEnv({ SLACK_BOT_TOKEN: "xoxb-1-bot", SLACK_APP_TOKEN: "xapp-1-app" });

    expect(connection).toMatchObject({
      id: "slack:env",
      integration: "slack",
      label: "SLACK_BOT_TOKEN",
      credentials: { token: "xoxb-1-bot", appToken: "xapp-1-app" },
    });
  });

  it("needs only the bot token", () => {
    expect(fromEnv({ SLACK_BOT_TOKEN: "xoxb-1-bot" }).credentials).toEqual({ token: "xoxb-1-bot" });
  });

  it("names the variables to set", () => {
    expect(errorOf(() => fromEnv({})).message).toBe(
      "Set SLACK_BOT_TOKEN (xoxb-…), plus SLACK_APP_TOKEN (xapp-…) to get new messages over Socket Mode.",
    );
  });

  it("catches tokens in the wrong variables", () => {
    expect(errorOf(() => fromEnv({ SLACK_BOT_TOKEN: "xapp-1-app" })).message).toBe(
      "That's an app-level token (xapp-…), which goes in SLACK_APP_TOKEN. SLACK_BOT_TOKEN is the Bot User OAuth Token (xoxb-…).",
    );
    expect(errorOf(() => fromEnv({ SLACK_BOT_TOKEN: "xoxb-1-bot", SLACK_APP_TOKEN: "xoxb-2-bot" })).message).toBe(
      "SLACK_APP_TOKEN must be an app-level token (xapp-…), from Basic Information → App-Level Tokens.",
    );
  });
});

describe("tokensOf", () => {
  it("reads the tokens a connection saved", () => {
    const connection = toConnection("slack", { account: "T0ACME", label: "Acme", credentials: { token: "xoxb-1-bot", appToken: "xapp-1-app" } });

    expect(tokensOf(connection)).toEqual({ token: "xoxb-1-bot", appToken: "xapp-1-app" });
  });

  it("leaves the app-level token out when there is none", () => {
    const connection = toConnection("slack", { account: "T0ACME", label: "Acme", credentials: { token: "xoxb-1-bot", appToken: "" } });

    expect(tokensOf(connection)).toEqual({ token: "xoxb-1-bot" });
  });

  it("asks for a new sign-in when the connection has no token", () => {
    const error = errorOf(() => tokensOf(toConnection("slack", { account: "T0ACME", label: "Acme", credentials: {} })));

    expect(error).toBeInstanceOf(SlackAuthError);
    expect(needsSignIn(error)).toBe(true);
    expect(error.message).toBe("The Slack connection Acme has no token. Connect the workspace again.");
  });
});
