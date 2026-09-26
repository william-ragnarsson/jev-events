import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const main = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
// The CLI reads the nearest .env, and the repo's may hold a real key, so run from an empty folder.
const emptyFolder = mkdtempSync(join(tmpdir(), "jev-cli-"));

export interface CliOptions {
  /** `undefined` removes a variable, e.g. `{ TYPESAFE_API_KEY: undefined }`. */
  env?: Record<string, string | undefined>;
  stdin?: string;
  /** Working directory. Defaults to an empty folder, so no .env is found. */
  cwd?: string;
}

export interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Start the `jev-events` CLI from source in a child process, the same program `npx jev-events` runs
 * after a build.
 */
function startCli(args: string[], options: CliOptions = {}): ChildProcessWithoutNullStreams {
  const merged: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
  // Under `npm run cli` the CLI rewrites its hints to match; tests expect the plain ones.
  delete merged.npm_lifecycle_event;
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  return spawn(process.execPath, ["--conditions=source", "--import", tsx, main, ...args], { cwd: options.cwd ?? emptyFolder, env: merged });
}

/** Run the CLI to completion, feeding `stdin`, and collect its output. */
export function runCli(args: string[], options: CliOptions = {}): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    const child = startCli(args, options);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(options.stdin ?? "");
  });
}

export interface LiveCli {
  /** Output so far. */
  readonly stdout: string;
  readonly stderr: string;
  /** Complete stdout lines so far. */
  lines(): string[];
  /** Stop it the way ctrl-c does, and wait for it to exit. */
  stop(): Promise<CliRun>;
  /** Wait for it to exit by itself, such as after an error. */
  done(): Promise<CliRun>;
}

/** Start a CLI command that runs until stopped, such as `watch bluesky`, and collect its output as it comes. */
export function liveCli(args: string[], env: Record<string, string | undefined> = {}, cwd?: string): LiveCli {
  const child = startCli(args, { env, ...(cwd ? { cwd } : {}) });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
  child.stdin.end();
  return {
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    lines: () => stdout.split("\n").slice(0, -1),
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGINT");
      return { code: await exited, stdout, stderr };
    },
    async done() {
      return { code: await exited, stdout, stderr };
    },
  };
}
