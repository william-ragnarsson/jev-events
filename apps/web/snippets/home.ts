import { monitor, noul } from "jev-events";
import { google } from "@jev-events/google";

const mail = monitor({
  source: google.gmail.inbox(),
  questions: {
    needsReply: noul(
      "Does this email need a reply today?",
    ),
  },
});

mail.on("needsReply", { min: 0.85 },
  google.gmail.label("Reply today"));

await mail.start();
