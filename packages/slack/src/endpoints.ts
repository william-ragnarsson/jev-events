/**
 * Slack's Web API address. JEV_SLACK_API_URL points it at another server instead, such as the fake
 * Slack the tests run. Socket Mode's address comes from Slack itself (`apps.connections.open`).
 */
export function apiUrl(baseUrl = process.env.JEV_SLACK_API_URL): string {
  return baseUrl ? `${baseUrl.replace(/\/+$/, "")}/api` : "https://slack.com/api";
}
