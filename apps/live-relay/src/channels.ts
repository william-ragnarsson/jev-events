export interface StreamInfo {
  channel: string;
  game?: string;
  viewers?: number;
}

/** Decides which public chat the relay reads next. */
export interface ChannelPicker {
  /** The next channel to read, skipping `avoid`, or undefined when none is available. */
  pick(avoid: ReadonlySet<string>): Promise<StreamInfo | undefined>;
}

/** Take turns through a fixed list, e.g. LIVE_CHANNELS=channel_a,channel_b. */
export function fixedChannels(channels: readonly string[]): ChannelPicker {
  const list = channels.map((channel) => channel.trim().replace(/^#/, "").toLowerCase()).filter(Boolean);
  let next = 0;
  return {
    async pick(avoid) {
      for (let offset = 0; offset < list.length; offset++) {
        const index = (next + offset) % list.length;
        const channel = list[index] as string;
        if (avoid.has(channel)) continue;
        next = (index + 1) % list.length;
        return { channel };
      }
      return undefined;
    },
  };
}

export interface LiveChannelsOptions {
  clientId: string;
  clientSecret: string;
  /** Channels to prefer while they're live. */
  preferred?: readonly string[];
  /** Never read these. */
  blocked?: readonly string[];
  /** Default "en". */
  language?: string;
  /** Busy enough to look alive, small enough to read. Default 1,500 to 40,000 viewers. */
  minViewers?: number;
  maxViewers?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

interface HelixStream {
  user_login: string;
  game_name?: string;
  viewer_count: number;
  is_mature?: boolean;
}

/**
 * Pick a live channel from Twitch's directory with an app access token (client credentials).
 * Channels marked mature are skipped.
 */
export function liveChannels(options: LiveChannelsOptions): ChannelPicker {
  const request = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const blocked = new Set((options.blocked ?? []).map((channel) => channel.toLowerCase()));
  const preferred = (options.preferred ?? []).map((channel) => channel.toLowerCase());
  const min = options.minViewers ?? 1_500;
  const max = options.maxViewers ?? 40_000;
  let token: { value: string; expires: number } | undefined;
  let cache: { streams: HelixStream[]; expires: number } | undefined;

  async function appToken(): Promise<string> {
    if (token && token.expires > now()) return token.value;
    const response = await request("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      body: new URLSearchParams({ client_id: options.clientId, client_secret: options.clientSecret, grant_type: "client_credentials" }),
    });
    if (!response.ok) throw new Error(`Twitch app token request failed (${response.status}).`);
    const json = (await response.json()) as { access_token: string; expires_in: number };
    token = { value: json.access_token, expires: now() + (json.expires_in - 60) * 1000 };
    return token.value;
  }

  async function streams(query: URLSearchParams): Promise<HelixStream[]> {
    const response = await request(`https://api.twitch.tv/helix/streams?${query}`, {
      headers: { "Client-Id": options.clientId, Authorization: `Bearer ${await appToken()}` },
    });
    if (response.status === 401) token = undefined;
    if (!response.ok) throw new Error(`Twitch streams request failed (${response.status}).`);
    return ((await response.json()) as { data: HelixStream[] }).data;
  }

  async function directory(): Promise<HelixStream[]> {
    if (cache && cache.expires > now()) return cache.streams;
    const found: HelixStream[] = [];
    if (preferred.length > 0) {
      const query = new URLSearchParams({ type: "live" });
      for (const login of preferred.slice(0, 100)) query.append("user_login", login);
      found.push(...(await streams(query)));
    }
    found.push(...(await streams(new URLSearchParams({ type: "live", first: "100", language: options.language ?? "en" }))));
    cache = { streams: found, expires: now() + 5 * 60_000 };
    return found;
  }

  return {
    async pick(avoid) {
      const all = await directory();
      const usable = all.filter(
        (stream) => !stream.is_mature && !blocked.has(stream.user_login.toLowerCase()) && !avoid.has(stream.user_login.toLowerCase()),
      );
      const favorite = usable.find((stream) => preferred.includes(stream.user_login.toLowerCase()));
      const inRange = usable.filter((stream) => stream.viewer_count >= min && stream.viewer_count <= max);
      const choice = favorite ?? inRange[Math.floor(Math.random() * Math.min(inRange.length, 20))];
      if (!choice) return undefined;
      return {
        channel: choice.user_login.toLowerCase(),
        viewers: choice.viewer_count,
        ...(choice.game_name ? { game: choice.game_name } : {}),
      };
    },
  };
}
