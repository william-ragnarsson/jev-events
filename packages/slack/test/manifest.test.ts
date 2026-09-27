import { describe, expect, it } from "vitest";

import { BOT_EVENTS, BOT_SCOPES, manifest, MANIFEST, manifestUrl, SETUP_STEPS } from "@jev-events/slack";

describe("manifest", () => {
  it("asks for what the source and the actions use, with Socket Mode on", () => {
    expect([...MANIFEST.oauth_config.scopes.bot].sort()).toEqual(
      [
        "channels:history",
        "channels:read",
        "chat:write",
        "groups:history",
        "groups:read",
        "im:history",
        "im:read",
        "mpim:history",
        "mpim:read",
        "reactions:write",
        "users:read",
      ].sort(),
    );
    expect(MANIFEST.oauth_config.scopes.bot).toEqual([...BOT_SCOPES]);
    expect(MANIFEST.settings.event_subscriptions.bot_events).toEqual(["message.channels", "message.groups", "message.im", "message.mpim"]);
    expect(MANIFEST.settings.event_subscriptions.bot_events).toEqual([...BOT_EVENTS]);
    expect(MANIFEST.settings.socket_mode_enabled).toBe(true);
    expect(MANIFEST.settings.event_subscriptions).not.toHaveProperty("request_url");
    expect(MANIFEST.oauth_config).not.toHaveProperty("redirect_urls");
  });

  it("names the app and makes its handle from the name", () => {
    expect(MANIFEST.display_information.name).toBe("Jev Events");
    expect(MANIFEST.features.bot_user.display_name).toBe("jev_events");
    expect(manifest({ name: "Acme Triage Bot!" }).features.bot_user.display_name).toBe("acme_triage_bot");
    expect(manifest({ name: "🚨" }).features.bot_user.display_name).toBe("jev_events");
  });

  it("sends new messages to your site instead of Socket Mode when you give a request URL", () => {
    const app = manifest({
      requestUrl: "https://example.com/api/jev/webhook/slack",
      redirectUrls: ["https://example.com/api/jev/callback/slack"],
    });

    expect(app.settings.socket_mode_enabled).toBe(false);
    expect(app.settings.event_subscriptions).toEqual({ request_url: "https://example.com/api/jev/webhook/slack", bot_events: [...BOT_EVENTS] });
    expect(app.oauth_config).toEqual({ redirect_urls: ["https://example.com/api/jev/callback/slack"], scopes: { bot: [...BOT_SCOPES] } });
  });

  it("keeps token rotation off, since the saved token has to keep working", () => {
    expect(MANIFEST.settings.token_rotation_enabled).toBe(false);
  });
});

describe("manifestUrl", () => {
  it("opens Slack's Create app dialog with the manifest filled in", () => {
    const link = new URL(manifestUrl({ requestUrl: "https://example.com/api/jev/webhook/slack" }));

    expect(`${link.origin}${link.pathname}`).toBe("https://api.slack.com/apps");
    expect(link.searchParams.get("new_app")).toBe("1");
    expect(JSON.parse(link.searchParams.get("manifest_json") ?? "null")).toEqual(manifest({ requestUrl: "https://example.com/api/jev/webhook/slack" }));
  });

  it("is what the first setup step links to", () => {
    const step = SETUP_STEPS[0] ?? "";
    const link = new URL(step.slice(step.indexOf("https://")));

    expect(JSON.parse(link.searchParams.get("manifest_json") ?? "null")).toEqual(MANIFEST);
  });
});
