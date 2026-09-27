import { spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import { connectionInfo, fileStore, toConnection, type ConnectionInfo, type Store } from "jev-events";

import { DEFAULT_SCOPES, withTokens } from "./auth.js";
import { endpoints } from "./endpoints.js";

export interface AuthorizeOptions {
  /** Your Twitch app's Client ID. Default: TWITCH_CLIENT_ID, else the one saved with your last sign-in, else asked for. */
  "client-id"?: string;
  /** Only for a Confidential app, whose tokens can't be renewed without it. Default: TWITCH_CLIENT_SECRET. */
  "client-secret"?: string;
  /** What to ask for, space- or comma-separated. Default: reading and sending chat, and the moderation the actions do. */
  scopes?: string;
  /** The file store to save the connection in. Default ".jev-events", where the CLI and `fileStore()` look. */
  dir?: string;
  /** Save the connection in this store instead, such as your Postgres store. */
  store?: Store;
  /** Where to print instructions. Default stdout. */
  print?: (line: string) => void;
  /** Ask a question and return the answer. Default: the terminal, when there is one. */
  ask?: (question: string) => Promise<string>;
  /** Open the sign-in page. Default: your browser. */
  open?: (url: string) => void;
  env?: NodeJS.ProcessEnv;
}

export interface TwitchAccount {
  userId: string;
  login: string;
  /** What the account allowed. */
  scopes: string[];
  /** The saved connection, without its tokens. */
  connection: ConnectionInfo;
}

/** The one-time setup of a Twitch app, as numbered steps. */
export const SETUP_STEPS = [
  "Go to https://dev.twitch.tv/console/apps/create (Twitch asks you to turn on two-factor authentication first, if it's off)",
  'Name the app (the name has to be unique on Twitch), add http://localhost:3000 under OAuth Redirect URLs, and pick the category "Chat Bot" and the client type "Public"',
  "Click Create, then Manage, and copy the Client ID",
];

interface DeviceCode {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  expires_in?: number;
  interval?: number;
  message?: string;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  message?: string;
}

/**
 * Connect a Twitch account from the terminal: approve a code on Twitch, then save the connection in
 * the file store, where monitors started without `connections` find it. This is what
 * `npx jev-events auth twitch` runs. The first time, it walks you through creating your Twitch app.
 */
export async function authorize(options: AuthorizeOptions = {}): Promise<TwitchAccount> {
  const print = options.print ?? ((line: string) => process.stdout.write(`${line}\n`));
  const env = options.env ?? process.env;
  const dir = options.dir ?? ".jev-events";
  const store = options.store ?? fileStore(dir);
  const ask = options.ask ?? (process.stdin.isTTY ? askInTerminal : undefined);
  const clientId = (await findClientId(options, env, store)) ?? (await askForClientId(ask, print));
  const clientSecret = options["client-secret"] ?? (env.TWITCH_CLIENT_ID === clientId ? env.TWITCH_CLIENT_SECRET || undefined : undefined);
  // The chat source needs to read chat, whatever else is asked for.
  const scopes = [...new Set(["user:read:chat", ...(options.scopes ? options.scopes.split(/[\s,]+/).filter(Boolean) : DEFAULT_SCOPES)])];

  const device = await post<DeviceCode>("device", { client_id: clientId, scopes: scopes.join(" ") });
  if (!device.ok || !device.json.device_code || !device.json.verification_uri) {
    const why = device.json.message ?? device.status;
    throw new Error(`Twitch didn't accept the Client ID ${clientId} (${why}). Copy it again under Manage at https://dev.twitch.tv/console/apps`);
  }
  const code = device.json;
  print("");
  print("  Opening Twitch in your browser. If it doesn't open, go to:");
  print(`  ${code.verification_uri}`);
  print("");
  print(`  Check that Twitch shows the code ${code.user_code}, then click Authorize.`);
  (options.open ?? openBrowser)(code.verification_uri as string);

  const tokens = await waitForApproval({ clientId, clientSecret, scopes, code });
  const credentials = {
    clientId,
    ...(clientSecret ? { clientSecret } : {}),
    accessToken: tokens.access_token,
    ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
    ...(tokens.expires_in ? { expiresAt: Date.now() + tokens.expires_in * 1000 } : {}),
  };
  const { userId, login, scopes: granted } = await withTokens(credentials).identity();
  const connection = toConnection("twitch", { account: userId, label: login, credentials, facts: { userId, login, scopes: granted } });
  await store.connections.save(connection);
  await store.flush?.();

  print("");
  print(`  Signed in as ${login}.${options.store ? "" : ` Saved to ${join(dir, "store.json")}.`}`);
  print(`  To act in someone else's channel, ${login} has to be a moderator there. The broadcaster types in chat: /mod ${login}`);
  print("");
  print("  Try it:  npx jev-events watch twitch");
  return { userId, login, scopes: granted, connection: connectionInfo(connection) };
}

/** The Client ID from the flag, TWITCH_CLIENT_ID, or the latest sign-in saved in the store. */
async function findClientId(options: AuthorizeOptions, env: NodeJS.ProcessEnv, store: Store): Promise<string | undefined> {
  const saved = (await store.connections.list({ integration: "twitch" }))
    .map((connection) => connection.credentials.clientId)
    .filter((clientId): clientId is string => typeof clientId === "string")
    .at(-1);
  return options["client-id"] ?? (env.TWITCH_CLIENT_ID || undefined) ?? saved;
}

/** Walk through creating a Twitch app, then ask for its Client ID. */
async function askForClientId(ask: AuthorizeOptions["ask"], print: (line: string) => void): Promise<string> {
  const steps = SETUP_STEPS.map((step, index) => `  ${index + 1}. ${step}`);
  if (!ask) {
    throw new Error(`Twitch needs an app of your own first (one-time, about 2 minutes):\n\n${steps.join("\n")}\n\n  Then run: npx jev-events auth twitch --client-id <id>`);
  }
  print("");
  print("  Twitch needs an app of your own. One-time setup, about 2 minutes:");
  print("");
  for (const step of steps) print(step);
  print("");
  for (let tries = 0; tries < 3; tries++) {
    const answer = (await ask("  Client ID: ")).trim();
    if (/^[A-Za-z0-9]{10,64}$/.test(answer)) return answer;
    if (answer) print("  That doesn't look like a Client ID, which is about 30 letters and digits under Manage.");
  }
  throw new Error("No Client ID given.");
}

/** Ask Twitch for the tokens every few seconds until the code is approved, or expires. */
async function waitForApproval(options: { clientId: string; clientSecret: string | undefined; scopes: string[]; code: DeviceCode }) {
  const { code } = options;
  let interval = (code.interval ?? 5) * 1000;
  const deadline = Date.now() + (code.expires_in ?? 1800) * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, interval));
    const { ok, status, json } = await post<TokenResponse>("token", {
      client_id: options.clientId,
      ...(options.clientSecret ? { client_secret: options.clientSecret } : {}),
      scopes: options.scopes.join(" "),
      device_code: code.device_code as string,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    if (ok && json.access_token) return { ...json, access_token: json.access_token };
    const message = json.message ?? "";
    if (/authorization_pending/i.test(message)) continue;
    if (/slow_down/i.test(message)) {
      interval += 5_000;
      continue;
    }
    if (/invalid device code|expired/i.test(message)) break;
    if (/denied|declined/i.test(message)) throw new Error("Sign-in cancelled.");
    if (/client secret/i.test(message)) {
      throw new Error(`Twitch didn't accept the client secret (${message}). Check --client-secret or TWITCH_CLIENT_SECRET, or leave it out for a Public app.`);
    }
    throw new Error(`Twitch sign-in failed (${message || status}).`);
  }
  throw new Error("The code expired before it was approved. Run the command again.");
}

async function post<T>(path: "device" | "token", params: Record<string, string>): Promise<{ ok: boolean; status: number; json: T }> {
  const response = await fetch(`${endpoints().id}/${path}`, { method: "POST", body: new URLSearchParams(params) });
  return { ok: response.ok, status: response.status, json: (await response.json().catch(() => ({}))) as T };
}

async function askInTerminal(question: string): Promise<string> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await terminal.question(question);
  } finally {
    terminal.close();
  }
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
