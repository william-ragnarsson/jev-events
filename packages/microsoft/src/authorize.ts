import { spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import { connectionInfo, fileStore, toConnection, type ConnectionInfo, type Store } from "jev-events";

import { CHAT_SCOPE, expandScopes, PUBLIC_CLIENT_HINT, SIGN_IN_SCOPES } from "./auth.js";
import { oauthUrl } from "./endpoints.js";
import { describeError, signedInFrom, toNewConnection, whoSignedIn, type TokenResponse } from "./oauth.js";

export interface AuthorizeOptions {
  /** Your app registration's Application (client) ID. Default: MICROSOFT_CLIENT_ID, else the one saved with your last sign-in, else asked for. */
  "client-id"?: string;
  /**
   * Your Directory (tenant) ID, only for an app that allows accounts in your organization alone.
   * Default: MICROSOFT_TENANT, else "common", which takes any account the app allows.
   */
  tenant?: string;
  /** What to ask for, space- or comma-separated: "outlook", "calendar", "teams" or Graph permission names. Default: all three. */
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

export interface MicrosoftAccount {
  userId: string;
  email: string | undefined;
  name: string | undefined;
  /** What the account allowed. */
  scopes: string[];
  /** The saved connection, without its tokens. */
  connection: ConnectionInfo;
}

/** The one-time setup of a Microsoft app registration, as numbered steps. */
export const SETUP_STEPS = [
  "Go to https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade (Microsoft Entra admin center → App registrations) and click New registration",
  'Name it, choose "Accounts in any organizational directory and personal Microsoft accounts", leave Redirect URI empty, and click Register',
  'Under Manage → Authentication, set "Allow public client flows" (in Advanced settings) to Yes and click Save',
  "On Overview, copy the Application (client) ID",
];

const CLIENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface DeviceCode {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  expires_in?: number;
  interval?: number;
  error?: string;
  error_description?: string;
}

/**
 * Connect a Microsoft account from the terminal: enter a code on Microsoft's site, then save the
 * connection in the file store, where monitors started without `connections` find it. This is what
 * `npx jev-events auth microsoft` runs. The first time, it walks you through registering your app.
 */
export async function authorize(options: AuthorizeOptions = {}): Promise<MicrosoftAccount> {
  const print = options.print ?? ((line: string) => process.stdout.write(`${line}\n`));
  const env = options.env ?? process.env;
  const dir = options.dir ?? ".jev-events";
  const store = options.store ?? fileStore(dir);
  const ask = options.ask ?? (process.stdin.isTTY ? askInTerminal : undefined);
  const saved = await savedClient(store);
  const flag = options["client-id"] ?? (env.MICROSOFT_CLIENT_ID || undefined);
  const clientId = flag ?? saved?.clientId ?? (await askForClientId(ask, print));
  if (!CLIENT_ID.test(clientId)) {
    throw new Error(`${clientId} isn't an Application (client) ID, which looks like 1b2c3d4e-0000-1111-2222-333344445555. Copy it from your app's Overview.`);
  }
  const tenant = options.tenant ?? (env.MICROSOFT_TENANT || undefined) ?? (saved?.clientId === clientId ? saved.tenant : undefined) ?? "common";
  const wanted = options.scopes ? options.scopes.split(/[\s,]+/).filter(Boolean) : ["outlook", "calendar", "teams"];
  const scopes = expandScopes([...SIGN_IN_SCOPES, ...wanted]);

  const device = await post<DeviceCode>(oauthUrl("devicecode", tenant), { client_id: clientId, scope: scopes.join(" ") });
  if (!device.ok || !device.json.device_code || !device.json.user_code) {
    throw new Error(
      `Microsoft didn't accept the app ${clientId} (${describeError(device.json, device.status)}). Check the Application (client) ID on your app's Overview${tenant === "common" ? "" : ` and the tenant ${tenant}`}.`,
    );
  }
  const code = device.json;
  const page = code.verification_uri ?? "https://microsoft.com/devicelogin";
  print("");
  print("  Opening Microsoft in your browser. If it doesn't open, go to:");
  print(`  ${page}`);
  print("");
  print(`  Enter the code ${code.user_code}, then sign in and click Accept.`);
  if (scopes.includes(CHAT_SCOPE)) {
    print("  Using a personal account (outlook.com, hotmail.com)? Teams only works with work or school accounts,");
    print("  so run it with --scopes outlook,calendar.");
  }
  (options.open ?? openBrowser)(page);

  const tokens = await waitForApproval({ clientId, tenant, code });
  const signedIn = signedInFrom(tokens, scopes);
  const user = await whoSignedIn(signedIn.accessToken);
  const connection = toConnection("microsoft", toNewConnection(signedIn, user, { clientId, tenant }));
  await store.connections.save(connection);
  await store.flush?.();

  const who = user.email ?? user.name ?? user.id;
  print("");
  print(`  Signed in as ${who}.${options.store ? "" : ` Saved to ${join(dir, "store.json")}.`}`);
  if (signedIn.personal && signedIn.scopes.some((scope) => scope.endsWith(CHAT_SCOPE))) {
    print("  This is a personal account, so Outlook and Outlook Calendar work but Teams doesn't.");
  }
  print("");
  print("  Try it:  npx jev-events watch outlook");
  return { userId: user.id, email: user.email, name: user.name, scopes: signedIn.scopes, connection: connectionInfo(connection) };
}

/** The app and tenant of the latest sign-in saved in the store. */
async function savedClient(store: Store): Promise<{ clientId: string; tenant: string | undefined } | undefined> {
  const saved = (await store.connections.list({ integration: "microsoft" }))
    .map((connection) => connection.credentials)
    .filter((credentials) => typeof credentials.clientId === "string")
    .at(-1);
  if (!saved) return undefined;
  return { clientId: saved.clientId as string, tenant: typeof saved.tenant === "string" ? saved.tenant : undefined };
}

/** Walk through registering an app, then ask for its client ID. */
async function askForClientId(ask: AuthorizeOptions["ask"], print: (line: string) => void): Promise<string> {
  const steps = SETUP_STEPS.map((step, index) => `  ${index + 1}. ${step}`);
  if (!ask) {
    throw new Error(
      `Microsoft needs an app registration of your own first (one-time, about 3 minutes):\n\n${steps.join("\n")}\n\n  Then run: npx jev-events auth microsoft --client-id <id>`,
    );
  }
  print("");
  print("  Microsoft needs an app registration of your own. One-time setup, about 3 minutes:");
  print("");
  for (const step of steps) print(step);
  print("");
  for (let tries = 0; tries < 3; tries++) {
    const answer = (await ask("  Application (client) ID: ")).trim();
    if (CLIENT_ID.test(answer)) return answer;
    if (answer) print("  That doesn't look like an Application (client) ID, which looks like 1b2c3d4e-0000-1111-2222-333344445555.");
  }
  throw new Error("No Application (client) ID given.");
}

/** Ask Microsoft for the tokens every few seconds until the code is approved, or expires. */
async function waitForApproval(options: { clientId: string; tenant: string; code: DeviceCode }): Promise<TokenResponse & { access_token: string }> {
  const { code } = options;
  let interval = (code.interval ?? 5) * 1000;
  const deadline = Date.now() + (code.expires_in ?? 900) * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, interval));
    const { ok, status, json } = await post<TokenResponse>(oauthUrl("token", options.tenant), {
      client_id: options.clientId,
      device_code: code.device_code as string,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    if (ok && json.access_token) return { ...json, access_token: json.access_token };
    switch (json.error) {
      case "authorization_pending":
        continue;
      case "slow_down":
        interval += 5_000;
        continue;
      case "authorization_declined":
        throw new Error("Sign-in cancelled.");
      case "expired_token":
      case "bad_verification_code":
        break;
      case "invalid_client":
        throw new Error(`Microsoft didn't let the app sign in without a secret. ${PUBLIC_CLIENT_HINT}`);
      case "invalid_scope":
        throw new Error(
          `Microsoft didn't allow some of the permissions (${describeError(json, status)}). With a personal account, run it with --scopes outlook,calendar: Teams needs a work or school account.`,
        );
      default:
        throw new Error(`Microsoft sign-in failed (${describeError(json, status)}).`);
    }
    break;
  }
  throw new Error(
    "The code expired before it was approved. Run the command again. If Microsoft said the app isn't multi-tenant, add --tenant <Directory (tenant) ID> from the app's Overview.",
  );
}

async function post<T>(url: string, params: Record<string, string>): Promise<{ ok: boolean; status: number; json: T }> {
  const response = await fetch(url, { method: "POST", body: new URLSearchParams(params) });
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
