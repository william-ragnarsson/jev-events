import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fileStore, toConnection } from "jev-events";

import { fakeJevServer, type FakeJev } from "../../core/test/fake-jev.js";
import { liveCli, runCli, type LiveCli } from "../../core/test/run-cli.js";
import { APP_TOKEN, BOB, BOT_TOKEN, fakeSlack, GENERAL, RANDOM, type FakeSlack } from "./fake-slack.js";
import { waitFor } from "./helpers.js";

// These run the real CLI in a child process. It talks HTTP and Socket Mode to a fake Slack (the
// child inherits JEV_SLACK_API_URL from the fake) and HTTP to a fake Jev.

let jev: FakeJev;
let slack: FakeSlack;
let env: Record<string, string | undefined>;
let cwd: string;
let live: LiveCli[] = [];

beforeEach(async () => {
  jev = await fakeJevServer();
  slack = await fakeSlack();
  vi.stubEnv("JEV_EVENTS_KEY", undefined);
  env = {
    TYPESAFE_API_KEY: "test-key",
    TYPESAFE_BASE_URL: jev.url,
    SLACK_BOT_TOKEN: undefined,
    SLACK_APP_TOKEN: undefined,
    SLACK_SIGNING_SECRET: undefined,
    JEV_EVENTS_KEY: undefined,
  };
  // Real path, since macOS's temp folder is behind a symlink.
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "jev-slack-cli-")));
});

afterEach(async () => {
  await Promise.all(live.map((cli) => cli.stop()));
  live = [];
  await jev.close();
  await slack.close();
  vi.unstubAllEnvs();
  rmSync(cwd, { recursive: true, force: true });
});

const saved = () => fileStore(join(cwd, ".jev-events"));
const storeFile = () => join(cwd, ".jev-events", "store.json");

/** Save the fake workspace where `jev-events auth slack` saves it. */
async function connectSlack(credentials: Record<string, string> = {}): Promise<void> {
  const store = saved();
  const connection = slack.connection();
  await store.connections.save(toConnection("slack", { ...connection, credentials: { ...connection.credentials, ...credentials } }));
  await store.close?.();
}

/** What the store in .jev-events holds now, as the next `jev-events` run reads it. */
async function savedConnections() {
  const store = saved();
  try {
    return await store.connections.list({ integration: "slack" });
  } finally {
    await store.close?.();
  }
}

function watch(source: string, extra: Record<string, string | undefined> = {}): LiveCli {
  const cli = liveCli(["watch", source], { ...env, ...extra }, cwd);
  live.push(cli);
  return cli;
}

const questionsAsked = () => jev.requests.map((request) => Object.keys(request.body.questions ?? {}));
const signedOut = "Slack signed this workspace out (token_revoked): the token was revoked or isn't valid.";

describe("jev-events watch slack", () => {
  it("judges the latest messages, then new ones as they're posted", async () => {
    await connectSlack();
    slack.post({ channel: GENERAL, text: "Deploy at 5", live: false });
    slack.post({ channel: RANDOM, user: BOB, text: "Lunch anyone?", live: false });

    const cli = watch("slack");
    await waitFor(() => cli.lines().filter((line) => /Deploy at 5|Lunch anyone\?/.test(line)).length === 2, 20_000, "the latest messages");
    slack.post({ channel: GENERAL, text: "Is prod down?" });
    await waitFor(() => cli.lines().some((line) => line.includes("Is prod down?")), 20_000, "the new message");
    const run = await cli.stop();

    expect(run.stderr).toBe("");
    expect(run.stdout).toMatch(/◆ jev-events {2}watching slack:messages {2}· {2}asking needsAnswer, urgent, kind \(/);
    expect(run.stdout).toContain("connected. Showing the 5 latest messages from #general, #random and 1 more, then new ones as they're posted.");
    expect(run.stdout).toMatch(/Ann Smith +Deploy at 5/);
    expect(run.stdout).toMatch(/Bob +Lunch anyone\?/);
    expect(run.stdout).toMatch(/Ann Smith +Is prod down\?/);
    expect(questionsAsked()).toEqual([
      ["needsAnswer", "urgent", "kind"],
      ["needsAnswer", "urgent", "kind"],
      ["needsAnswer", "urgent", "kind"],
    ]);
    expect(run.code).toBe(0);
  }, 30_000);

  it("watches only the channels you name with slack:<channel>", async () => {
    await connectSlack();
    slack.post({ channel: RANDOM, text: "Lunch anyone?", live: false });
    slack.post({ channel: GENERAL, text: "Deploy at 5", live: false });

    const cli = watch("slack:general");
    await waitFor(() => cli.lines().some((line) => line.includes("Deploy at 5")), 20_000, "the #general message");
    const run = await cli.stop();

    expect(run.stdout).toContain("watching slack:#general");
    expect(run.stdout).toContain("connected. Showing the 5 latest messages from #general, then new ones as they're posted.");
    expect(run.stdout).not.toContain("Lunch anyone?");
  }, 30_000);

  it("uses the tokens in .env instead of the saved workspace, and saves nothing", async () => {
    await connectSlack({ token: "xoxb-1-old-token" });
    writeFileSync(join(cwd, ".env"), `SLACK_BOT_TOKEN=${BOT_TOKEN}\nSLACK_APP_TOKEN=${APP_TOKEN}\n`);
    slack.post({ channel: GENERAL, text: "Deploy at 5", live: false });

    const cli = watch("slack");
    await waitFor(() => cli.lines().some((line) => line.includes("Deploy at 5")), 20_000, "the message");
    const run = await cli.stop();

    expect(run.stderr).toBe("");
    expect((await savedConnections()).map((connection) => [connection.id, connection.credentials.token, connection.status ?? "active"])).toEqual([
      ["slack:T0ACME", "xoxb-1-old-token", "active"],
    ]);
  }, 30_000);

  it("works from .env alone, without a saved workspace", async () => {
    writeFileSync(join(cwd, ".env"), `SLACK_BOT_TOKEN=${BOT_TOKEN}\nSLACK_APP_TOKEN=${APP_TOKEN}\n`);
    slack.post({ channel: GENERAL, text: "Deploy at 5", live: false });

    const cli = watch("slack");
    await waitFor(() => cli.lines().some((line) => line.includes("Deploy at 5")), 20_000, "the message");
    const run = await cli.stop();

    expect(run.stderr).toBe("");
    expect(existsSync(storeFile())).toBe(false);
  }, 30_000);

  it("asks for SLACK_APP_TOKEN too when only SLACK_BOT_TOKEN is set", async () => {
    const run = await runCli(["watch", "slack"], { env: { ...env, SLACK_BOT_TOKEN: BOT_TOKEN }, cwd });

    expect(run.stderr).toBe("✖ Set SLACK_APP_TOKEN (xapp-…) too: the CLI gets new messages over Socket Mode, which needs the app-level token.\n");
    expect(run.code).toBe(1);
  }, 30_000);

  it("asks you to connect Slack first, before asking for a TypeSafe key", async () => {
    const run = await runCli(["watch", "slack"], { env: { ...env, TYPESAFE_API_KEY: undefined }, cwd });

    expect(run.stderr).toBe("✖ Connect a Slack workspace first: npx jev-events auth slack\n");
    expect(run.stdout).toBe("");
    expect(run.code).toBe(1);
  }, 30_000);

  it("gives the command that works in this repo under npm run cli", async () => {
    const run = await runCli(["watch", "slack"], { env: { ...env, npm_lifecycle_event: "cli" }, cwd });

    expect(run.stderr).toBe("✖ Connect a Slack workspace first: npm run cli -- auth slack\n");
  }, 30_000);

  it("says so when Slack signed the workspace out, and remembers it for next time", async () => {
    await connectSlack();
    slack.revoke();

    const first = await runCli(["watch", "slack"], { env, cwd });
    const second = await runCli(["watch", "slack"], { env, cwd });

    expect(first.stderr).toContain(`✖ ${signedOut} Sign in again: npx jev-events auth slack`);
    expect(first.code).toBe(1);
    expect(second.stderr).toBe(`✖ Acme needs a new sign-in: npx jev-events auth slack\n  ${signedOut}\n`);
    expect(second.code).toBe(1);
    expect(await savedConnections()).toMatchObject([{ status: "needs-sign-in", problem: signedOut }]);
    expect(jev.requests).toEqual([]);
  }, 30_000);

  it("says to check the variable when Slack refuses the token from .env", async () => {
    writeFileSync(join(cwd, ".env"), `SLACK_BOT_TOKEN=${BOT_TOKEN}\nSLACK_APP_TOKEN=${APP_TOKEN}\n`);
    slack.revoke();

    const run = await runCli(["watch", "slack"], { env, cwd });

    expect(run.stderr).toContain(`✖ ${signedOut} Check SLACK_BOT_TOKEN.`);
    expect(run.code).toBe(1);
    expect(existsSync(storeFile())).toBe(false);
  }, 30_000);

  it("stops with the fix when Socket Mode is turned off", async () => {
    await connectSlack();
    const cli = watch("slack");
    await waitFor(() => cli.stdout.includes("connected."), 20_000, "the connection");
    slack.disconnect("link_disabled");
    const run = await cli.done();

    expect(run.stderr).toBe("✖ Socket Mode is off for this Slack app. Turn it on under Settings → Socket Mode, then try again.\n");
    expect(run.code).toBe(1);
  }, 30_000);
});

describe("jev-events auth slack", () => {
  it("checks the tokens and saves the workspace", async () => {
    const run = await runCli(["auth", "slack", "--token", BOT_TOKEN, "--app-token", APP_TOKEN], { env, cwd });

    expect(run.stderr).toBe("");
    expect(run.stdout).toContain("Connected to Acme as @jev_events. Saved to .jev-events/store.json.");
    expect(run.stdout).toContain("It's in #general, #random.");
    expect(run.stdout).toContain("Try it:  npx jev-events watch slack");
    expect(await savedConnections()).toMatchObject([{ id: "slack:T0ACME", label: "Acme", credentials: { token: BOT_TOKEN, appToken: APP_TOKEN } }]);
    expect(run.code).toBe(0);
  }, 30_000);

  it("lists the one-time setup when there's no terminal to ask in", async () => {
    const run = await runCli(["auth", "slack"], { env, cwd });

    expect(run.stderr).toContain("✖ Slack needs an app of your own first (one-time, about 2 minutes):");
    expect(run.stderr).toContain("https://api.slack.com/apps?new_app=1&manifest_json=");
    expect(run.stderr).toContain("Then run: npx jev-events auth slack --token <xoxb-…> --app-token <xapp-…>");
    expect(run.code).toBe(1);
    expect(existsSync(storeFile())).toBe(false);
  }, 30_000);

  it("gives the command that works in this repo under npm run cli", async () => {
    const run = await runCli(["auth", "slack"], { env: { ...env, npm_lifecycle_event: "cli" }, cwd });

    expect(run.stderr).toContain("Then run: npm run cli -- auth slack --token <xoxb-…> --app-token <xapp-…>");
  }, 30_000);

  it("says when Slack refuses the token, and saves nothing", async () => {
    const run = await runCli(["auth", "slack", "--token", "xoxb-1-wrong", "--app-token", APP_TOKEN], { env, cwd });

    expect(run.stderr).toBe(
      `✖ Slack refused the bot token (invalid_auth). Copy the Bot User OAuth Token again from OAuth & Permissions (if it's gone, click "Install to Workspace" there first).\n`,
    );
    expect(run.code).toBe(1);
    expect(existsSync(storeFile())).toBe(false);
  }, 30_000);
});
