export interface TwitchEndpoints {
  /** The Helix API. */
  helix: string;
  /** Sign-in: device codes, tokens, token checks and the consent page. */
  id: string;
  /** EventSub over WebSocket, where chat messages arrive. */
  eventsub: string;
}

/**
 * Twitch's addresses. JEV_TWITCH_API_URL points all of them at one server instead, such as the fake
 * Twitch the tests run.
 */
export function endpoints(baseUrl = process.env.JEV_TWITCH_API_URL): TwitchEndpoints {
  if (!baseUrl) {
    return {
      helix: "https://api.twitch.tv/helix",
      id: "https://id.twitch.tv/oauth2",
      eventsub: "wss://eventsub.wss.twitch.tv/ws",
    };
  }
  const base = baseUrl.replace(/\/+$/, "");
  return {
    helix: `${base}/helix`,
    id: `${base}/oauth2`,
    eventsub: `${base.replace(/^http/, "ws")}/eventsub`,
  };
}
