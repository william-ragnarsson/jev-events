import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Where `jev-events auth` saves tokens, relative to the working directory. */
export const DEFAULT_CREDENTIALS_PATH = ".jev-events/credentials.json";

/** Read one platform's saved credentials, or undefined when none are saved. */
export function readCredentials<T>(platform: string, path = DEFAULT_CREDENTIALS_PATH): T | undefined {
  let all: Record<string, unknown>;
  try {
    all = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Couldn't read ${path}: ${(error as Error).message}`);
  }
  return all[platform] as T | undefined;
}

/**
 * Save one platform's credentials. The file is readable only by you, and its folder gets a
 * `.gitignore` so tokens are never committed by accident.
 */
export function writeCredentials(platform: string, value: unknown, path = DEFAULT_CREDENTIALS_PATH): void {
  const directory = dirname(resolve(path));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const ignore = join(directory, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
  let all: Record<string, unknown> = {};
  try {
    all = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    // First save.
  }
  all[platform] = value;
  writeFileSync(path, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
}
