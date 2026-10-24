# TravelleR + Supabase — configuration guide

This package has **one project root**. The root contains `package.json`, `server.js`, `.env.example`, `supabase-setup.sql`, and docs. Website files are stored only in `public/`. There are no duplicate copies of the website files outside `public/`, no `node_modules/`, and no real `.env` secrets in this ZIP.

## 1. Make a Supabase project

1. Open https://supabase.com/dashboard and create or select your project.
2. Wait until the project is ready.
3. Open **SQL Editor → New query**.
4. Open the `supabase-setup.sql` file at this project root, copy the entire contents into the query, and run it once.
5. Open **Table Editor** and check that the `profiles`, `trips`, and `join_requests` tables exist. Leave Row Level Security enabled; the SQL sets policies for them.

Do not run the SQL in a browser console. Run it in the Supabase SQL Editor. Do not disable RLS to get around an error.

## 2. Configure the browser Supabase client

Open `public/supabase-config.js`. Replace the two placeholders with the values shown in your Supabase dashboard under **Project Settings → API** (the labels may appear under **Data API / API Keys**, depending on dashboard version):

```js
window.TRAVELLER_SUPABASE_URL = 'https://YOUR_PROJECT_REF.supabase.co';
window.TRAVELLER_SUPABASE_ANON_KEY = 'YOUR_PUBLISHABLE_OR_LEGACY_ANON_KEY';
```

Use the Project URL and the **publishable key** (often starts with `sb_publishable_`) or the legacy `anon` key. Never use the `service_role` key or a secret key in this browser file. This value is public by design; RLS is what protects your records.

## 3. Configure the server `.env`

In the project root, make a copy of `.env.example` named `.env`.

- `PORT=3000` — leave as-is for local development.
- `SUPABASE_URL` — paste the same Project URL used in `public/supabase-config.js`.
- `SUPABASE_ANON_KEY` — paste the same public publishable/anon key used in `public/supabase-config.js`.
- `ORS_API_KEY` — paste your OpenRouteService / HeiGIT API key. Get or manage it at https://account.heigit.org/.
- `TRUST_PROXY=false` — leave as-is for local development.

The ORS key belongs only in `.env`, not in `public/`. Do not send your real `.env` file to anyone or include it in ZIPs. `.gitignore` excludes it.

## 4. Configure email OTP login

1. In Supabase, open **Authentication → URL Configuration**.
2. For local development set the Site URL to `http://localhost:3000` and add `http://localhost:3000/**` to the redirect URLs if the dashboard asks for allowed redirects.
3. In **Authentication → Email → Email Templates**, configure the email OTP template to visibly include `{{ .Token }}`. The sign-in screen asks the user to type a six-digit code, so a magic-link-only template is not sufficient.
4. The project restricts sign-up to `@iitr.ac.in` addresses, including subdomains. Use an allowed test email.

If email doesn't arrive, check Authentication logs and the project's email/rate limits. The project setup does not guarantee custom SMTP delivery; configure a custom SMTP provider only if needed.

## 5. Install and start the site

Use Node.js 22 or later. Open a terminal **in the folder that contains `package.json`** and run:

```bash
npm install
npm start
```

Then open:

- Landing page: http://localhost:3000/
- Sign in: http://localhost:3000/auth/login
- App dashboard: http://localhost:3000/app

Do not open `public/index.html` directly as a `file://` URL; the server is needed for the map proxy and proper routes.

## 6. Test that data is really in the database

1. Sign in with an allowed account and create a trip.
2. In Supabase **Table Editor → trips**, confirm a row exists.
3. Sign in in a second browser/profile with another allowed account and check that the trip appears.
4. Create a join request from the second account.
5. In Supabase **Table Editor → join_requests**, confirm a row exists. Sign back in as the trip organizer and accept/decline it; check the row status and trip seat count.
6. Reload the page. The trip/request should still exist because it is stored in PostgreSQL, not `localStorage`.

## Troubleshooting

- **“Supabase is not configured”**: check that `public/supabase-config.js` has no placeholder values and reload.
- **401/403 or RLS errors**: ensure you ran the whole `supabase-setup.sql` script in the correct project; do not disable RLS.
- **Email code rejected/not received**: check that the email template contains `{{ .Token }}`, use an allowed IIT Roorkee address, and check Auth logs/limits.
- **Location suggestions/maps fail**: confirm `ORS_API_KEY` in root `.env`, restart `npm start`, and check the browser Network tab and server console. Keep the ORS key out of `public/`.
- **`npm start` cannot find a module**: run `npm install` from the project root (the folder containing `package.json`).

## Important

The ZIP does not include your actual project credentials, user accounts, or existing records. Supabase must be configured in your own dashboard. Existing records from the former custom PostgreSQL server or browser demo data are not automatically imported.
