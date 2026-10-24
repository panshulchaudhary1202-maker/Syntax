# TravelleR API contract

All API errors use `{ "error": "Readable message" }`. IDs returned to the browser are strings except `/api/me.id`. Email addresses and session tokens are never returned.

## Authentication

- `GET /auth/login` serves the login page.
- `GET /auth/config` returns `{ "googleClientId": "…" }` (the client ID is public).
- `GET /auth/status` returns `{ "signedIn": boolean, "needsProfile": boolean }`.
- `POST /auth/google` body `{ "credential": "<Google ID token>" }`. The server verifies the token with Google's keys, requires a verified email on the configured IITR domain (or a subdomain) and a Google account hosted by that domain, then sets the session cookie. Success returns `{ "ok": true, "needsProfile": boolean, "suggestedName"?: string }`. Failures return 400, 401 (token not verifiable) or 403 (not an IITR account).
- `POST /auth/profile` body `{ "name": "…", "department": "Computer Science · 3rd year" }`; success returns `{ "ok": true }`. Needed only once.
- `POST /auth/logout` deletes the current session and returns `{ "ok": true }`.

Sessions are random 32-byte cookie tokens stored only as SHA-256 hashes and expire after 30 days. An incomplete profile is treated as unauthenticated by every `/api/*` route.

## Trips and requests

Every `/api/*` route requires a complete signed-in profile. Identity comes from the session, never from request data.

- `GET /api/me` returns `{ "id": 1, "name": "Aarav Sharma", "initials": "AS", "department": "Computer Science · 3rd year" }`.
- `GET /api/trips` returns an array with string `id`, `YYYY-MM-DD` `date`, `HH:MM` `time`, `seats` (seats remaining), `mine`, `requested`, and organizer-only `requests`. Other students never see request details.
- `POST /api/trips` accepts `{ origin, destination, date, time, route, mode, modeOther, seats, cost, notes }`, returns 201 `{ "id": "12" }`.
- `POST /api/trips/:id/requests` accepts `{ "message": "…" }`, returns 201 `{ "ok": true }`. Missing trip is 404, own trip 403, duplicate or full trip 409.
- `PATCH /api/requests/:id` accepts `{ "status": "Pending" | "Accepted" | "Declined" }`, organizer only, returns `{ "ok": true }`. Full trip on acceptance returns 409 `{ "error": "No seats remaining on this trip." }`.

Trip limits: destination 100, origin 160, route 180, other mode 80, notes 900; seats 1–8; cost 0–100000; request message 500. Modes are Car, Train, Bus, Bike, Other. Trip dates must be today in Asia/Kolkata through one year ahead; times use `HH:MM`.

The browser requires same-origin JSON for POST/PATCH. The server limits JSON bodies to 20 KB, enforces per-user creation limits, and returns 401 for unauthenticated API calls.
