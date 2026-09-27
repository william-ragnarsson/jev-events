import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { encryptionKey } from "../src/store/seal.js";
import { fakeJevServer, type FakeJev } from "./fake-jev.js";
import { liveCli, runCli } from "./run-cli.js";

// These run the real CLI in a child process, with the real TypeSafe SDK talking HTTP to a fake Jev.

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** POST JSON, retrying until the CLI's webhook server is up. */
async function postWhenListening(url: string, body: unknown, ms = 15_000): Promise<Response> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      return await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

/** A fresh folder with these files in it, e.g. `{ ".env": "TYPESAFE_API_KEY=abc" }`. */
function folderWith(files: Record<string, string> = {}): string {
  // Real path, since macOS's temp folder is behind a symlink and the CLI reports real paths.
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "jev-cli-test-")));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(folder, name, ".."), { recursive: true });
    if (name.endsWith("/")) mkdirSync(join(folder, name), { recursive: true });
    else writeFileSync(join(folder, name), content);
  }
  return folder;
}

const waitFor = async (condition: () => boolean, ms = 10_000) => {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

let jev: FakeJev;
let env: Record<string, string | undefined>;

beforeEach(async () => {
  jev = await fakeJevServer();
  env = { TYPESAFE_API_KEY: "test-key", TYPESAFE_BASE_URL: jev.url };
});

afterEach(async () => {
  await jev.close();
});

describe("jev-events watch", () => {
  it("judges every stdin line with your question and prints JSON lines", async () => {
    const run = await runCli(["watch", "stdin", "--ask", "rude=Is this message rude?", "--json"], {
      env,
      stdin: "hello there\n\nyou idiot\n",
    });

    expect(run.stderr).not.toMatch(/error/i);
    expect(run.code).toBe(0);
    const lines = run.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { text: string; answers: { rude: { type: string; noul: number } }; latencyMs: number });
    expect(lines.map((line) => [line.text, line.answers.rude.noul]).sort()).toEqual([
      ["hello there", 0.04],
      ["you idiot", 0.93],
    ]);

    // One request per non-empty line, sent the way the SDK sends it.
    expect(jev.requests).toHaveLength(2);
    expect(jev.requests[0]).toMatchObject({ path: "/v1/systemone", authorization: "Bearer test-key" });
    expect(jev.requests[0]?.body.questions?.rude).toMatchObject({ type: "noul", instructions: "Is this message rude?" });
  }, 30_000);

  it("prints a readable row per item and a summary", async () => {
    const run = await runCli(["watch", "stdin", "--ask", "rude=Is this message rude?"], { env, stdin: "you idiot\n" });

    expect(run.code).toBe(0);
    expect(run.stdout).toContain("watching stdin");
    expect(run.stdout).toMatch(/you idiot\s+✔ rude 93%/);
    expect(run.stdout).toMatch(/judged 1 · .*120 tokens/);
  }, 30_000);

  it("turns webhook POSTs into judged items", async () => {
    const port = await freePort();
    const cli = liveCli(["watch", `webhook:${port}`, "--ask", "rude=Is this message rude?", "--json"], env);
    try {
      const response = await postWhenListening(`http://127.0.0.1:${port}/`, { text: "you idiot", author: "someone" });
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ accepted: 1 });
      await waitFor(() => cli.lines().length === 1);
    } finally {
      await cli.stop();
    }

    expect(cli.stderr).toBe("");
    expect(JSON.parse(cli.lines()[0] ?? "")).toMatchObject({ author: "someone", text: "you idiot", answers: { rude: { noul: 0.93 } } });
  }, 30_000);

  it("uses built-in recipes and choice questions", async () => {
    const run = await runCli(
      ["watch", "stdin", "--recipe", "email.urgent", "--choice", "What is this?", "--options", "question,other", "--json"],
      { env, stdin: "can you send the report?\n" },
    );

    expect(run.code).toBe(0);
    const line = JSON.parse(run.stdout.trim()) as { answers: { urgent: { noul: number }; choice: { choice: string } } };
    expect(line.answers.choice.choice).toBe("question");
    expect(line.answers.urgent.noul).toBe(0.04);
  }, 30_000);
});

describe("the TypeSafe API key", () => {
  const noShellKey = () => ({ TYPESAFE_API_KEY: undefined, TYPESAFE_BASE_URL: jev.url });
  const judgeOneLine = (cwd: string, extraEnv: Record<string, string> = {}) =>
    runCli(["watch", "stdin", "--ask", "Is this rude?", "--json"], { env: { ...noShellKey(), ...extraEnv }, cwd, stdin: "hi\n" });

  it("explains how to add one when there is none", async () => {
    const run = await runCli(["watch", "stdin", "--ask", "Is this rude?"], { env: noShellKey(), stdin: "hi\n" });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("No TypeSafe API key found. Put this line in a file called .env in this folder:");
    expect(run.stderr).toContain("TYPESAFE_API_KEY=<your key>");
    // Before printing "connecting…", which would suggest it got further.
    expect(run.stdout).toBe("");
    expect(jev.requests).toHaveLength(0);
  }, 30_000);

  it("is read from .env in the folder you run it from", async () => {
    const run = await judgeOneLine(folderWith({ ".env": "TYPESAFE_API_KEY=from-dotenv\n" }));
    expect(run.code).toBe(0);
    expect(jev.requests[0]?.authorization).toBe("Bearer from-dotenv");
  }, 30_000);

  it("is read from .env in a parent folder, up to the project root", async () => {
    const project = folderWith({ ".git/": "", ".env": "export TYPESAFE_API_KEY=\"from-root\"\n", "src/deep/": "" });
    const run = await judgeOneLine(join(project, "src/deep"));
    expect(run.code).toBe(0);
    expect(jev.requests[0]?.authorization).toBe("Bearer from-root");

    // A .env above the project root belongs to something else.
    const outer = folderWith({ ".env": "TYPESAFE_API_KEY=outside\n", "project/.git/": "" });
    const outside = await judgeOneLine(join(outer, "project"));
    expect(outside.code).toBe(2);
    expect(outside.stderr).toContain("No TypeSafe API key found");
  }, 30_000);

  it("prefers the shell's key, then .env.local, then .env", async () => {
    const folder = folderWith({ ".env": "TYPESAFE_API_KEY=from-dotenv\n", ".env.local": "TYPESAFE_API_KEY=from-local\n" });
    await judgeOneLine(folder);
    await judgeOneLine(folder, { TYPESAFE_API_KEY: "from-shell" });
    expect(jev.requests.map((request) => request.authorization)).toEqual(["Bearer from-local", "Bearer from-shell"]);
  }, 30_000);

  it("stops with one clear message when TypeSafe rejects the key", async () => {
    const folder = folderWith({ ".env": "TYPESAFE_API_KEY=rejected-key\n" });
    const run = await runCli(["watch", "stdin", "--ask", "Is this rude?"], { env: noShellKey(), cwd: folder, stdin: "one\ntwo\nthree\n" });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain(`TypeSafe didn't accept the API key (TYPESAFE_API_KEY from ${join(folder, ".env")})`);
    expect(run.stderr.match(/didn't accept/g)).toHaveLength(1);
  }, 30_000);
});

describe("jev-events errors and help", () => {
  it("asks for a question when the source has no default", async () => {
    const run = await runCli(["watch", "stdin"], { env, stdin: "hi\n" });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("Tell Jev what to look for");
  }, 30_000);

  it("rejects unknown sources, recipes and commands", async () => {
    const source = await runCli(["watch", "nowhere", "--ask", "Is this rude?"], { env });
    expect(source.code).toBe(2);
    expect(source.stderr).toContain('Unknown source "nowhere". Try gmail, calendar, slack');

    const recipe = await runCli(["watch", "stdin", "--recipe", "email.nope"], { env });
    expect(recipe.code).toBe(2);
    expect(recipe.stderr).toMatch(/Unknown recipe "email\.nope"\. Available: .*chat\.hateful/);

    const auth = await runCli(["auth", "myspace"], { env });
    expect(auth.code).toBe(2);
    expect(auth.stderr).toContain("Usage: jev-events auth <google|microsoft|slack|twitch>");
  }, 30_000);

  it("prints usage", async () => {
    const run = await runCli(["--help"], { env });
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("jev-events watch <source>");
    for (const source of ["gmail", "calendar", "slack[:channel]", "twitch:<channel>", "bluesky"]) expect(run.stdout).toContain(source);
  }, 30_000);

  it("prints a new encryption key for JEV_EVENTS_KEY", async () => {
    const [first, second] = await Promise.all([runCli(["key"], { env }), runCli(["key"], { env })]);
    expect(first.code).toBe(0);
    expect(first.stdout).toMatch(/^[A-Za-z0-9_-]{43}\n$/);
    expect(second.stdout).not.toBe(first.stdout);
    expect(encryptionKey(first.stdout.trim())).toEqual(Buffer.from(first.stdout.trim(), "base64url"));
  }, 30_000);
});
