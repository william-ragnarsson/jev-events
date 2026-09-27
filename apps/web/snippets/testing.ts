import { from, monitor, noul } from "jev-events";
import { mockJev } from "jev-events/testing";
import { expect, test } from "vitest";

const questions = {
  outage: noul("Does this log line describe a failure a human should look at?"),
};

test("pages someone for outages only", async () => {
  // Answers per question id; a number is the probability of yes.
  const jev = mockJev(({ state }) => ({
    outage: JSON.stringify(state).includes("ECONNREFUSED") ? 0.96 : 0.03,
  }));
  const paged: string[] = [];

  const logs = monitor({
    source: from(["GET /health 200", "db: connect ECONNREFUSED 10.0.0.5:5432"]),
    questions,
    client: jev,
  }).on("outage", { min: 0.8 }, (e) => {
    paged.push(e.item.text);
  });

  // A finite source: judge everything, then stop.
  const stats = await logs.run();
  expect(paged).toEqual(["db: connect ECONNREFUSED 10.0.0.5:5432"]);
  expect(stats.judged).toBe(2);
  // Exactly what Jev saw for the second line:
  expect(jev.calls[1]?.state).toEqual({
    item: { text: "db: connect ECONNREFUSED 10.0.0.5:5432" },
  });
});
