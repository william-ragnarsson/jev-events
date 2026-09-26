import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkTokens, fromEnv, fromFile, SlackAuthError, withTokens } from "@jev-events/slack";
import { writeCredentials } from "jev-events";

function errorOf(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("It didn't throw.");
}

describe("withTokens", () => {
  it("keeps the bot token, the app-level token and the signing secret", () => {
    const auth = withTokens({ token: "xoxb-1-bot", appToken: "xapp-1-app", signingSecret: "s3cret" });

    expect([auth.token, auth.appToken, auth.signingSecret]).toEqual(["xoxb-1-bot", "xapp-1-app", "s3cret"]);
  });

  it("takes a user token, and rotating tokens", () => {
    expect(withTokens({ token: "xoxp-1-user" }).token).toBe("xoxp-1-user");
    expect(withTokens({ token: "xoxe.xoxb-1-rotating" }).token).toBe("xoxe.xoxb-1-rotating");
  });

  it("says which token goes where when one is missing, swapped or wrong", () => {
    expect(errorOf(() => withTokens({ token: "" })).message).toBe(
      "Slack needs a token: the Bot User OAuth Token (xoxb-…) from your app's OAuth & Permissions page.",
    );
    expect(errorOf(() => withTokens({ token: "xapp-1-app" })).message).toBe(
      "That's an app-level token (xapp-…), which goes in appToken. The token is the Bot User OAuth Token (xoxb-…).",
    );
    expect(errorOf(() => withTokens({ token: "sk-123" })).message).toBe(
      "A Slack token starts with xoxb- (a bot) or xoxp- (a user). Copy the Bot User OAuth Token from your app's OAuth & Permissions page.",
    );
    expect(errorOf(() => withTokens({ token: "xoxb-1-bot", appToken: "xoxb-2-bot" })).message).toBe(
      "appToken must be an app-level token (xapp-…), from Basic Information → App-Level Tokens.",
    );
  });

  it("never repeats a token in its errors", () => {
    const secret = "sk-live-do-not-print-1234";

    expect(errorOf(() => checkTokens({ token: secret })).message).not.toContain(secret);
    expect(errorOf(() => checkTokens({ token: "xoxb-1-bot", appToken: secret })).message).not.toContain(secret);
  });
});

describe("fromFile", () => {
  let folder: string;
  let path: string;

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), "jev-slack-auth-"));
    path = join(folder, "credentials.json");
  });

  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  it("reads what jev-events auth slack saved", () => {
    writeCredentials("slack", { token: "xoxb-1-bot", appToken: "xapp-1-app", team: "Acme", user: "jev_events" }, path);

    const auth = fromFile(path);

    expect([auth.token, auth.appToken, auth.signingSecret]).toEqual(["xoxb-1-bot", "xapp-1-app", undefined]);
  });

  it("says how to connect when nothing is saved", () => {
    const error = errorOf(() => fromFile(path));

    expect(error).toBeInstanceOf(SlackAuthError);
    expect(error.message).toBe("Connect Slack first: npx jev-events auth slack");
  });

  it("leaves other platforms' credentials alone", () => {
    writeCredentials("google", { refreshToken: "1//x" }, path);

    expect(() => fromFile(path)).toThrow("Connect Slack first");
  });
});

describe("fromEnv", () => {
  it("reads SLACK_BOT_TOKEN, SLACK_APP_TOKEN and SLACK_SIGNING_SECRET", () => {
    const auth = fromEnv({ SLACK_BOT_TOKEN: "xoxb-1-bot", SLACK_APP_TOKEN: "xapp-1-app", SLACK_SIGNING_SECRET: "s3cret" });

    expect([auth.token, auth.appToken, auth.signingSecret]).toEqual(["xoxb-1-bot", "xapp-1-app", "s3cret"]);
  });

  it("needs only the bot token", () => {
    const auth = fromEnv({ SLACK_BOT_TOKEN: "xoxb-1-bot" });

    expect([auth.appToken, auth.signingSecret]).toEqual([undefined, undefined]);
  });

  it("names the variables to set", () => {
    expect(errorOf(() => fromEnv({})).message).toBe(
      "Set SLACK_BOT_TOKEN (xoxb-…), plus SLACK_APP_TOKEN (xapp-…) for Socket Mode or SLACK_SIGNING_SECRET for the Events API.",
    );
  });

  it("catches tokens in the wrong variables", () => {
    expect(() => fromEnv({ SLACK_BOT_TOKEN: "xapp-1-app" })).toThrow("That's an app-level token (xapp-…), which goes in appToken.");
  });
});
