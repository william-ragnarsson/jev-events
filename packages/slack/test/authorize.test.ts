import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { authorize, MANIFEST, SETUP_STEPS, type AuthorizeOptions, type SlackTokens } from "@jev-events/slack";
import { readCredentials } from "jev-events";

import { APP_TOKEN, BOT_TOKEN, fakeSlack, GENERAL, RANDOM, type FakeSlack } from "./fake-slack.js";

let slack: FakeSlack;
let dir: string;
let path: string;
let lines: string[];

beforeEach(async () => {
  slack = await fakeSlack();
  dir = mkdtempSync(join(tmpdir(), "jev-slack-authorize-"));
  path = join(dir, "credentials.json");
  lines = [];
});

afterEach(async () => {
  await slack.close();
  rmSync(dir, { recursive: true, force: true });
});

const connect = (options: AuthorizeOptions = {}) => authorize({ path, env: {}, print: (line) => void lines.push(line), ...options });
const withBoth: AuthorizeOptions = { token: BOT_TOKEN, "app-token": APP_TOKEN };
const steps = SETUP_STEPS.map((step, index) => `  ${index + 1}. ${step}`);
const saved = () => readCredentials<SlackTokens>("slack", path);

/** Run with stdin not a terminal, as when piped, so authorize can't ask. */
async function withoutTerminal<T>(run: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true, writable: true });
  try {
    return await run();
  } finally {
    if (original) Object.defineProperty(process.stdin, "isTTY", original);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
  }
}

describe("authorize", () => {
  it("checks both tokens, saves them and says where the app is", async () => {
    const workspace = await connect(withBoth);

    expect(workspace).toEqual({ team: "Acme", teamId: "T0ACME", user: "jev_events", conversations: ["#general", "#random"] });
    expect(saved()).toEqual({ token: BOT_TOKEN, appToken: APP_TOKEN, team: "Acme", teamId: "T0ACME", userId: "U0BOT", user: "jev_events" });
    expect(lines).toEqual([
      "",
      `  Connected to Acme as @jev_events. Saved to ${path}.`,
      "  It's in #general, #random.",
      "",
      "  Try it:  npx jev-events watch slack",
    ]);
  });

  it("takes the tokens from SLACK_BOT_TOKEN and SLACK_APP_TOKEN", async () => {
    await connect({ env: { SLACK_BOT_TOKEN: BOT_TOKEN, SLACK_APP_TOKEN: APP_TOKEN } });

    expect(saved()).toMatchObject({ token: BOT_TOKEN, appToken: APP_TOKEN });
  });

  it("walks you through making the app, then asks for the two tokens", async () => {
    const asked: string[] = [];
    const answers = [` ${BOT_TOKEN}\n`, `${APP_TOKEN} `];
    await connect({ askSecret: async (question) => (asked.push(question), answers.shift() ?? "") });

    expect(lines.slice(0, 8)).toEqual(["", "  Slack needs an app of your own. One-time setup, about 2 minutes:", "", ...steps, ""]);
    expect(asked).toEqual(["  Bot User OAuth Token (xoxb-…): ", "  App-level token (xapp-…): "]);
    expect(saved()).toMatchObject({ token: BOT_TOKEN, appToken: APP_TOKEN });
  });

  it("asks only for the token it doesn't have", async () => {
    const asked: string[] = [];
    await connect({ token: BOT_TOKEN, askSecret: async (question) => (asked.push(question), APP_TOKEN) });

    expect(asked).toEqual(["  App-level token (xapp-…): "]);
  });

  it("lists the setup steps when it can't ask", async () => {
    const error = await withoutTerminal(() => connect()).catch((caught: unknown) => caught);

    expect((error as Error).message).toBe(
      `Slack needs an app of your own first (one-time, about 2 minutes):\n\n${steps.join("\n")}\n\n  Then run: npx jev-events auth slack --token <xoxb-…> --app-token <xapp-…>`,
    );
    expect(slack.calls()).toEqual([]);
    expect(existsSync(path)).toBe(false);
  });

  it("says when the tokens are swapped", async () => {
    await expect(connect({ token: APP_TOKEN, "app-token": BOT_TOKEN })).rejects.toThrow(
      "That's an app-level token (xapp-…), which goes in appToken. The token is the Bot User OAuth Token (xoxb-…).",
    );
    expect(slack.calls()).toEqual([]);
  });

  const copyBotToken = `Copy the Bot User OAuth Token again from OAuth & Permissions (if it's gone, click "Install to Workspace" there first).`;
  it.each([
    ["a wrong bot token", () => ({ token: "xoxb-1-wrong" }), `Slack refused the bot token (invalid_auth). ${copyBotToken}`],
    ["a revoked bot token", () => (slack.revoke(), {}), `Slack refused the bot token (token_revoked). ${copyBotToken}`],
    [
      "a wrong app-level token",
      () => ({ "app-token": "xapp-1-wrong" }),
      "Slack refused the app-level token (invalid_auth). Copy it again from Basic Information → App-Level Tokens.",
    ],
    [
      "a revoked app-level token",
      () => (slack.revokeAppToken(), {}),
      "Slack refused the app-level token (token_revoked). Copy it again from Basic Information → App-Level Tokens.",
    ],
    [
      "an app-level token without connections:write",
      () => (slack.appTokenWithoutScope(), {}),
      "The app-level token lacks the connections:write scope. Make a new one under Basic Information → App-Level Tokens with that scope.",
    ],
  ])("says which token to fix, given %s, and saves nothing", async (_, setup, message) => {
    const error = await connect({ ...withBoth, ...setup() }).catch((caught: unknown) => caught);

    expect((error as Error).message).toBe(message);
    expect((error as Error).message).not.toMatch(/xox|xapp-1/);
    expect(existsSync(path)).toBe(false);
  });

  it("says how to add the app to a channel when it's in none", async () => {
    slack.leave(GENERAL);
    slack.leave(RANDOM);
    const workspace = await connect(withBoth);

    expect(workspace.conversations).toEqual([]);
    expect(lines).toEqual([
      "",
      `  Connected to Acme as @jev_events. Saved to ${path}.`,
      "  It isn't in any channel yet. In Slack, open a channel and type: /invite @jev_events",
      "  (or send it a direct message).",
      "",
      "  Try it:  npx jev-events watch slack",
    ]);
  });

  it("names five channels and counts the rest", async () => {
    for (const name of ["design", "eng", "sales", "support", "marketing"]) slack.addConversation({ id: `C0${name.toUpperCase()}`, name });
    await connect(withBoth);

    expect(lines[2]).toBe("  It's in #general, #random, #design, #eng, #sales and 2 more.");
  });
});

describe("MANIFEST", () => {
  it("asks for what the source and the actions use, with Socket Mode on", () => {
    expect([...MANIFEST.oauth_config.scopes.bot].sort()).toEqual(
      [
        "channels:history",
        "channels:read",
        "chat:write",
        "groups:history",
        "groups:read",
        "im:history",
        "im:read",
        "mpim:history",
        "mpim:read",
        "reactions:write",
        "users:read",
      ].sort(),
    );
    expect(MANIFEST.settings.event_subscriptions.bot_events).toEqual(["message.channels", "message.groups", "message.im", "message.mpim"]);
    expect(MANIFEST.settings.socket_mode_enabled).toBe(true);
  });

  it("is what the first step's link fills in", () => {
    const step = SETUP_STEPS[0] ?? "";
    const link = new URL(step.slice(step.indexOf("https://")));

    expect(`${link.origin}${link.pathname}`).toBe("https://api.slack.com/apps");
    expect(link.searchParams.get("new_app")).toBe("1");
    expect(JSON.parse(link.searchParams.get("manifest_json") ?? "null")).toEqual(MANIFEST);
  });
});
