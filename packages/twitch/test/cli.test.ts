import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fileStore, toConnection } from "jev-events";

import { fakeJevServer, type FakeJev } from "../../core/test/fake-jev.js";
import { liveCli, runCli, type LiveCli } from "../../core/test/run-cli.js";
import { CLIENT, fakeTwitch, STREAMER, type FakeTwitch } from "./fake-twitch.js";
import { waitFor } from "./helpers.js";

// These run the real CLI in a child process. It talks HTTP and EventSub to a fake Twitch and HTTP
// to a fake Jev. None of them run `auth twitch` with a Client ID Twitch accepts: that would open
// a browser.

let jev: FakeJev;
let twitch: FakeTwitch;
let env: Record<string, string | undefined>;
let cwd: string;
let live: LiveCli[] = [];

beforeEach(async () => {
  jev = await fakeJevServer();
  twitch = await fakeTwitch();
  vi.stubEnv("JEV_EVENTS_KEY", undefined);
  env = {
    TYPESAFE_API_KEY: "test-key",
    TYPESAFE_BASE_URL: jev.url,
    JEV_TWITCH_API_URL: twitch.url,
    TWITCH_CLIENT_ID: undefined,
    TWITCH_CLIENT_SECRET: undefined,
    TWITCH_ACCESS_TOKEN: undefined,
    TWITCH_REFRESH_TOKEN: undefined,
    JEV_EVENTS_KEY: undefined,
  };
  // Real path, since macOS's temp folder is behind a symlink.
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "jev-twitch-cli-")));
});

afterEach(async () => {
  await Promise.all(live.map((cli) => cli.stop()));
  live = [];
  await jev.close();
  await twitch.close();
  vi.unstubAllEnvs();
  rmSync(cwd, { recursive: true, force: true });
});

const saved = () => fileStore(join(cwd, ".jev-events"));
const storeFile = () => join(cwd, ".jev-events", "store.json");

/** Save the streamer's account where `jev-events auth twitch` saves it. */
async function connectTwitch(): Promise<void> {
  const store = saved();
  await store.connections.save(toConnection("twitch", twitch.connection(STREAMER)));
  await store.close?.();
}

/** What the store in .jev-events holds now, as the next `jev-events` run reads it. */
async function savedConnections() {
  const store = saved();
  try {
    return await store.connections.list({ integration: "twitch" });
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
const signedOut = "Twitch signed this account out (Invalid refresh token): the sign-in was revoked or expired, or its refresh token was already used.";

describe("jev-events watch twitch", () => {
  it("reads your channel's chat as the saved account and judges each new message", async () => {
    await connectTwitch();

    const cli = watch("twitch");
    await waitFor(() => cli.stdout.includes("connected."), 20_000, "the connection");
    twitch.chat("when does the stream start?");
    twitch.chat("you're an idiot");
    await waitFor(() => cli.lines().filter((line) => /stream start|\[hidden\]/.test(line)).length === 2, 20_000, "both messages");
    const run = await cli.stop();

    expect(run.stderr).toBe("");
    expect(run.stdout).toContain("◆ jev-events  watching twitch:chat  ·  asking kind (question/hype/joke/backseat/spam/other), hateful\n");
    expect(run.stdout).toContain("connected. Reading #mychannel as mychannel. New messages show up here.");
    expect(run.stdout).toMatch(/Viewer +when does the stream start\? +question 90% +· hateful 4%/);
    // What it flags as hateful stays off the screen.
    expect(run.stdout).toMatch(/Viewer +\[hidden\] +question 90% +✔ hateful 93%/);
    expect(run.stdout).not.toContain("idiot");
    expect(questionsAsked()).toEqual([
      ["kind", "hateful"],
      ["kind", "hateful"],
    ]);
    expect(run.code).toBe(0);
  }, 30_000);

  it("uses the tokens in .env instead of a saved account, and saves nothing", async () => {
    const { accessToken, refreshToken } = twitch.issue(STREAMER);
    writeFileSync(join(cwd, ".env"), `TWITCH_CLIENT_ID=${CLIENT.id}\nTWITCH_ACCESS_TOKEN=${accessToken}\nTWITCH_REFRESH_TOKEN=${refreshToken}\n`);

    const cli = watch("twitch");
    await waitFor(() => cli.stdout.includes("connected."), 20_000, "the connection");
    twitch.chat("hello from .env");
    await waitFor(() => cli.lines().some((line) => line.includes("hello from .env")), 20_000, "the message");
    const run = await cli.stop();

    expect(run.stderr).toBe("");
    expect(run.stdout).toContain("connected. Reading #mychannel as mychannel.");
    expect(existsSync(storeFile())).toBe(false);
  }, 30_000);

  it("asks you to connect Twitch first, and says how to watch a channel without signing in", async () => {
    const run = await runCli(["watch", "twitch"], { env: { ...env, TYPESAFE_API_KEY: undefined }, cwd });

    expect(run.stderr).toBe(
      "✖ Connect your Twitch account first: npx jev-events auth twitch\n  Or watch any channel without signing in: npx jev-events watch twitch:<channel>\n",
    );
    expect(run.stdout).toBe("");
    expect(run.code).toBe(1);
  }, 30_000);

  it("gives the commands that work in this repo under npm run cli", async () => {
    const run = await runCli(["watch", "twitch"], { env: { ...env, npm_lifecycle_event: "cli" }, cwd });

    expect(run.stderr).toBe(
      "✖ Connect your Twitch account first: npm run cli -- auth twitch\n  Or watch any channel without signing in: npm run cli -- watch twitch:<channel>\n",
    );
  }, 30_000);

  it("says so when Twitch signed the account out, and remembers it for next time", async () => {
    await connectTwitch();
    twitch.revokeTokens(STREAMER);

    const first = await runCli(["watch", "twitch"], { env, cwd });
    const second = await runCli(["watch", "twitch"], { env, cwd });

    expect(first.stderr).toBe(`✖ ${signedOut} Sign in again: npx jev-events auth twitch\n`);
    expect(first.code).toBe(1);
    expect(second.stderr).toBe(`✖ mychannel needs a new sign-in: npx jev-events auth twitch\n  ${signedOut}\n`);
    expect(second.code).toBe(1);
    expect(await savedConnections()).toMatchObject([{ status: "needs-sign-in", problem: signedOut }]);
    expect(jev.requests).toEqual([]);
  }, 30_000);

  it("says to check the variable when Twitch refuses the token from .env", async () => {
    const { accessToken } = twitch.issue(STREAMER);
    twitch.revokeTokens(STREAMER);
    writeFileSync(join(cwd, ".env"), `TWITCH_CLIENT_ID=${CLIENT.id}\nTWITCH_ACCESS_TOKEN=${accessToken}\n`);

    const run = await runCli(["watch", "twitch"], { env, cwd });

    expect(run.stderr).toBe("✖ Twitch signed this account out: its token was revoked or expired. Check TWITCH_ACCESS_TOKEN.\n");
    expect(run.code).toBe(1);
    expect(existsSync(storeFile())).toBe(false);
  }, 30_000);
});

describe("jev-events auth twitch", () => {
  it("lists the one-time app setup when there's no terminal to ask for the Client ID", async () => {
    const run = await runCli(["auth", "twitch"], { env, cwd });

    expect(run.stderr).toContain("✖ Twitch needs an app of your own first (one-time, about 2 minutes):");
    expect(run.stderr).toContain("  1. Go to https://dev.twitch.tv/console/apps/create");
    expect(run.stderr).toContain("Then run: npx jev-events auth twitch --client-id <id>");
    expect(run.code).toBe(1);
    expect(existsSync(storeFile())).toBe(false);
  }, 30_000);

  it("gives the command that works in this repo under npm run cli", async () => {
    const run = await runCli(["auth", "twitch"], { env: { ...env, npm_lifecycle_event: "cli" }, cwd });

    expect(run.stderr).toContain("Then run: npm run cli -- auth twitch --client-id <id>");
  }, 30_000);

  it("says when Twitch doesn't know the Client ID, before opening anything", async () => {
    const run = await runCli(["auth", "twitch", "--client-id", "wrongclientid0000000000000000"], { env, cwd });

    expect(run.stderr).toBe(
      "✖ Twitch didn't accept the Client ID wrongclientid0000000000000000 (invalid client). Copy it again under Manage at https://dev.twitch.tv/console/apps\n",
    );
    expect(run.stdout).toBe("");
    expect(run.code).toBe(1);
    expect(existsSync(storeFile())).toBe(false);
  }, 30_000);
});
