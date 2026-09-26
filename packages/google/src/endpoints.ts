export interface GoogleEndpoints {
  /** Gmail API for the signed-in user. */
  gmail: string;
  calendar: string;
  token: string;
  /** Google's sign-in page. */
  authorize: string;
}

/**
 * Google's API addresses. JEV_GOOGLE_API_URL points all of them at one server instead, such as the
 * fake Google the tests run.
 */
export function endpoints(baseUrl = process.env.JEV_GOOGLE_API_URL): GoogleEndpoints {
  if (!baseUrl) {
    return {
      gmail: "https://gmail.googleapis.com/gmail/v1/users/me",
      calendar: "https://www.googleapis.com/calendar/v3",
      token: "https://oauth2.googleapis.com/token",
      authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    };
  }
  const base = baseUrl.replace(/\/+$/, "");
  return {
    gmail: `${base}/gmail/v1/users/me`,
    calendar: `${base}/calendar/v3`,
    token: `${base}/token`,
    authorize: `${base}/o/oauth2/v2/auth`,
  };
}
