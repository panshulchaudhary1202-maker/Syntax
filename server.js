'use strict';

require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { Pool } = require('pg');
const { OAuth2Client } = require('google-auth-library');

const app = express();
if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'DENY' });
  next();
});
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL && /supabase|render|neon|railway/i.test(process.env.DATABASE_URL) ? { rejectUnauthorized: false } : undefined });
const COOKIE = 'traveller_session';
const DAY = 86400000;
const authLimits = new Map();

const error = (res, status, message, extra = {}) => res.status(status).json({ error: message, ...extra });
const allowedDomain = () => (process.env.ALLOWED_EMAIL_DOMAIN || 'iitr.ac.in').toLowerCase().replace(/^\.+|\.+$/g, '');
const domainAllowed = domain => { const allowed = allowedDomain(); return domain === allowed || domain.endsWith(`.${allowed}`); };
const normalizeEmail = value => {
  if (typeof value !== 'string' || value.length > 320) return null;
  const email = value.trim().toLowerCase();
  const at = email.lastIndexOf('@');
  if (at < 1) return null;
  const local = email.slice(0, at).split('+')[0];
  const domain = email.slice(at + 1);
  if (!local || !/^[^\s@]+$/.test(local) || !domainAllowed(domain)) return null;
  return `${local}@${domain}`;
};
// Google sign-in. verify() checks Google's signature, audience (our client ID), issuer and expiry.
const googleClientId = () => String(process.env.GOOGLE_CLIENT_ID || '').trim();
const googleClient = new OAuth2Client();
const googleAuth = {
  async verify(credential) {
    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: googleClientId() });
    const p = ticket.getPayload() || {};
    return { email: p.email, emailVerified: p.email_verified === true, hostedDomain: p.hd, name: p.name };
  }
};
const tokenHash = token => crypto.createHash('sha256').update(token).digest('hex');
const cookieSecure = req => process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production' || req.secure;
function setSessionCookie(req, res, token) {
  const secure = cookieSecure(req);
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: 30 * DAY });
}
function clearSessionCookie(req, res) { res.clearCookie(COOKIE, { httpOnly: true, sameSite: 'lax', secure: cookieSecure(req), path: '/' }); }
function readCookie(header, name) {
  for (const item of String(header || '').split(';')) {
    const idx = item.indexOf('=');
    if (idx > 0 && item.slice(0, idx).trim() === name) return decodeURIComponent(item.slice(idx + 1).trim());
  }
  return null;
}

app.use('/auth', (req, res, next) => {
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const existing = authLimits.get(key);
  if (!existing || now - existing.start >= 60 * 60 * 1000) authLimits.set(key, { start: now, count: 1 });
  else if (existing.count >= 300) return error(res, 429, 'Too many sign-in requests. Please try again later.', { retryAfter: Math.ceil((existing.start + 3600000 - now) / 1000) });
  else existing.count++;
  next();
});

app.use((req, res, next) => {
  if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) return next();
  if (!req.is('application/json')) return error(res, 415, 'Content-Type must be application/json.');
  const origin = req.get('origin');
  if (origin) {
    let originHost;
    try { originHost = new URL(origin).host; } catch { return error(res, 403, 'Origin is not allowed.'); }
    if (originHost !== req.get('host')) return error(res, 403, 'Origin is not allowed.');
  }
  next();
});
app.use(express.json({ limit: '20kb', strict: true }));

// Static assets are resolved exclusively beneath public/. Dotfiles and traversal are rejected.
app.use((req, res, next) => {
  let decoded;
  try { decoded = decodeURIComponent(req.path); } catch { return res.sendStatus(404); }
  if (decoded.split(/[\\/]+/).some(part => part.startsWith('.') || part === '..')) return res.sendStatus(404);
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { dotfiles: 'deny', index: false, fallthrough: true, setHeaders(res) { res.setHeader('X-Content-Type-Options', 'nosniff'); } }));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'landing.html')));
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/auth/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/auth/status', async (req, res, next) => {
  try {
    const token = readCookie(req.headers.cookie, COOKIE);
    if (!token) return res.json({ signedIn: false, needsProfile: false });
    const result = await pool.query('SELECT u.name, u.department FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()', [tokenHash(token)]);
    if (!result.rowCount) return res.json({ signedIn: false, needsProfile: false });
    return res.json({ signedIn: true, needsProfile: !result.rows[0].name || !result.rows[0].department });
  } catch (e) { next(e); }
});

app.get('/auth/config', (req, res) => res.json({ googleClientId: googleClientId() }));

app.post('/auth/google', async (req, res, next) => {
  if (!googleClientId()) return error(res, 500, 'Google sign-in is not configured yet. Add GOOGLE_CLIENT_ID to .env and restart the server.');
  const credential = typeof req.body?.credential === 'string' ? req.body.credential : '';
  if (!credential || credential.length > 4096) return error(res, 400, 'Google sign-in failed. Please try again.');
  let identity;
  try { identity = await googleAuth.verify(credential); }
  catch { return error(res, 401, 'Google sign-in could not be verified. Please try again.'); }
  const email = normalizeEmail(identity.email);
  if (!email || identity.emailVerified !== true) return error(res, 403, 'Only IIT Roorkee accounts can sign in. Use your @iitr.ac.in Google account.');
  const hosted = typeof identity.hostedDomain === 'string' ? identity.hostedDomain.toLowerCase() : '';
  if (process.env.GOOGLE_REQUIRE_HOSTED_DOMAIN !== 'false' && !(hosted && domainAllowed(hosted))) return error(res, 403, 'This Google account is not managed by IIT Roorkee. Sign in with your official IITR account.');
  try {
    const userResult = await pool.query('INSERT INTO users(email) VALUES($1) ON CONFLICT(email) DO UPDATE SET email=EXCLUDED.email RETURNING id,name,department', [email]);
    const user = userResult.rows[0];
    const token = crypto.randomBytes(32).toString('hex');
    await pool.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '30 days')", [tokenHash(token), user.id]);
    setSessionCookie(req, res, token);
    const needsProfile = !user.name || !user.department;
    return res.json({ ok: true, needsProfile, ...(needsProfile && typeof identity.name === 'string' ? { suggestedName: identity.name.slice(0, 100) } : {}) });
  } catch (e) { next(e); }
});

async function requireSession(req, res, next) {
  try {
    const token = readCookie(req.headers.cookie, COOKIE);
    if (!token) return error(res, 401, 'Not signed in.');
    const result = await pool.query('SELECT u.id,u.email,u.name,u.department FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()', [tokenHash(token)]);
    if (!result.rowCount) return error(res, 401, 'Your session has expired. Sign in again.');
    req.user = result.rows[0];
    if (!req.user.name || !req.user.department) return error(res, 401, 'Complete your profile to continue.');
    next();
  } catch (e) { next(e); }
}
app.post('/auth/profile', async (req, res, next) => {
  try {
    const token = readCookie(req.headers.cookie, COOKIE);
    if (!token) return error(res, 401, 'Sign in before completing your profile.');
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const department = typeof req.body?.department === 'string' ? req.body.department.trim() : '';
    if (name.length < 2 || name.length > 100) return error(res, 400, 'Name must be 2 to 100 characters.');
    if (department.length < 1 || department.length > 140) return error(res, 400, 'Department must be 1 to 140 characters.');
    const result = await pool.query('UPDATE users SET name=$2,department=$3 WHERE id=(SELECT user_id FROM sessions WHERE token_hash=$1 AND expires_at>now()) AND (name IS NULL OR department IS NULL) RETURNING id', [tokenHash(token), name, department]);
    if (!result.rowCount) return error(res, 409, 'Profile is already complete or your session has expired.');
    return res.json({ ok: true });
  } catch (e) { next(e); }
});
app.post('/auth/logout', async (req, res, next) => {
  try {
    const token = readCookie(req.headers.cookie, COOKIE);
    if (token) await pool.query('DELETE FROM sessions WHERE token_hash=$1', [tokenHash(token)]);
    clearSessionCookie(req, res);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

const initials = name => String(name || '?').trim().split(/\s+/).slice(0, 2).map(x => x[0] || '').join('').toUpperCase() || '?';
app.get('/api/me', requireSession, (req, res) => res.json({ id: Number(req.user.id), name: req.user.name, initials: initials(req.user.name), department: req.user.department }));


app.get('/api/trips', requireSession, async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT
        t.id,
        t.origin,
        t.destination,
        t.route,
        t.mode,
        t.mode_other,
        t.trip_date,
        t.trip_time,
        t.seats_total,
        t.cost,
        t.notes,
        t.organizer_id,
        u.name AS organizer,
        u.email AS organizer_email,
        u.department,

        t.seats_total - (
          SELECT count(*)
          FROM trip_requests ar
          WHERE ar.trip_id = t.id
            AND ar.status = 'Accepted'
        ) AS seats,

        EXISTS (
          SELECT 1
          FROM trip_requests mr
          WHERE mr.trip_id = t.id
            AND mr.requester_id = $1
        ) AS requested,

        (
          SELECT mr.status
          FROM trip_requests mr
          WHERE mr.trip_id = t.id
            AND mr.requester_id = $1
        ) AS my_request_status,

        EXISTS (
          SELECT 1
          FROM trip_requests mr
          WHERE mr.trip_id = t.id
            AND mr.requester_id = $1
            AND mr.status = 'Accepted'
        ) AS is_member,

        CASE
          WHEN t.organizer_id = $1 THEN COALESCE((
            SELECT json_agg(json_build_object(
              'id', r.id::text,
              'name', ru.name,
              'initials', upper(
                left(ru.name, 1) ||
                coalesce(left(split_part(ru.name, ' ', 2), 1), '')
              ),
              'college', ru.department,
              'message', r.message,
              'status', r.status,
              'createdAt', r.created_at
            ))
            FROM trip_requests r
            JOIN users ru ON ru.id = r.requester_id
            WHERE r.trip_id = t.id
          ), '[]'::json)
          ELSE '[]'::json   
        END AS requests,

        CASE
          WHEN t.organizer_id = $1 OR EXISTS (
            SELECT 1
            FROM trip_requests mr
            WHERE mr.trip_id = t.id
              AND mr.requester_id = $1
              AND mr.status = 'Accepted'
          ) THEN COALESCE((
            SELECT json_agg(json_build_object(
              'id', ru.id::text,
              'name', ru.name,
              'email', ru.email,
              'department', ru.department
            ))
            FROM trip_requests r
            JOIN users ru ON ru.id = r.requester_id
            WHERE r.trip_id = t.id
              AND r.status = 'Accepted'
          ), '[]'::json)
          ELSE '[]'::json
        END AS members,

        to_char(t.trip_date, 'YYYY-MM-DD') AS date,
        to_char(t.trip_time, 'HH24:MI') AS time

      FROM trips t
      JOIN users u ON u.id = t.organizer_id
      WHERE t.trip_date >=
        (now() AT TIME ZONE 'Asia/Kolkata')::date
      ORDER BY t.trip_date, t.trip_time
    `, [req.user.id]);

    res.json(result.rows.map(r => {
      const mine =
        String(r.organizer_id) === String(req.user.id);

      const isMember = Boolean(r.is_member);

      return {
        id: String(r.id),
        origin: r.origin,
        destination: r.destination,
        route: r.route,
        mode: r.mode,
        modeOther: r.mode_other,
        date: r.date,
        time: r.time,
        seats: Number(r.seats),
        cost: Number(r.cost),
        notes: r.notes,
        status: 'open',
        organizer: r.organizer,
        organizerEmail: (mine || isMember)
          ? r.organizer_email
          : null,
        initials: initials(r.organizer),
        department: r.department,
        verified: true,
        mine,
        requested: r.requested,
        myRequestStatus: r.my_request_status,
        isMember,
        members: r.members,
        requests: r.requests
      };
    }));
  } catch (e) {
    next(e);
  }
});


app.delete('/api/trips/:id', requireSession, async (req, res, next) => {
  const id = Number(req.params.id);
  const reason = typeof req.body?.reason === 'string'
    ? req.body.reason.trim().slice(0, 300)
    : '';

  if (!Number.isSafeInteger(id) || id < 1) {
    return res.status(400).json({ error: 'Invalid trip ID.' });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    // Only the host can cancel; lock the trip so nobody joins mid-cancellation.
    const tripResult = await client.query(
      `SELECT t.id, t.origin, t.destination,
              to_char(t.trip_date, 'DD Mon YYYY') AS date,
              u.name AS host_name
       FROM trips t
       JOIN users u ON u.id = t.organizer_id
       WHERE t.id = $1 AND t.organizer_id = $2
       FOR UPDATE OF t`,
      [id, req.user.id]
    );

    if (!tripResult.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Trip not found or you are not its host.' });
    }

    const trip = tripResult.rows[0];

    const accepted = await client.query(
      `SELECT count(*)::int AS n
       FROM trip_requests
       WHERE trip_id = $1 AND status = 'Accepted'`,
      [id]
    );

    if (accepted.rows[0].n > 0 && !reason) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'Please give a reason. Your accepted members will be notified.'
      });
    }

    const route = `${trip.origin} → ${trip.destination} (${trip.date})`;
    const reasonText = reason ? ` Reason: "${reason}"` : '';

    const memberNote =
      `❌ ${trip.host_name || 'The host'} cancelled the trip ${route}.${reasonText}`;
    const pendingNote =
      `❌ The trip ${route} you requested to join was cancelled by the host.${reasonText}`;

    // trip_id is NULL on purpose: the trip is about to be deleted,
    // and ON DELETE CASCADE would otherwise delete these notifications too.
    const notified = await client.query(
      `INSERT INTO notifications (user_id, trip_id, message)
       SELECT requester_id,
              NULL,
              CASE WHEN status = 'Accepted' THEN $2 ELSE $3 END
       FROM trip_requests
       WHERE trip_id = $1
         AND status IN ('Accepted', 'Pending')`,
      [id, memberNote, pendingNote]
    );

    // Removes the trip; its requests and chat messages are removed by CASCADE.
    await client.query('DELETE FROM trips WHERE id = $1', [id]);

    await client.query('COMMIT');
    res.json({ ok: true, id: String(id), notified: notified.rowCount });
  } catch (e) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    next(e);
  } finally {
    if (client) client.release();
  }
});


function validateTrip(b) {
  const text = (key, max, required = false) => (b[key] == null && !required) || (typeof b[key] === 'string' && b[key].trim().length <= max && (!required || b[key].trim().length > 0));
  if (!text('origin',160,true) || !text('destination',100,true)) return 'Origin and destination are required and must fit the character limits.';
  if (!text('route',180) || !text('modeOther',80) || !text('notes',900)) return 'One or more trip text fields exceed their character limit.';
  if (!['Car','Train','Bus','Bike','Other'].includes(b.mode)) return 'Choose a valid transport mode.';
  if (b.mode === 'Other' && !text('modeOther',80,true)) return 'Specify the other transport mode (up to 80 characters).';
  if (!Number.isInteger(Number(b.seats)) || Number(b.seats)<1 || Number(b.seats)>8) return 'Seats must be between 1 and 8.';
  if (!Number.isInteger(Number(b.cost ?? 0)) || Number(b.cost ?? 0)<0 || Number(b.cost ?? 0)>100000) return 'Cost must be between 0 and 100000.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date || '') || !Number.isFinite(Date.parse(`${b.date}T00:00:00Z`))) return 'Enter a valid departure date.';
  const date = new Date(`${b.date}T00:00:00Z`);
  if (date.toISOString().slice(0,10)!==b.date) return 'Enter a valid departure date.';
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).map(p=>[p.type,p.value]));
  const today=`${parts.year}-${parts.month}-${parts.day}`;
  const limit=new Date(Date.UTC(Number(parts.year)+1,Number(parts.month)-1,Number(parts.day))).toISOString().slice(0,10);
  if (b.date < today || b.date > limit) return 'Departure date must be today or within one year.';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(b.time || '')) return 'Enter a valid time in HH:MM format.';
  return null;
}
app.post('/api/trips', requireSession, async (req, res, next) => {
  const invalid = validateTrip(req.body || {}); if (invalid) return error(res,400,invalid);
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('trip-user:' || $1::text))",[req.user.id]);
    const count = await client.query("SELECT count(*)::int AS n FROM trips WHERE organizer_id=$1 AND created_at>now()-interval '24 hours'", [req.user.id]);
    if (count.rows[0].n >= 10) { await client.query('ROLLBACK'); return error(res,429,'You can publish up to 10 trips every 24 hours.'); }
    const b=req.body;
    const result=await client.query(`INSERT INTO trips(organizer_id,origin,destination,route,mode,mode_other,trip_date,trip_time,seats_total,cost,notes)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`, [req.user.id,b.origin.trim(),b.destination.trim(),(b.route||'').trim(),b.mode,(b.modeOther||'').trim(),b.date,b.time,Number(b.seats),Number(b.cost||0),(b.notes||'').trim()]);
    await client.query('COMMIT');
    res.status(201).json({ id:String(result.rows[0].id) });
  } catch(e){try{await client.query('ROLLBACK')}catch{}next(e);}finally{client.release();}
});
app.post('/api/trips/:id/requests', requireSession, async (req,res,next)=>{
  const id=Number(req.params.id), message=typeof req.body?.message==='string'?req.body.message.trim():'';
  if(!Number.isSafeInteger(id)||id<1)return error(res,404,'Trip not found.');
  if(message.length>500)return error(res,400,'Request message must be 500 characters or fewer.');
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('request-user:' || $1::text))",[req.user.id]);
    const trip=await client.query('SELECT organizer_id,seats_total FROM trips WHERE id=$1',[id]);
    if(!trip.rowCount){await client.query('ROLLBACK');return error(res,404,'Trip not found.');}
    if(String(trip.rows[0].organizer_id)===String(req.user.id)){await client.query('ROLLBACK');return error(res,403,'You cannot request to join your own trip.');}
    const count=await client.query("SELECT count(*)::int n FROM trip_requests WHERE requester_id=$1 AND created_at>now()-interval '24 hours'",[req.user.id]);
    if(count.rows[0].n>=30){await client.query('ROLLBACK');return error(res,429,'You can send up to 30 join requests every 24 hours.');}
    const result=await client.query(`INSERT INTO trip_requests(trip_id,requester_id,message) SELECT $1,$2,$3 WHERE (SELECT t.seats_total - count(r.id) FILTER (WHERE r.status='Accepted') FROM trips t LEFT JOIN trip_requests r ON r.trip_id=t.id WHERE t.id=$1 GROUP BY t.seats_total) > 0 ON CONFLICT(trip_id,requester_id) DO NOTHING RETURNING id`,[id,req.user.id,message]);
    if(!result.rowCount){const existing=await client.query('SELECT 1 FROM trip_requests WHERE trip_id=$1 AND requester_id=$2',[id,req.user.id]);await client.query('ROLLBACK');return error(res,409,existing.rowCount?'You have already requested this trip.':'This trip has no seats left.');}
    await client.query('COMMIT');
    res.status(201).json({ok:true});
  }catch(e){try{await client.query('ROLLBACK')}catch{}if(e.code==='23505')return error(res,409,'You have already requested this trip.');next(e);}finally{client.release();}
});
app.patch('/api/requests/:id', requireSession, async(req,res,next)=>{
  const id=Number(req.params.id), status=req.body?.status;
  if(!Number.isSafeInteger(id)||id<1)return error(res,404,'Request not found.');
  if(!['Pending','Accepted','Declined'].includes(status))return error(res,400,'Status must be Pending, Accepted, or Declined.');
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const found=await client.query('SELECT r.trip_id,r.status,t.organizer_id FROM trip_requests r JOIN trips t ON t.id=r.trip_id WHERE r.id=$1',[id]);
    if(!found.rowCount){await client.query('ROLLBACK');return error(res,404,'Request not found.');}
    const request=found.rows[0];
    if(String(request.organizer_id)!==String(req.user.id)){await client.query('ROLLBACK');return error(res,403,'Only the trip organizer can change request status.');}
    if(status==='Accepted'&&request.status!=='Accepted'){
      await client.query('SELECT id FROM trips WHERE id=$1 FOR UPDATE',[request.trip_id]);
      const seats=await client.query("SELECT t.seats_total - count(r.id) FILTER (WHERE r.status='Accepted')::int AS remaining FROM trips t LEFT JOIN trip_requests r ON r.trip_id=t.id WHERE t.id=$1 GROUP BY t.id",[request.trip_id]);
      if(!seats.rowCount||Number(seats.rows[0].remaining)<1){await client.query('ROLLBACK');return error(res,409,'No seats remaining on this trip.');}
    }
    await client.query('UPDATE trip_requests SET status=$2 WHERE id=$1',[id,status]);
    await client.query('COMMIT');res.json({ok:true});
  }catch(e){try{await client.query('ROLLBACK')}catch{}next(e)}finally{client.release()}
});

// openrouteservice proxy: the API key stays on the server and browsers never call HeiGIT directly.
const ORS_UPSTREAM = 'https://api.heigit.org';
const ORS_ALLOWED = /^\/(pelias\/v1\/(search|autocomplete|reverse)|openrouteservice\/v2\/directions\/(driving-car|cycling-regular)\/geojson)$/;
const orsUsage = new Map();
app.use('/ors', requireSession, async (req, res) => {
  try {
    const key = String(process.env.ORS_API_KEY || '').trim();
    if (!key) return error(res, 503, 'Maps are not configured yet. Add ORS_API_KEY to .env and restart the server.');
    if (!['GET', 'POST'].includes(req.method) || !ORS_ALLOWED.test(req.path)) return error(res, 404, 'Not found.');
    const now = Date.now();
    const usage = orsUsage.get(req.user.id);
    if (!usage || now - usage.start > 60000) orsUsage.set(req.user.id, { start: now, count: 1 });
    else if (++usage.count > 120) return error(res, 429, 'Too many map requests. Wait a minute and try again.', { retryAfter: Math.ceil((usage.start + 60000 - now) / 1000) });
    const target = new URL(req.url, ORS_UPSTREAM);
    const isPost = req.method === 'POST';
    const upstream = await fetch(target, {
      method: req.method,
      headers: {
  Authorization: key,
  Accept: req.path.endsWith('/geojson')
    ? 'application/geo+json'
    : 'application/json',
  ...(isPost ? { 'Content-Type': 'application/json' } : {})
},
      body: isPost ? JSON.stringify(req.body || {}) : undefined,
      signal: AbortSignal.timeout(15000)
    });
    if (upstream.status === 401 || upstream.status === 403) return error(res, 502, 'The map service rejected the server API key. Check ORS_API_KEY in .env.');
    res.status(upstream.status).type('application/json').send(await upstream.text());
  } catch (e) { return error(res, 502, 'Could not reach the map service. Try again in a moment.'); }
});




function canAccessTripChat(tripId, userId) {
  return pool.query(
    `SELECT 1
     FROM trips t
     WHERE t.id = $1
       AND (
         t.organizer_id = $2
         OR EXISTS (
           SELECT 1
           FROM trip_requests tr
           WHERE tr.trip_id = t.id
             AND tr.requester_id = $2
             AND tr.status = 'Accepted'
         )
       )
     LIMIT 1`,
    [tripId, userId]
  );
}

app.get('/api/trips/:id/messages', requireSession, async (req, res, next) => {
  const tripId = Number(req.params.id);

  if (!Number.isSafeInteger(tripId) || tripId < 1) {
    return error(res, 400, 'Invalid trip ID.');
  }

  try {
    const access = await canAccessTripChat(tripId, req.user.id);

    if (!access.rowCount) {
      return error(res, 403, 'Only the trip organizer and accepted members can access this chat.');
    }

        const result = await pool.query(
      `SELECT * FROM (
         SELECT tm.id, tm.trip_id, tm.sender_id, tm.message, tm.created_at,
                u.name AS sender_name,
                (tm.sender_id = $2) AS mine
         FROM trip_messages tm
         JOIN users u ON u.id = tm.sender_id
         WHERE tm.trip_id = $1
         ORDER BY tm.created_at DESC, tm.id DESC
         LIMIT 200
       ) latest
       ORDER BY created_at ASC, id ASC`,
      [tripId, req.user.id]
    );

        const rows = result.rows;

    // Remember the newest message this person has now seen
    if (rows.length) {
      await pool.query(
        `INSERT INTO chat_reads (trip_id, user_id, last_read_message_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (trip_id, user_id)
         DO UPDATE SET last_read_message_id =
           GREATEST(chat_reads.last_read_message_id, EXCLUDED.last_read_message_id)`,
        [tripId, req.user.id, rows[rows.length - 1].id]
      );
    }

    return res.json(rows);
  } catch (e) {
    next(e);
  }
});

app.post('/api/trips/:id/messages', requireSession, async (req, res, next) => {
  const tripId = Number(req.params.id);
  const message = typeof req.body?.message === 'string'
    ? req.body.message.trim()
    : '';

  if (!Number.isSafeInteger(tripId) || tripId < 1) {
    return error(res, 400, 'Invalid trip ID.');
  }

  if (!message || message.length > 2000) {
    return error(res, 400, 'Message must contain 1–2000 characters.');
  }

  try {
    const access = await canAccessTripChat(tripId, req.user.id);

    if (!access.rowCount) {
      return error(res, 403, 'Only the trip organizer and accepted members can send messages.');
    }

    const result = await pool.query(
      `INSERT INTO trip_messages (trip_id, sender_id, message)
       VALUES ($1, $2, $3)
       RETURNING id, trip_id, sender_id, message, created_at`,
      [tripId, req.user.id, message]
    );

    return res.status(201).json(result.rows[0]);
  } catch (e) {
    next(e);
  }
});



// ===== Leave a trip / cancel a join request =====
app.post('/api/trips/:id/leave', requireSession, async (req, res, next) => {
  const tripId = Number(req.params.id);
  const reason = typeof req.body?.reason === 'string'
    ? req.body.reason.trim().slice(0, 300)
    : '';

  if (!Number.isSafeInteger(tripId) || tripId < 1) {
    return error(res, 400, 'Invalid trip ID.');
  }

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const fail = async (code, msg) => {
      await client.query('ROLLBACK');
      return error(res, code, msg);
    };

    const tripResult = await client.query(
      `SELECT id, organizer_id, origin, destination,
              to_char(trip_date, 'DD Mon YYYY') AS date,
              trip_date < (now() AT TIME ZONE 'Asia/Kolkata')::date AS is_past
       FROM trips
       WHERE id = $1
       FOR UPDATE`,
      [tripId]
    );

    if (!tripResult.rowCount) return fail(404, 'Trip not found.');
    const trip = tripResult.rows[0];

    if (String(trip.organizer_id) === String(req.user.id)) {
      return fail(400, 'Hosts cannot leave their own trip. Delete the trip instead.');
    }
    if (trip.is_past) {
      return fail(400, 'This trip has already taken place.');
    }

    const removed = await client.query(
      `DELETE FROM trip_requests
       WHERE trip_id = $1
         AND requester_id = $2
         AND status IN ('Pending', 'Accepted')
       RETURNING status`,
      [tripId, req.user.id]
    );

    if (!removed.rowCount) {
      return fail(404, 'You have no active request or membership for this trip.');
    }

    const wasAccepted = removed.rows[0].status === 'Accepted';

    const userResult = await client.query('SELECT name FROM users WHERE id = $1', [req.user.id]);
    const name = userResult.rows[0]?.name || 'A member';
    const route = `${trip.origin} → ${trip.destination} (${trip.date})`;

    let note = wasAccepted
      ? `${name} has left your trip ${route}. One seat is free again.`
      : `${name} cancelled their join request for ${route}.`;
    if (reason) note += ` Reason: "${reason}"`;

    // Notify the host
    await client.query(
      `INSERT INTO notifications (user_id, trip_id, message) VALUES ($1, $2, $3)`,
      [trip.organizer_id, tripId, note]
    );

    // Let the rest of the group know in the trip chat
    if (wasAccepted) {
      await client.query(
        `INSERT INTO trip_messages (trip_id, sender_id, message) VALUES ($1, $2, $3)`,
        [tripId, req.user.id, `🚪 ${name} has left the trip.${reason ? ` Reason: ${reason}` : ''}`]
      );
    }

    await client.query('COMMIT');
    return res.json({ ok: true, wasAccepted });
  } catch (e) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    next(e);
  } finally {
    if (client) client.release();
  }
});

// ===== Notifications =====
app.get('/api/notifications', requireSession, async (req, res, next) => {
  try {
    const items = await pool.query(
      `SELECT id::text, trip_id::text AS "tripId", message,
              is_read AS "isRead", created_at AS "createdAt"
       FROM notifications
       WHERE user_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT 30`,
      [req.user.id]
    );
    const unread = await pool.query(
      `SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND NOT is_read`,
      [req.user.id]
    );
    res.json({ unread: unread.rows[0].n, items: items.rows });
  } catch (e) {
    next(e);
  }
});

app.post('/api/notifications/read', requireSession, async (req, res, next) => {
  try {
    await pool.query(
      `UPDATE notifications SET is_read = true WHERE user_id = $1 AND NOT is_read`,
      [req.user.id]
    );
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// ===== Which trip chats have unread messages =====
app.get('/api/chats/unread', requireSession, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT t.id::text AS trip_id
       FROM trips t
       WHERE (
           t.organizer_id = $1
           OR EXISTS (
             SELECT 1 FROM trip_requests tr
             WHERE tr.trip_id = t.id
               AND tr.requester_id = $1
               AND tr.status = 'Accepted'
           )
         )
         AND EXISTS (
           SELECT 1 FROM trip_messages m
           WHERE m.trip_id = t.id
             AND m.sender_id <> $1
             AND m.id > COALESCE((
               SELECT r.last_read_message_id
               FROM chat_reads r
               WHERE r.trip_id = t.id AND r.user_id = $1
             ), 0)
         )`,
      [req.user.id]
    );

    res.json({ tripIds: result.rows.map((r) => r.trip_id) });
  } catch (e) {
    next(e);
  }
});


// ===== Delete notifications =====
// Delete one notification (only if it belongs to the signed-in user)
app.delete('/api/notifications/:id', requireSession, async (req, res, next) => {
  const id = Number(req.params.id);

  if (!Number.isSafeInteger(id) || id < 1) {
    return error(res, 400, 'Invalid notification ID.');
  }

  try {
    const result = await pool.query(
      'DELETE FROM notifications WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );

    if (!result.rowCount) {
      return error(res, 404, 'Notification not found.');
    }

    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// Delete all of the signed-in user's notifications
app.delete('/api/notifications', requireSession, async (req, res, next) => {
  try {
    const result = await pool.query(
      'DELETE FROM notifications WHERE user_id = $1',
      [req.user.id]
    );
    res.json({ ok: true, deleted: result.rowCount });
  } catch (e) {
    next(e);
  }
});


app.use((req,res)=>req.path.startsWith('/api/')||req.path.startsWith('/auth/')||req.path.startsWith('/ors/')?error(res,404,'Not found.'):res.sendStatus(404));
app.use((err,req,res,next)=>{
  if(res.headersSent)return next(err);
  if(err.type==='entity.too.large')return error(res,413,'Request body must be 20 KB or smaller.');
  if(err instanceof SyntaxError && err.status===400)return error(res,400,'Request body must contain valid JSON.');
  console.error('Request failed:', err.code || err.name || 'Error');
  return error(res,500,'Something went wrong. Please try again.');
});

async function start() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required. Copy .env.example to .env and add your database URL.');
  if (!googleClientId()) console.warn('GOOGLE_CLIENT_ID is not set in .env, so nobody can sign in yet.');
  const schema=fs.readFileSync(path.join(__dirname,'schema.sql'),'utf8');
  await pool.query(schema);
  const port=Number(process.env.PORT)||3000;
  return app.listen(port,()=>console.log(`TravelleR is ready at http://localhost:${port}`));
}
if(require.main===module)start().catch(err=>{console.error(err.message);process.exitCode=1});
module.exports={app,pool,start,normalizeEmail,validateTrip,googleAuth};
