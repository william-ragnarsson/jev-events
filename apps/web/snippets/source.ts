import { listen, noul, type Item, type Source } from "jev-events";

interface Update {
  id: string;
  text: string;
}

/** Poll a JSON endpoint that returns `Update[]` and emit what's new. */
function polling(url: string, everyMs = 60_000): Source<Item, "status-page"> {
  return {
    id: `status-page:${url}`,
    platform: "status-page",
    noun: "update",
    start(ctx) {
      const seen = new Set<string>();
      const poll = async () => {
        try {
          const response = await fetch(url, { signal: ctx.signal });
          const updates = (await response.json()) as Update[];
          for (const update of updates) {
            if (seen.has(update.id)) continue;
            seen.add(update.id);
            ctx.emit({ id: update.id, text: update.text, at: new Date() });
          }
        } catch (error) {
          // Becomes an "error" event. Polling carries on.
          if (!ctx.signal.aborted) ctx.fail(error);
        }
      };
      void poll();
      const timer = setInterval(poll, everyMs);
      ctx.signal.addEventListener("abort", () => clearInterval(timer));
    },
  };
}

const vendors = listen(polling("https://status.example.com/updates.json"), {
  degraded: noul("Does this update say the service is down or degraded now?"),
});
vendors.on("degraded", { min: 0.8 }, (e) => {
  console.warn(`Vendor incident: ${e.item.text}`);
});
await vendors.start();
