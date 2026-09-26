import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeCredentials } from "jev-events";

import { fakeJevServer, type FakeJev } from "../../core/test/fake-jev.js";
import { liveCli, runCli, type LiveCli } from "../../core/test/run-cli.js";
import { fakeGoogle, type FakeGoogle } from "./fake-google.js";
import { waitFor } from "./helpers.js";

// These run the real CLI in a child process. It talks HTTP to a fake Google (the child inherits
// JEV_GOOGLE_API_URL from the fake) and to a fake Jev.

let jev: FakeJev;
let google: FakeGoogle;
let env: Record<string, string | undefined>;
let cwd: string;
let live: LiveCli[] = [];

beforeEach(async () => {
  jev = await fakeJevServer();
  google = await fakeGoogle();
  env = { TYPESAFE_API_KEY: "test-key", TYPESAFE_BASE_URL: jev.url, GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined };
  // Real path, since macOS's temp folder is behind a symlink.
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "jev-google-cli-")));
});

afterEach(async () => {
  await Promise.all(live.map((cli) => cli.stop()));
  live = [];
  await jev.close();
  await google.close();
  rmSync(cwd, { recursive: true, force: true });
});

/** Save the fake account where `jev-events auth google` saves it. */
const signIn = () => writeCredentials("google", google.tokens(), join(cwd, ".jev-events", "credentials.json"));

function watch(source: string): LiveCli {
  const cli = liveCli(["watch", source], env, cwd);
  live.push(cli);
  return cli;
}

const questionsAsked = () => jev.requests.map((request) => Object.keys(request.body.questions ?? {}));

describe("jev-events watch gmail", () => {
  it("judges your latest emails and says new mail comes next", async () => {
    signIn();
    google.deliver({ from: "Ann Smith <ann@example.com>", subject: "Lunch?", text: "Friday at 12?" });
    google.deliver({ from: "Deals <deals@shop.example>", subject: "Sale", text: "50% off everything." });

    const cli = watch("gmail");
    await waitFor(() => cli.lines().filter((line) => /Lunch\?|Sale/.test(line)).length === 2, 20_000, "both emails");
    const run = await cli.stop();

    expect(run.stderr).toBe("");
    expect(run.stdout).toMatch(/◆ jev-events {2}watching gmail:inbox {2}· {2}asking needsReply, urgent, kind \(/);
    expect(run.stdout).toContain("connected. Showing your 5 latest emails, then new mail as it arrives (checked every 15s).");
    expect(run.stdout).toMatch(/Ann Smith +Lunch\?/);
    expect(questionsAsked()).toEqual([
      ["needsReply", "urgent", "kind"],
      ["needsReply", "urgent", "kind"],
    ]);
    expect(jev.requests.map((request) => JSON.stringify(request.body.state)).join()).toContain("Friday at 12?");
    expect(run.code).toBe(0);
  }, 30_000);

  it("asks you to connect Google first, before asking for a TypeSafe key", async () => {
    const run = await runCli(["watch", "gmail"], { env: { ...env, TYPESAFE_API_KEY: undefined }, cwd });

    expect(run.stderr).toBe("✖ Connect your Google account first: npx jev-events auth google\n");
    expect(run.stdout).toBe("");
    expect(run.code).toBe(1);
  }, 30_000);

  it("gives the command that works in this repo under npm run cli", async () => {
    const run = await runCli(["watch", "gmail"], { env: { ...env, npm_lifecycle_event: "cli" }, cwd });

    expect(run.stderr).toBe("✖ Connect your Google account first: npm run cli -- auth google\n");
  }, 30_000);

  it("says so when Google signed you out", async () => {
    signIn();
    google.expireAccessTokens();
    google.revoke();

    const run = await runCli(["watch", "gmail"], { env, cwd });

    expect(run.stderr).toContain("✖ Google signed you out: the sign-in expired or was revoked. Sign in again: npx jev-events auth google");
    expect(run.code).toBe(1);
    expect(jev.requests).toEqual([]);
  }, 30_000);
});

describe("jev-events watch calendar", () => {
  it("judges your next events and says changes come next", async () => {
    signIn();
    google.addEvent({
      summary: "Board meeting",
      organizer: { email: "chair@board.example", displayName: "Chair" },
      attendees: [{ email: "chair@board.example" }, { email: "me@acme.com" }],
    });

    const cli = watch("calendar");
    await waitFor(() => cli.lines().some((line) => line.includes("Board meeting")), 20_000, "the event");
    const run = await cli.stop();

    expect(run.stderr).toBe("");
    expect(run.stdout).toContain("watching google-calendar:primary");
    expect(run.stdout).toContain("connected. Showing your next 5 events, then new and changed ones as they come in (checked every 30s).");
    expect(run.stdout).toMatch(/Chair +Board meeting/);
    expect(questionsAsked()).toEqual([["important", "needsPrep"]]);
    expect(run.code).toBe(0);
  }, 30_000);

  it("watches another of your calendars with calendar:<id>", async () => {
    signIn();
    const team = "team@group.calendar.google.com";
    google.addCalendar(team, "America/New_York");
    google.addEvent({ summary: "Offsite" }, team);
    google.addEvent({ summary: "Dentist" });

    const cli = watch(`calendar:${team}`);
    await waitFor(() => cli.lines().some((line) => line.includes("Offsite")), 20_000, "the team event");
    const run = await cli.stop();

    expect(run.stdout).toContain(`watching google-calendar:${team}`);
    expect(run.stdout).not.toContain("Dentist");
  }, 30_000);
});

describe("jev-events auth google", () => {
  it("lists the one-time setup when there's no OAuth client and no terminal to ask in", async () => {
    // No client in flags, env or saved credentials, and stdin is a pipe, so it can't open a browser.
    const run = await runCli(["auth", "google"], { env: { ...env, HOME: cwd }, cwd });

    expect(run.stderr).toContain("✖ Google needs an OAuth client of your own first (one-time, about 3 minutes):");
    expect(run.stderr).toContain("Then run: npx jev-events auth google --client-id <id> --client-secret <secret>");
    expect(run.code).toBe(1);
  }, 30_000);
});
