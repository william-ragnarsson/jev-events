# Google sign-in for Gmail and Calendar

`gmail.ts` and `calendar.ts` read your own Gmail and Google Calendar. Google only lets a script do that through an app you register yourself, and only after you've signed in to that app once. This guide does both. It takes about 10 minutes the first time. It's free, and you don't need a card.

At the end, the three GOOGLE_ lines at the bottom of `.env` are filled in:

```
GOOGLE_CLIENT_ID=…apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=…
GOOGLE_REFRESH_TOKEN=…
```

The ID and secret say which app is asking. The refresh token is your permission for that app to read your mail and calendar, saved so the scripts don't ask you to sign in every time.

## Before you start

- Do **Set up once** in the [README](README.md#set-up-once) first: `npm install`, then `.env` with your TypeSafe key.
- Use one Google account all the way through: in the console, as the test user, and when you sign in. A personal @gmail.com account is easiest. A work or school account can be blocked by its admin (see [Work or school accounts](#work-or-school-accounts)).
- If your browser is signed in to several Google accounts, check the picture at the top right of each Google page to see which one you're using.

## 1. Open the Google Cloud console

Go to [console.cloud.google.com](https://console.cloud.google.com) and sign in. The first time, Google asks for your country and your agreement to its terms. Pick the country, tick the box and click **Agree and continue**.

You may see a free trial offer. Ignore it.

## 2. Create a project

A project holds your app and its settings.

1. Open [New project](https://console.cloud.google.com/projectcreate).
2. Type a name, like `jev-starter`.
3. Leave **Location** as **No organization**.
4. Click **Create** and wait a few seconds.

Then look at the project picker in the top bar. It shows the name of the selected project. Everything below is saved in whichever project is selected, and Google doesn't always switch to the new one. If it shows another name, click it and pick yours.

## 3. Turn on the Gmail and Calendar APIs

Open [this link](https://console.cloud.google.com/flows/enableapi?apiid=gmail.googleapis.com,calendar-json.googleapis.com). It turns on both APIs. Check that it names your project, then click **Next** and **Enable**.

Turn on both even if you only want one of them: `calendar.ts` also uses Gmail to see who you've emailed.

If the link doesn't work, open the menu (☰) and go to **APIs & Services → Library**. Search for **Gmail API**, open it and click **Enable**. Do the same for **Google Calendar API**.

## 4. Set up the Google Auth platform

This decides what Google shows when you sign in to your app. Older guides call it the "OAuth consent screen".

Open the [Google Auth platform](https://console.cloud.google.com/auth/overview). It says it isn't configured yet. Click **Get started** and fill in four short pages:

1. **App Information.** App name: anything, like `Jev starter`. User support email: pick your address. Click **Next**.
2. **Audience.** Choose **External** and click **Next**. Internal is only for Google Workspace organizations, so with a personal account it's greyed out.
3. **Contact Information.** Type your address and click **Next**.
4. **Finish.** Tick the box that agrees to the Google API Services: User Data Policy. Click **Continue**, then **Create**.

The app starts in **Testing**. Leave it there for now. You don't need a logo, a website, a privacy policy or Google's verification for an app only you use.

## 5. Add yourself as a test user

While the app is in Testing, only people on its list of test users can sign in. That includes you, even though you made it.

Open [Audience](https://console.cloud.google.com/auth/audience) (it's also in the menu on the left). Under **Test users**, click **Add users**, type your Gmail address and click **Save**.

## 6. Create the client

The client is what gives you the ID and secret for `.env`.

Open [Clients](https://console.cloud.google.com/auth/clients) and click **Create client**.

- **Application type: Desktop app.** Not Web application. The sign-in in step 7 comes back to a small server on your own computer, and only a Desktop app client allows that.
- **Name:** anything. Only you see it.
- If there's a box about an AI-powered agent, leave it unticked.

Click **Create**. A window shows the **Client ID** and the **Client secret**. Before you close it, paste the ID after `GOOGLE_CLIENT_ID=` and the secret after `GOOGLE_CLIENT_SECRET=` in `.env`, and save:

```
GOOGLE_CLIENT_ID=…apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=…
```

Google shows the full secret only this once.

Lost the secret? Open [Clients](https://console.cloud.google.com/auth/clients), click your client, click **Add secret**, and copy the new secret into `.env`. The client ID stays the same. Once the new one works, click **Disable** on the old secret, then delete it. A client can hold only two.

## 7. Sign in

From the repo root. Skip the `cd` if you're already in `examples/starter`.

```bash
cd examples/starter
npm run google-token
```

It prints `Open this link and sign in:` and a long link. Cmd+click the link, or copy all of it into your browser. Open it in Chrome, Safari or Firefox on the same computer, not in another app's built-in browser, and leave the terminal running.

In the browser:

1. **Choose an account.** Pick the one you added as a test user. If Google picks a different one by itself, click **Use another account**, or open the link in a private window.
2. **"Google hasn't verified this app."** This is expected. The app is yours, and Google hasn't reviewed it. Click **Continue**, the small link, not the **Back to safety** button. Some versions of this page have **Advanced** instead: click it, then **Go to … (unsafe)**.
3. **What the app may access.** This can take one or two screens. On the one with checkboxes, tick **Select all**, or tick each box. They start unticked. They say roughly "Read, compose, and send emails from your Gmail account" and "View and edit events on all your calendars". The scripts only read. The extra access is for Jev's actions, like archiving an email, which do nothing until you turn them on. Jev saves email replies as drafts and never sends them.
4. Click **Continue**.

The tab then says `Got the code. Go back to the terminal to see if it worked.` The terminal is what tells you. When it worked, it prints:

```
Signed in as you@gmail.com. Put this line in .env:

GOOGLE_REFRESH_TOKEN=…
```

Copy the whole `GOOGLE_REFRESH_TOKEN=…` line into `.env` in place of the empty one, and save.

If it says `You didn't allow…` instead, a box was left unticked, and there's no line to copy. Run `npm run google-token` again and tick every box.

If the terminal shows nothing new, Google is showing an error page. See [On Google's page](#on-googles-page).

## 8. Run it

In the same terminal:

```bash
npm run gmail
```

It prints `Watching your inbox.` and then one line for each of your 3 newest emails, like:

```
other      ann@example.com: Lunch on Friday
```

The first word is Jev's label for the email: `personal`, `newsletter` or `other`. New emails show up within about 15 seconds. Stop with Ctrl+C.

```bash
npm run calendar
```

It prints `Watching your calendar.` and then your next 3 events. The number is how likely Jev thinks it is that you need to prepare, from 0 to 1. The date looks the way your computer writes dates:

```
0.04  10/9/2026, 10:00:00 AM  Dentist
```

Personal emails, and events Jev is at least 80% sure about, get a second line starting with `↳`. That line is where your own code goes: `mail.on("kind:personal", …)` in `gmail.ts` and `calendar.on("prepare", …)` in `calendar.ts`.

Both print `Watching…` before they first ask Google for anything. A message right after it means something went wrong. See [When you run gmail or calendar](#when-you-run-gmail-or-calendar).

## Staying signed in

While the app is in Testing, Google signs you out 7 days after you sign in. The scripts then stop with:

```
GoogleAuthError: Google signed this account out: the sign-in expired or was revoked (apps in Testing mode are signed out after 7 days).
Run npm run google-token again and replace GOOGLE_REFRESH_TOKEN in .env.
```

Do what it says: run `npm run google-token` and replace the line in `.env`. It takes a minute.

To stop the weekly sign-out, publish the app. Open [Audience](https://console.cloud.google.com/auth/audience), click **Publish app** and confirm. Google allows an unverified app that only you use. You'll still see the "hasn't verified this app" page when you sign in, maybe the **Advanced** version. After publishing, run `npm run google-token` once more, so your token comes from the published app.

A refresh token also stops working when:

- you remove the app's access from your Google Account,
- you change your Google password,
- it isn't used for 6 months.

The fix is the same each time: `npm run google-token`.

If you don't use the client for 6 months, Google deletes it. Make a new one (step 6) and sign in again.

To take away the app's access yourself, open [your third-party connections](https://myaccount.google.com/linkedapps?filters=3), click the app, then **See details**, **Remove access** and **Confirm**.

## Troubleshooting

### On Google's page

`npm run google-token` waits until the browser comes back to it, with no time limit. When Google stops on an error page instead, the terminal shows nothing new. Fix the cause, press Ctrl+C, and run it again.

**Access blocked: … has not completed the Google verification process** (Error 403: access_denied)\
The account you picked isn't a test user. Add it under [Audience](https://console.cloud.google.com/auth/audience) → **Test users** (step 5), or pick the account you added there.

**Error 400: redirect_uri_mismatch**\
The client is a Web application. Create a new client of type **Desktop app** (step 6), and put its ID and secret in `.env`.

**Error 401: invalid_client** (The OAuth client was not found)\
`GOOGLE_CLIENT_ID` is wrong. Copy it again from [Clients](https://console.cloud.google.com/auth/clients). It ends in `.apps.googleusercontent.com`, with no spaces or quotes around it. If it's right and the client is brand new, wait a few minutes and try again.

**deleted_client**\
The client was deleted. Restore it from [deleted credentials](https://console.cloud.google.com/apis/credentials/deleted), or create a new one (step 6).

**Error 403: disallowed_useragent**\
The link opened inside another app's built-in browser. Copy it into Chrome, Safari or Firefox.

**This site can't be reached. 127.0.0.1 refused to connect.**\
This comes after you click **Continue**. The run that printed this link has stopped, or it's on a different computer from the browser. Each run prints a new link, so a link or tab from an earlier run ends here too. Leave the newest run going and sign in from the link it printed, on the same computer.

### In the terminal, from google-token

**`Put GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first`**\
Fill them in and save `.env`. Run the command from `examples/starter`, where `.env` is.

**`Google refused the sign-in: … Check GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.`**\
Usually the secret is wrong. Copy it again, or add a new one if you no longer have it (end of step 6).

**`Sign-in cancelled.`**\
You clicked **Cancel** or **Back to safety** on Google's page. Run it again, and on the warning click **Continue**.

**`Google sign-in failed (…)`**\
Google sent the browser back without a code. The word in brackets is the error Google gave, or `no code` if it gave none. Run it again.

**`You didn't allow Gmail…` or `You didn't allow Calendar…`**\
A box was left unticked, so it printed no token. Run it again and tick every box.

**`Google sent no refresh token.`**\
Run it again.

### When you run gmail or calendar

**`Put … in .env first (see README.md).`**\
The names it lists are empty in `.env`. That can include `TYPESAFE_API_KEY`.

**`GoogleAuthError: Google signed this account out: …`**\
The 7 days are up, you removed the app's access, or the `GOOGLE_REFRESH_TOKEN` line was cut short when you pasted it. Run `npm run google-token` and replace the line.

**`Error: Couldn't refresh the Google token (401 invalid_client).`**, again and again\
`GOOGLE_CLIENT_ID` or `GOOGLE_CLIENT_SECRET` in `.env` is wrong. The script keeps retrying, so press Ctrl+C, fix the value, and run it again.

**`Error: Couldn't refresh the Google token (401 unauthorized_client).`**, again and again\
The refresh token belongs to a different client than the ID and secret in `.env`, for example after you created a second client. Run `npm run google-token` again with the client that's in `.env` now.

**`GoogleApiError: … Gmail API has not been used in project … before or it is disabled.`** (or `Google Calendar API has not been used…`)\
Step 3 was skipped or done in another project. Open the link in the message, which goes to the right project, and click **Enable**. Then press Ctrl+C and run it again, or wait: it retries by itself, up to 5 minutes apart. You don't need to sign in again.

**`GoogleApiError: … Request had insufficient authentication scopes.`**\
A box was left unticked when you signed in. Run `npm run google-token`, tick every box, and replace the line.

**`AuthenticationError: 401 …`**\
Not Google: `TYPESAFE_API_KEY` in `.env` is wrong.

### Work or school accounts

The admin of a Google Workspace account decides which apps can read it.

**Error 400: admin_policy_enforced**\
Your admin blocks apps like this one. Ask them to trust your app's client ID, or use a personal account.

**Error 403: org_internal**\
The app's audience is Internal, and you signed in with an account outside its organization. Sign in with an account inside it, or use a personal account and a project made with it.
