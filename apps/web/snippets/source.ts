import { fileStore, monitor, noul, type Item, type Source } from "jev-events";

interface Update {
  id: string;
  text: string;
}

/** A status page that lists its updates as JSON, checked for new ones every 5 minutes. */
function statusPage(url: string): Source<Item, "status-page"> {
  return {
    id: `status-page:${url}`,
    platform: "status-page",
    noun: "update",
    defaults: { every: "5m" },
    async check(ctx) {
      const response = await fetch(url, { signal: ctx.signal });
      // A thrown error becomes an "error" event, and the next check runs as usual.
      if (!response.ok) throw new Error(`${url} answered ${response.status}`);
      const updates = (await response.json()) as Update[];

      // The cursor holds what the last check saw. The first check only notes what's there.
      const seen = await ctx.cursor.get<string[]>();
      for (const update of updates) {
        if (seen && !seen.includes(update.id)) await ctx.emit({ id: update.id, text: update.text, at: new Date() });
      }
      await ctx.cursor.set(updates.map((update) => update.id));
    },
  };
}

const vendors = monitor({
  source: statusPage("https://status.example.com/updates.json"),
  questions: { degraded: noul("Does this update say the service is down or degraded now?") },
}).on("degraded", { min: 0.8 }, (e) => console.warn(`Vendor incident: ${e.item.text}`));

// fileStore() keeps the cursor in .jev-events/, so a restart doesn't judge anything twice.
await vendors.start({ store: fileStore() });
