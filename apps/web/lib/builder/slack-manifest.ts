/**
 * `slack.manifestUrl()` from `@jev-events/slack`, for the browser: the package itself needs Node.
 * `test/builder.test.ts` checks that both build the same manifest.
 */

const BOT_SCOPES = [
  'channels:history',
  'groups:history',
  'im:history',
  'mpim:history',
  'channels:read',
  'groups:read',
  'im:read',
  'mpim:read',
  'users:read',
  'chat:write',
  'reactions:write',
];

const BOT_EVENTS = ['message.channels', 'message.groups', 'message.im', 'message.mpim'];

export interface ManifestOptions {
  name?: string;
  requestUrl?: string;
  redirectUrls?: readonly string[];
}

export function manifest(options: ManifestOptions = {}) {
  const name = options.name ?? 'Jev Events';
  return {
    display_information: { name, description: 'Reads messages and flags what needs attention.' },
    features: {
      app_home: { messages_tab_enabled: true, messages_tab_read_only_enabled: false },
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

/** A link that opens Slack's "Create app" dialog with the manifest filled in. */
export function manifestUrl(options: ManifestOptions = {}): string {
  return `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest(options)))}`;
}

function handleOf(name: string): string {
  const handle = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return handle || 'jev_events';
}
