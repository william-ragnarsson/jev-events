import { defineAction, from, monitor, noul } from "jev-events";
import { mockJev } from "jev-events/testing";
import { expect, test } from "vitest";

const refunded: string[] = [];

// Your own action. Like a built-in one, it only runs once dryRun is false.
const refund = defineAction({
  platform: "*",
  name: "billing.refund",
  describe: (e) => `refund ticket ${e.item.id}`,
  run: async (e) => {
    refunded.push(e.item.id);
  },
});

function tickets(dryRun: boolean) {
  return monitor({
    source: from([
      { id: "t1", text: "I was charged twice this month. Please refund one of them." },
      { id: "t2", text: "How do I export my data?" },
    ]),
    questions: { refund: noul("Is the customer asking for their money back?") },
    client: mockJev(({ state }) => ({ refund: JSON.stringify(state).includes("refund") ? 0.95 : 0.02 })),
    dryRun,
  }).on("refund", { min: 0.9 }, refund);
}

test("in dry-run, says what it would do and does nothing", async () => {
  const wouldDo: string[] = [];
  const stats = await tickets(true)
    .on("action", (e) => wouldDo.push(`${e.status}: ${e.description}`))
    .run();
  expect(wouldDo).toEqual(["dry-run: refund ticket t1"]);
  expect(stats.actions.done).toBe(0);
});

test("armed, refunds the right ticket once", async () => {
  const stats = await tickets(false).run();
  expect(stats.actions.done).toBe(1);
  expect(refunded).toEqual(["t1"]);
});
