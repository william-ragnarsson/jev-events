// The monitor walked through on the home page. A copy of apps/web/snippets/home.ts, which is
// type-checked against the library; apps/web/test/home.test.ts keeps the two the same.
export const HOME_CODE = `import { monitor, noul } from "jev-events";
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

await mail.start();`;

export type Step = 'watch' | 'ask' | 'act';

/** The rail beside the code: each step and the line it sits on. */
export const HOME_STEPS: { step: Step; label: string; text: string; line: number }[] = [
  { step: 'watch', label: 'Watch', text: 'Each new email', line: 5 },
  { step: 'ask', label: 'Ask', text: 'Jev answers with a number from 0 to 1', line: 8 },
  { step: 'act', label: 'Act', text: 'At 0.85 or more, add the label', line: 13 },
];

/** The code that matters, marked in the order it appears. Each mark lights up during its step. */
export const HOME_MARKS: { step: Step; code: string }[] = [
  { step: 'watch', code: 'google.gmail.inbox()' },
  { step: 'ask', code: '"Does this email need a reply today?"' },
  { step: 'act', code: '{ min: 0.85 }' },
  { step: 'act', code: 'google.gmail.label("Reply today")' },
];
