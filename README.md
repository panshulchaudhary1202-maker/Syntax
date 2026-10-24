# TravelleR

Landing page → "Continue with Google" (IITR accounts only) → trip-sharing app with openrouteservice maps.

## Run locally
1. Copy `.env.example` to `.env` and fill in `DATABASE_URL`, `GOOGLE_CLIENT_ID` and `ORS_API_KEY`.
2. `npm install`
3. `npm start`, then open http://localhost:3000

## Google sign-in setup (one time)
1. Open https://console.cloud.google.com/ and create a project (or pick one).
2. **APIs & Services → OAuth consent screen**: set up the app name and your email. Choose **External**.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID → Web application**.
4. Under **Authorized JavaScript origins** add `http://localhost:3000`. Later add your live site address too (for example `https://your-app.onrender.com`). No redirect URI is needed.
5. Copy the **Client ID** into `GOOGLE_CLIENT_ID` in `.env` and restart the server.

The server checks every Google sign-in itself: valid signature, correct client ID, verified email, an
`iitr.ac.in` address (or a subdomain such as `cs.iitr.ac.in`), and a Google account managed by the IITR
domain (`hd`). If real IITR accounts are rejected because IITR mail is not hosted on Google Workspace,
set `GOOGLE_REQUIRE_HOSTED_DOMAIN=false`. That relaxes the last check only; the email domain is still enforced.

## Pages
- `/` landing page (`public/landing.html`)
- `/auth/login` sign-in (`public/login.html`)
- `/app` the trips app (`public/index.html`, `public/app.js`)

## Maps
`public/openrouteservice-maps.js` talks to `/ors/...` on this server. `server.js` adds `ORS_API_KEY`
and forwards to api.heigit.org, so the key never reaches the browser. Only signed-in users can use it.

## Tests
Set `DATABASE_URL_TEST` to a disposable database, then `npm test` (it wipes that database).
The tests replace Google's token check with a stand-in, so they need no Google account.
