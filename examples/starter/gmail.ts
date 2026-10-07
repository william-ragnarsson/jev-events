// New emails in your Gmail inbox. Needs GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN.
import { google } from "@jev-events/google";
import { choice, monitor } from "jev-events";

const missing = ["TYPESAFE_API_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"].filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`Put ${missing.join(", ")} in .env first (see README.md).`);
  process.exit(1);
}

const mail = monitor({
  // Also judge the 3 newest emails, so you see something straight away.
  source: google.gmail.inbox({ backfill: 3 }),
  questions: {
    // Jev picks exactly one of these labels for each email.
    kind: choice("What kind of email is this?", {
      personal: "Written to me by a person",
      newsletter: "A newsletter, promotion or marketing email",
      other: null,
    }),
  },
});

// Runs for every email Jev judged, so you can see it working.
mail.on("judged", (e) => console.log(`${e.answers.kind.choice.padEnd(10)} ${e.item.from.address}: ${e.item.subject}`));

// Runs only for emails Jev labelled "personal". Your own code goes here.
mail.on("kind:personal", (e) => console.log(`           ↳ from a person: ${e.item.from.name ?? e.item.from.address}`));

mail.on("error", (e) => {
  console.error(String(e.error));
  // Google signed you out, so stop instead of waiting for nothing.
  if (e.needsSignIn) {
    console.error("Run npm run google-token again and replace GOOGLE_REFRESH_TOKEN in .env.");
    process.exit(1);
  }
});

// fromEnv() reads the three GOOGLE_ values, which npm run loads from .env.
await mail.start({ connections: [google.fromEnv()] });
console.log("Watching your inbox. New emails show up within 15 seconds. Stop with Ctrl+C.");
