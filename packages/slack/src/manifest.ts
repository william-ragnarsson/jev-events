import { BOT_EVENTS, BOT_SCOPES } from "./scopes.js";

export interface ManifestOptions {
  /** The app's name in Slack, up to 35 characters. Default "Jev Events". */
  name?: string;
  /**
   * Where Slack sends new messages: your runtime's `/webhook/slack`, such as
   * "https://example.com/api/jev/webhook/slack". Leave it out to get them over Socket Mode instead.
   */
  requestUrl?: string;
  /** Where Slack sends people after they add the app: your runtime's `/callback/slack`. */
  redirectUrls?: readonly string[];
}

/**
 * A Slack app manifest with every scope and event `slack.messages()` and the actions need. Paste it
 * at https://api.slack.com/apps?new_app=1 ("From a manifest").
 */
export function manifest(options: ManifestOptions = {}) {
  const name = options.name ?? "Jev Events";
  return {
    display_information: { name, description: "Reads messages and flags what needs attention." },
    features: {
      app_home: { messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      // Slack allows only a-z, 0-9, -, _ and . here. It's also the app's handle, as in /invite @jev_events.
      bot_user: { display_name: handleOf(name), always_online: true },
    },
    oauth_config: {
      ...(options.redirectUrls?.length ? { redirect_urls: [...options.redirectUrls] } : {}),
      scopes: { bot: [...BOT_SCOPES] },
    },
    settings: {
      event_subscriptions: {
        ...(options.requestUrl ? { request_url: options.requestUrl } : {}),
        bot_events: [...BOT_EVENTS],
      },
      interactivity: { is_enabled: false },
      org_deploy_enabled: false,
      socket_mode_enabled: !options.requestUrl,
      token_rotation_enabled: false,
    },
  };
}

/** The app `npx jev-events auth slack` has you create: Socket Mode, so it works without a public URL. */
export const MANIFEST = manifest();

/** A link that opens Slack's "Create app" dialog with the manifest filled in. */
export function manifestUrl(options: ManifestOptions = {}): string {
  return `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest(options)))}`;
}

function handleOf(name: string): string {
  const handle = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return handle || "jev_events";
}
