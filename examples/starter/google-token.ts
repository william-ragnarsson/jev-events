// Sign in to Google once and print the GOOGLE_REFRESH_TOKEN line for .env.
// Needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first (see GOOGLE.md).
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

import { CALENDAR_SCOPE, exchangeCode, GMAIL_SCOPE, signInUrl } from "@jev-events/google";

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error("Put GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first (see GOOGLE.md).");
  process.exit(1);
}

// 1. A small web server on your computer. After you sign in, Google sends the browser back here with a code.
const server = createServer();
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const redirectUri = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

// 2. The sign-in link. It asks to read and change your mail and calendar.
//    `state` and the verifier make sure the code that comes back was asked for by this script.
const scopes = ["openid", "email", GMAIL_SCOPE, CALENDAR_SCOPE];
const state = randomBytes(16).toString("base64url");
const verifier = randomBytes(32).toString("base64url");
const codeChallenge = createHash("sha256").update(verifier).digest("base64url");
console.log(`Open this link and sign in:\n\n${signInUrl({ clientId, redirectUri, scopes, state, codeChallenge })}\n\nWaiting for you to sign in. If Google shows an error page, see GOOGLE.md.\n`);

// 3. Wait for the browser to come back with the code, or with an error if you cancelled.
const stop = (error: Error) => {
  console.error(error.message);
  console.error("Run npm run google-token again.");
  process.exit(1);
};
const code = await new Promise<string>((resolve, reject) => {
  server.on("request", (request, response) => {
    const url = new URL(request.url ?? "/", redirectUri);
    const error = url.searchParams.get("error");
    const received = url.searchParams.get("code");
    if (url.pathname !== "/") {
      response.writeHead(404).end();
    } else if (url.searchParams.get("state") !== state) {
      response.end("Open the sign-in link the terminal printed.");
    } else if (error || !received) {
      response.end("Not signed in. Go back to the terminal.", () => reject(new Error(error === "access_denied" ? "Sign-in cancelled." : `Google sign-in failed (${error ?? "no code"}).`)));
    } else {
      response.end("Got the code. Go back to the terminal to see if it worked.", () => resolve(received));
    }
  });
}).catch(stop);
server.close();
server.closeAllConnections();

// 4. Trade the code for tokens. The refresh token lets a script read your mail later without signing in again.
const signedIn = await exchangeCode({
  clientId,
  clientSecret,
  code,
  codeVerifier: verifier,
  redirectUri,
  scopes,
  invalidClientHint: "Check GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.",
}).catch(stop);
if (!signedIn.refreshToken) {
  console.error("Google sent no refresh token. Run npm run google-token again.");
  process.exit(1);
}
// Google lets you untick boxes. Without both, gmail.ts or calendar.ts would fail later, so stop here instead.
const unticked: string[] = [];
if (!signedIn.scopes.includes(GMAIL_SCOPE)) unticked.push("Gmail");
if (!signedIn.scopes.includes(CALENDAR_SCOPE)) unticked.push("Calendar");
if (unticked.length > 0) {
  console.error(`You didn't allow ${unticked.join(" or ")}. Run npm run google-token again and tick every box.`);
  process.exit(1);
}

console.log(`Signed in as ${signedIn.email ?? "you"}. Put this line in .env:\n\nGOOGLE_REFRESH_TOKEN=${signedIn.refreshToken}`);
