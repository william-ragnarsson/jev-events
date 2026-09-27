/** What the messages source and the actions need, as bot scopes. Every install asks for these. */
export const BOT_SCOPES = [
  "channels:history",
  "groups:history",
  "im:history",
  "mpim:history",
  "channels:read",
  "groups:read",
  "im:read",
  "mpim:read",
  "users:read",
  "chat:write",
  "reactions:write",
] as const;

/** The events the app subscribes to: new messages everywhere it is. */
export const BOT_EVENTS = ["message.channels", "message.groups", "message.im", "message.mpim"] as const;
