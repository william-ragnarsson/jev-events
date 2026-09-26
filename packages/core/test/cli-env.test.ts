import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { findEnvDirectory, isIgnored, loadEnv, readSecret, saveToEnv } from "../src/cli/env.js";

function folder(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "jev-env-")));
}

describe("findEnvDirectory", () => {
  it("finds .env or .env.local here or in a parent, but not above the project root", () => {
    const root = folder();
    mkdirSync(join(root, "project/.git"), { recursive: true });
    mkdirSync(join(root, "project/app/src"), { recursive: true });
    writeFileSync(join(root, ".env"), "OUTSIDE=1\n");
    expect(findEnvDirectory(join(root, "project/app/src"))).toBeUndefined();

    writeFileSync(join(root, "project/.env.local"), "INSIDE=1\n");
    expect(findEnvDirectory(join(root, "project/app/src"))).toBe(join(root, "project"));

    writeFileSync(join(root, "project/app/.env"), "NEARER=1\n");
    expect(findEnvDirectory(join(root, "project/app/src"))).toBe(join(root, "project/app"));
  });
});

describe("loadEnv", () => {
  const names = ["JEV_TEST_A", "JEV_TEST_B", "JEV_TEST_C"];
  afterEach(() => {
    for (const name of names) delete process.env[name];
  });

  it("loads .env.local over .env, and never overrides the shell", () => {
    const dir = folder();
    writeFileSync(join(dir, ".env"), "JEV_TEST_A=from-env\nJEV_TEST_B=from-env\nexport JEV_TEST_C='quoted value'\n");
    writeFileSync(join(dir, ".env.local"), "JEV_TEST_B=from-local\n");
    process.env.JEV_TEST_A = "from-shell";

    expect(loadEnv(dir)).toEqual([join(dir, ".env.local"), join(dir, ".env")]);
    expect(process.env.JEV_TEST_A).toBe("from-shell");
    expect(process.env.JEV_TEST_B).toBe("from-local");
    expect(process.env.JEV_TEST_C).toBe("quoted value");
  });

  it("does nothing without a .env", () => {
    const dir = folder();
    mkdirSync(join(dir, ".git"));
    expect(loadEnv(dir)).toEqual([]);
  });
});

describe("saveToEnv", () => {
  it("appends to the nearest .env on its own line, readable only by you", () => {
    const dir = folder();
    mkdirSync(join(dir, ".git"));
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, ".env"), "OTHER=1");

    expect(saveToEnv("TYPESAFE_API_KEY", "abc", join(dir, "sub"))).toBe(join(dir, ".env"));
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe("OTHER=1\nTYPESAFE_API_KEY=abc\n");
  });

  it("creates ./.env when there is none", () => {
    const dir = folder();
    mkdirSync(join(dir, ".git"));
    const path = saveToEnv("TYPESAFE_API_KEY", "abc", dir);
    expect(path).toBe(join(dir, ".env"));
    expect(readFileSync(path, "utf8")).toBe("TYPESAFE_API_KEY=abc\n");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe("isIgnored", () => {
  it("is true when a .gitignore up to the project root lists .env", () => {
    const dir = folder();
    mkdirSync(join(dir, ".git"));
    mkdirSync(join(dir, "app"));
    expect(isIgnored(join(dir, "app/.env"))).toBe(false);

    for (const line of [".env", "/.env", "**/.env", ".env*", ".env.*"]) {
      writeFileSync(join(dir, ".gitignore"), `node_modules\n${line}\n`);
      expect(isIgnored(join(dir, "app/.env")), line).toBe(line !== ".env.*");
    }
  });
});

describe("readSecret", () => {
  function terminal() {
    const input = Object.assign(new PassThrough(), { isTTY: true, rawMode: false as boolean, setRawMode(mode: boolean) { input.rawMode = mode; } });
    let shown = "";
    const output = new PassThrough();
    output.on("data", (chunk: Buffer) => (shown += chunk.toString()));
    return { input, output, shown: () => shown };
  }

  it("hides what you type and returns it on Enter", async () => {
    const tty = terminal();
    const secret = readSecret("Key: ", tty);
    expect(tty.input.rawMode).toBe(true);
    tty.input.write("abcx");
    tty.input.write("\u007f"); // backspace
    tty.input.write("d\r");

    await expect(secret).resolves.toBe("abcd");
    expect(tty.shown()).toBe("Key: ••••\b \b•\n");
    expect(tty.shown()).not.toContain("abc");
    expect(tty.input.rawMode).toBe(false);
  });

  it("takes a paste in one go, without the terminal's paste markers", async () => {
    const tty = terminal();
    const secret = readSecret("Key: ", tty);
    tty.input.write("\u001b[200~apikey_123\u001b[201~\n");
    await expect(secret).resolves.toBe("apikey_123");
  });

  it("cancels on ctrl-c", async () => {
    const tty = terminal();
    const secret = readSecret("Key: ", tty);
    tty.input.write("ab\u0003");
    await expect(secret).rejects.toThrow("Cancelled.");
    expect(tty.input.rawMode).toBe(false);
  });
});
