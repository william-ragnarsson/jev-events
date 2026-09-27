export interface MicrosoftEndpoints {
  /** Microsoft Graph v1.0, such as `https://graph.microsoft.com/v1.0`. */
  graph: string;
  /** The Microsoft identity platform, such as `https://login.microsoftonline.com`. */
  login: string;
}

/**
 * Where Microsoft's APIs live. `JEV_MICROSOFT_API_URL` points both at one server instead, such as a
 * fake Microsoft in tests.
 */
export function endpoints(baseUrl = process.env.JEV_MICROSOFT_API_URL): MicrosoftEndpoints {
  if (!baseUrl) {
    return { graph: "https://graph.microsoft.com/v1.0", login: "https://login.microsoftonline.com" };
  }
  const base = baseUrl.replace(/\/+$/, "");
  return { graph: `${base}/v1.0`, login: base };
}

/** A sign-in URL for a tenant: "common" for any account, or your directory's id for one organization. */
export function oauthUrl(path: "authorize" | "token" | "devicecode", tenant = "common"): string {
  return `${endpoints().login}/${encodeURIComponent(tenant || "common")}/oauth2/v2.0/${path}`;
}
