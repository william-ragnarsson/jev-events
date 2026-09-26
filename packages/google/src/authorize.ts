import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import { DEFAULT_CREDENTIALS_PATH, readCredentials, writeCredentials } from "jev-events";

import { CALENDAR_SCOPE, DEFAULT_SCOPES, GMAIL_SCOPE, type GoogleTokens } from "./auth.js";
import { endpoints } from "./endpoints.js";

export interface AuthorizeOptions {
  /** Your OAuth client. Default: the one saved last time, or GOOGLE_CLIENT_ID. */
  "client-id"?: string;
  "client-secret"?: string;
  /** Space- or comma-separated scopes. Defaults to DEFAULT_SCOPES. */
  scopes?: string;
  path?: string;
  /** Where to print instructions. Default stdout. */
  print?: (line: string) => void;
  /** Ask a question and return the answer. Default: the terminal, when there is one. */
  ask?: (question: string) => Promise<string>;
  /** Open the sign-in page. Default: your browser. */
  open?: (url: string) => void;
  /** Give up waiting for the browser after this long. Default 5 minutes. */
  timeoutMs?: number;
}

export interface GoogleIdentity {
  email: string | undefined;
  scopes: string[];
}

interface Client {
  clientId: string;
  clientSecret?: string;
}

/** The one-time setup of your own OAuth client, as numbered steps with links. */
export const SETUP_STEPS = [
  "Create a Google Cloud project: https://console.cloud.google.com/projectcreate",
  "Turn on Gmail and Calendar: https://console.cloud.google.com/flows/enableapi?apiid=gmail.googleapis.com,calendar-json.googleapis.com",
  'Set up the consent screen: https://console.cloud.google.com/auth/overview (click "Get started", choose External), then add your own address under Audience → Test users',
  'Create a client of type "Desktop app" and download its JSON: https://console.cloud.google.com/auth/clients/create',
];

/**
 * Connect a Google account: sign in in the browser, then save the tokens for `fromFile()`.
 * This is what `npx jev-events auth google` runs. The first time, it walks you through creating
 * your own OAuth client.
 */
export async function authorize(options: AuthorizeOptions = {}): Promise<GoogleIdentity> {
  const print = options.print ?? ((line: string) => process.stdout.write(`${line}\n`));
  const path = options.path ?? DEFAULT_CREDENTIALS_PATH;
  const client = findClient(options, path) ?? (await setUpClient(options, print));
  const scopes = options.scopes ? options.scopes.split(/[\s,]+/).filter(Boolean) : DEFAULT_SCOPES;
  const urls = endpoints();

  const verifier = base64url(randomBytes(32));
  const state = base64url(randomBytes(16));
  const callback = await waitForCallback(state, options.timeoutMs ?? 5 * 60_000);
  const redirectUri = callback.redirectUri;
  const signIn = new URL(urls.authorize);
  signIn.search = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: scopes.join(" "),
    code_challenge: base64url(createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
    state,
    access_type: "offline",
    prompt: "consent",
  }).toString();

  print("");
  print("  Opening Google in your browser. If it doesn't open, go to:");
  print(`  ${signIn.href}`);
  print("");
  print("  Google will say it hasn't verified the app. It's your own app, so click Continue,");
  print("  and tick every box so Jev Events can read your mail and calendar.");
  (options.open ?? openBrowser)(signIn.href);

  const code = await callback.code;
  const response = await fetch(urls.token, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      client_id: client.clientId,
      ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
    }),
  });
  const json = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    id_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!response.ok || !json.access_token) {
    const why = json.error_description ?? json.error ?? String(response.status);
    const hint = json.error === "invalid_client" ? " Check the client ID and secret, or delete them and run this again to set up a new client." : "";
    throw new Error(`Google refused the sign-in: ${why}.${hint}`);
  }

  const granted = json.scope ? json.scope.split(" ") : scopes;
  const email = emailFromIdToken(json.id_token);
  const tokens: GoogleTokens = {
    ...client,
    accessToken: json.access_token,
    ...(json.refresh_token ? { refreshToken: json.refresh_token } : {}),
    ...(json.expires_in ? { expiresAt: Date.now() + json.expires_in * 1000 } : {}),
    ...(email ? { email } : {}),
    scopes: granted,
  };
  writeCredentials("google", tokens, path);

  print("");
  print(`  Signed in${email ? ` as ${email}` : ""}. Saved to ${path}.`);
  const missing = [
    ...(scopes.includes(GMAIL_SCOPE) && !granted.includes(GMAIL_SCOPE) ? ["Gmail"] : []),
    ...(scopes.includes(CALENDAR_SCOPE) && !granted.includes(CALENDAR_SCOPE) ? ["Calendar"] : []),
  ];
  if (missing.length > 0) {
    print(`  You didn't allow ${missing.join(" or ")}. To add it, run this again and tick every box.`);
  }
  if (!json.refresh_token) print("  Google sent no refresh token, so you'll need to sign in again in an hour.");
  print("");
  print("  Try it:  npx jev-events watch gmail");
  print("           npx jev-events watch calendar");
  return { email, scopes: granted };
}

/** The client from the flags, GOOGLE_CLIENT_ID, or the last sign-in. */
function findClient(options: AuthorizeOptions, path: string): Client | undefined {
  const saved = readCredentials<Partial<GoogleTokens>>("google", path);
  const clientId = options["client-id"] ?? process.env.GOOGLE_CLIENT_ID ?? saved?.clientId;
  if (!clientId) return undefined;
  const clientSecret =
    options["client-secret"] ?? process.env.GOOGLE_CLIENT_SECRET ?? (saved?.clientId === clientId ? saved.clientSecret : undefined);
  return { clientId, ...(clientSecret ? { clientSecret } : {}) };
}

/** Walk through creating an OAuth client, then read the JSON file Google gives you. */
async function setUpClient(options: AuthorizeOptions, print: (line: string) => void): Promise<Client> {
  const steps = SETUP_STEPS.map((step, index) => `  ${index + 1}. ${step}`);
  const ask = options.ask ?? (process.stdin.isTTY ? askInTerminal : undefined);
  if (!ask) {
    throw new Error(
      `Google needs an OAuth client of your own first (one-time, about 3 minutes):\n\n${steps.join("\n")}\n\n  Then run: npx jev-events auth google --client-id <id> --client-secret <secret>`,
    );
  }
  print("");
  print("  Google needs an OAuth client of your own. One-time setup, about 3 minutes:");
  print("");
  for (const step of steps) print(step);
  print("");
  for (let tries = 0; tries < 5; tries++) {
    const answer = unquote(await ask("  Downloaded it? Press Enter (or drag the file here): "));
    if (answer && !/[\\/]/.test(answer) && !answer.endsWith(".json")) {
      // A client ID pasted instead of the file.
      const clientSecret = unquote(await ask("  Client secret: "));
      return { clientId: answer, ...(clientSecret ? { clientSecret } : {}) };
    }
    const file = answer || newestClientFile();
    if (!file) {
      print(`  No client_secret_….json in ${downloadsFolder()} yet. Drag the file here instead.`);
      continue;
    }
    try {
      const client = clientFromFile(file);
      print(`  Using ${file}`);
      return client;
    } catch (error) {
      print(`  ${(error as Error).message}`);
    }
  }
  throw new Error("No OAuth client given.");
}

/** Read `client_id` and `client_secret` from the JSON file Google's console downloads. */
export function clientFromFile(file: string): Client {
  let json: { installed?: Record<string, string>; web?: Record<string, string> };
  try {
    json = JSON.parse(readFileSync(file, "utf8")) as typeof json;
  } catch {
    throw new Error(`Couldn't read ${file}. Is it the JSON file from Google's console?`);
  }
  const entry = json.installed ?? json.web;
  if (!entry?.client_id) throw new Error(`${file} has no client_id. Download the JSON of a "Desktop app" client.`);
  return { clientId: entry.client_id, ...(entry.client_secret ? { clientSecret: entry.client_secret } : {}) };
}

function downloadsFolder(): string {
  return join(homedir(), "Downloads");
}

/** The client file you most likely just downloaded. */
function newestClientFile(folder = downloadsFolder()): string | undefined {
  if (!existsSync(folder)) return undefined;
  const files = readdirSync(folder)
    .filter((name) => /^client_secret_.*\.json$/.test(name))
    .map((name) => join(folder, name));
  return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

/** Terminals quote dragged paths or escape their spaces. */
function unquote(answer: string): string {
  const trimmed = answer.trim();
  const quoted = /^(['"])(.*)\1$/.exec(trimmed);
  return quoted ? (quoted[2] ?? "") : trimmed.replace(/\\ /g, " ");
}

async function askInTerminal(question: string): Promise<string> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await terminal.question(question);
  } finally {
    terminal.close();
  }
}

/** Listen on a free local port for Google's redirect back, which carries the sign-in code. */
async function waitForCallback(state: string, timeoutMs: number): Promise<{ redirectUri: string; code: Promise<string> }> {
  let settle!: { resolve: (code: string) => void; reject: (error: Error) => void };
  const code = new Promise<string>((resolve, reject) => (settle = { resolve, reject }));
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/") {
      response.writeHead(404).end();
      return;
    }
    const error = url.searchParams.get("error");
    const received = url.searchParams.get("code");
    const page = (message: string) =>
      response
        .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        .end(`<!doctype html><title>Jev Events</title><body style="font:16px system-ui;margin:3rem">${message}</body>`);
    if (error) {
      page("Sign-in cancelled. You can close this tab.");
      settle.reject(new Error(error === "access_denied" ? "Sign-in cancelled." : `Google sign-in failed: ${error}.`));
    } else if (!received || url.searchParams.get("state") !== state) {
      page("That sign-in link is stale. Run the command again.");
      return;
    } else {
      page("Signed in. You can close this tab and go back to the terminal.");
      settle.resolve(received);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const timer = setTimeout(() => settle.reject(new Error("Timed out waiting for the browser. Run the command again.")), timeoutMs);
  const done = () => {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
  };
  code.then(done, done);
  return { redirectUri: `http://127.0.0.1:${port}`, code };
}

function openBrowser(url: string): void {
  const [command, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    spawn(command as string, args as string[], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {
    // The link is printed too.
  }
}

function emailFromIdToken(idToken: string | undefined): string | undefined {
  const payload = idToken?.split(".")[1];
  if (!payload) return undefined;
  try {
    return (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { email?: string }).email;
  } catch {
    return undefined;
  }
}

function base64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}
