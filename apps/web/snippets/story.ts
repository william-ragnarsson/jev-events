import { choice, monitor } from "jev-events";
import { google } from "@jev-events/google";
// @hide-start
import type { ConnectionInfo, JsonValue } from "jev-events";
declare function profileOf(userId: string | undefined): Promise<JsonValue>;
declare function notify(connection: ConnectionInfo, item: unknown): void;
declare function askUser(connection: ConnectionInfo, event: unknown): void;
// @hide-end

export const invites = monitor({
  source: google.calendar.invites(),
  profile: (connection) => profileOf(connection.userId),
  questions: {
    importance: choice("How important is this meeting to this person?", {
      critical: "They should be there",
      useful: "Worth going if they're free",
      skip: null,
    }),
  },
});

invites.on("importance:critical", { min: 0.85, review: 0.6 },
  google.calendar.respond("accepted"));
invites.on("importance:critical", { min: 0.85 },
  (e) => notify(e.connection, e.item));
invites.on("review", (e) => askUser(e.connection, e));

// Runs for every connected user. Monitors start in dry-run,
// where native actions only report what they would do.
