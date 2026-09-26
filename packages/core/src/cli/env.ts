import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const KEY_URL = "https://docs.typesafe.ai/introduction/quickstart";

const ENV_FILES = [".env.local", ".env"];

/** Which file each variable loaded by `loadEnv` came from, for error messages. */
export const envOrigin: Record<string, string> = {};

/**
 * The folder with the nearest .env or .env.local: the working directory, then its parents up to
 * the project root (the folder with .git) or your home folder.
 */
export function findEnvDirectory(cwd = process.cwd()): string | undefined {
  const home = homedir();
  let directory = resolve(cwd);
  for (;;) {
    if (ENV_FILES.some((file) => existsSync(join(directory, file)))) return directory;
    const parent = dirname(directory);
    if (existsSync(join(directory, ".git")) || directory === home || parent === directory) return undefined;
    directory = parent;
  }
}

/**
 * Load the nearest .env.local and .env into `process.env`, so a key saved there just works.
 * Variables already set in the shell win, and .env.local wins over .env.
 */
export function loadEnv(cwd = process.cwd()): string[] {
  const directory = findEnvDirectory(cwd);
  if (!directory) return [];
  const loaded: string[] = [];
  for (const file of ENV_FILES) {
    const path = join(directory, file);
    if (!existsSync(path)) continue;
    const before = new Set(Object.keys(process.env));
    process.loadEnvFile(path);
    for (const name of Object.keys(process.env)) if (!before.has(name)) envOrigin[name] = path;
    loaded.push(path);
  }
  return loaded;
}

/** Append `NAME=value` to the nearest .env, or to ./.env when there is none. Returns the file's path. */
export function saveToEnv(name: string, value: string, cwd = process.cwd()): string {
  const path = join(findEnvDirectory(cwd) ?? resolve(cwd), ".env");
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const separator = current === "" || current.endsWith("\n") ? "" : "\n";
  appendFileSync(path, `${separator}${name}=${value}\n`, { mode: 0o600 });
  return path;
}

/** True when a .gitignore next to the file, or at the project root, already keeps .env out of git. */
export function isIgnored(envPath: string): boolean {
  let directory = dirname(envPath);
  for (;;) {
    const ignore = join(directory, ".gitignore");
    // ".env", "/.env", "**/.env" or ".env*". (".env.*" alone matches .env.local but not .env.)
    if (existsSync(ignore) && /^(\*\*\/|\/)?\.env\*?\s*$/m.test(readFileSync(ignore, "utf8"))) return true;
    const parent = dirname(directory);
    if (existsSync(join(directory, ".git")) || parent === directory) return false;
    directory = parent;
  }
}

export interface SecretStreams {
  input: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };
  output: NodeJS.WritableStream;
}

/** Ask for a secret in the terminal, showing a dot per character instead of the characters. */
export function readSecret(question: string, streams: SecretStreams = { input: process.stdin, output: process.stdout }): Promise<string> {
  const { input, output } = streams;
  return new Promise((resolvePromise, reject) => {
    let value = "";
    const finish = (error?: Error) => {
      input.off("data", onData);
      input.setRawMode?.(false);
      input.pause();
      output.write("\n");
      if (error) reject(error);
      else resolvePromise(value.trim());
    };
    const onData = (chunk: Buffer | string) => {
      // Drop paste markers and arrow keys; keep everything typed or pasted.
      const text = String(chunk).replace(/\x1b\[[0-9;]*[A-Za-z~]/g, "");
      for (const char of text) {
        if (char === "\r" || char === "\n" || char === "\u0004") return finish();
        if (char === "\u0003") return finish(new Error("Cancelled."));
        if (char === "\u007f" || char === "\b") {
          if (value) {
            value = value.slice(0, -1);
            output.write("\b \b");
          }
          continue;
        }
        if (char < " ") continue;
        value += char;
        output.write("•");
      }
    };
    output.write(question);
    input.setRawMode?.(true);
    input.on("data", onData);
    input.resume();
  });
}
