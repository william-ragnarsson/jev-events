// Public Bluesky posts that mention music. Needs only TYPESAFE_API_KEY.
import { monitor, noul } from "jev-events";
import { bluesky } from "jev-events/public";

if (!process.env.TYPESAFE_API_KEY) {
  console.error("Put TYPESAFE_API_KEY in .env first (see README.md).");
  process.exit(1);
}

const posts = monitor({
  source: bluesky({ keywords: ["music"] }),
  questions: {
    // A yes/no question. Jev answers with how likely the answer is yes, from 0 to 1.
    asks: noul("Is the author asking a question?"),
  },
  // Each judged post is one paid request, so judge at most one a second.
  // Posts that wait more than 10 seconds are skipped.
  rate: { perSecond: 1, burst: 1 },
});

// Runs for every post Jev judged, so you can see it working.
posts.on("judged", (e) => console.log(`${e.answers.asks.noul.toFixed(2)}  ${e.item.text.replace(/\s+/g, " ")}`));

// Runs only when Jev is at least 80% sure. Your own code goes here.
posts.on("asks", { min: 0.8 }, (e) => console.log(`      ↳ a question: ${e.item.url}`));

posts.on("error", (e) => console.error(String(e.error)));

await posts.start();
console.log("Watching Bluesky for posts about music. Stop with Ctrl+C.");
