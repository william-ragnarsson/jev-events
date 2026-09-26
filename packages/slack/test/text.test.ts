import { describe, expect, it } from "vitest";

import { mentionsIn, mrkdwnToText } from "@jev-events/slack";

describe("mentionsIn", () => {
  it("finds people, channels and @here", () => {
    expect(mentionsIn("<@U0ANN> and <@W0BOB|bob>, see <#C0GENERAL|general> <!here>")).toEqual({
      users: ["U0ANN", "W0BOB"],
      channels: ["C0GENERAL"],
      everyone: true,
    });
  });

  it("counts each once", () => {
    expect(mentionsIn("<@U0ANN> <@U0ANN> <#C0GENERAL> <#C0GENERAL|general>")).toEqual({ users: ["U0ANN"], channels: ["C0GENERAL"], everyone: false });
  });

  it("treats @channel and @everyone like @here, but not user groups", () => {
    expect(mentionsIn("<!channel>").everyone).toBe(true);
    expect(mentionsIn("<!everyone>").everyone).toBe(true);
    expect(mentionsIn("<!subteam^S0DEVS|@devs>").everyone).toBe(false);
  });

  it("ignores links and plain text", () => {
    expect(mentionsIn("<https://example.com|@U0ANN> @U0BOB #general")).toEqual({ users: [], channels: [], everyone: false });
  });
});

describe("mrkdwnToText", () => {
  const names = (id: string) => ({ U0ANN: "Ann Smith", C0GENERAL: "general" })[id];

  it("writes people and channels by name", () => {
    expect(mrkdwnToText("<@U0ANN> see <#C0GENERAL>", names)).toBe("@Ann Smith see #general");
  });

  it("falls back to the label Slack sent, then the ID", () => {
    expect(mrkdwnToText("<@U0BOB|bob> <@U0ERIN> <#C0RANDOM|random> <#C0SALES1>")).toBe("@bob @U0ERIN #random #C0SALES1");
  });

  it("writes @here, @channel, user groups and dates the way Slack shows them", () => {
    expect(mrkdwnToText("<!here> <!channel> <!everyone>")).toBe("@here @channel @everyone");
    expect(mrkdwnToText("<!subteam^S0DEVS|@devs> <!subteam^S0OPS>")).toBe("@devs @group");
    expect(mrkdwnToText("due <!date^1392734382^{date_short}|Feb 18, 2014>")).toBe("due Feb 18, 2014");
  });

  it("writes links as label (url), or the url alone when that's all there is", () => {
    expect(mrkdwnToText("<https://example.com/docs|the docs>")).toBe("the docs (https://example.com/docs)");
    expect(mrkdwnToText("<https://example.com/docs>")).toBe("https://example.com/docs");
    expect(mrkdwnToText("<https://example.com|example.com>")).toBe("https://example.com");
    expect(mrkdwnToText("<mailto:ann@example.com|ann@example.com>")).toBe("ann@example.com");
  });

  it("decodes &lt;, &gt; and &amp;, and only once", () => {
    expect(mrkdwnToText("a &lt; b &amp;&amp; c &gt; d")).toBe("a < b && c > d");
    expect(mrkdwnToText("type &amp;lt; for &lt;")).toBe("type &lt; for <");
  });

  it("leaves plain text as it is", () => {
    expect(mrkdwnToText("*Deploy* is _done_ :tada:")).toBe("*Deploy* is _done_ :tada:");
  });
});
