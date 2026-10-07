// Upcoming events in your Google Calendar. Needs GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN.
import { google } from "@jev-events/google";
import { monitor, noul } from "jev-events";

const missing = ["TYPESAFE_API_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"].filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`Put ${missing.join(", ")} in .env first (see README.md).`);
  process.exit(1);
}

const calendar = monitor({
  // Also judge the next 3 events, so you see something straight away. After that, only new or changed ones.
  source: google.calendar.events({ backfill: 3 }),
  questions: {
    // A yes/no question. Jev answers with how likely the answer is yes, from 0 to 1.
    prepare: noul("Do I need to prepare something before this event?"),
  },
});

// Runs for every event Jev judged, so you can see it working.
calendar.on("judged", (e) => console.log(`${e.answers.prepare.noul.toFixed(2)}  ${e.item.start.toLocaleString()}  ${e.item.title}`));

// Runs only when Jev is at least 80% sure. Your own code goes here.
calendar.on("prepare", { min: 0.8 }, (e) => console.log(`      ↳ prepare for: ${e.item.title}`));

calendar.on("error", (e) => {
  console.error(String(e.error));
  // Google signed you out, so stop instead of waiting for nothing.
  if (e.needsSignIn) {
    console.error("Run npm run google-token again and replace GOOGLE_REFRESH_TOKEN in .env.");
    process.exit(1);
  }
});

// fromEnv() reads the three GOOGLE_ values, which npm run loads from .env.
await calendar.start({ connections: [google.fromEnv()] });
console.log("Watching your calendar. New events show up within 30 seconds. Stop with Ctrl+C.");
