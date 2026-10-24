'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

test('TravelleR Google sign-in, privacy, trips, requests, seat limits, and static-file protections', { skip: !process.env.DATABASE_URL_TEST }, async t => {
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
  process.env.GOOGLE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
  delete process.env.GOOGLE_REQUIRE_HOSTED_DOMAIN;
  process.env.NODE_ENV = 'test';
  const { app, pool, googleAuth } = require('../server');
  await pool.query("TRUNCATE trip_requests,trips,sessions,users RESTART IDENTITY CASCADE");
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await pool.end(); });

  async function call(path, { method = 'GET', body, cookie } = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (cookie) headers.Cookie = cookie;
    const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.text();
    return { response, data };
  }
  // Stand-in for Google's token check: the "credential" is just base64url JSON describing the account.
  googleAuth.verify = async credential => {
    try { return JSON.parse(Buffer.from(credential, 'base64url').toString('utf8')); }
    catch { throw new Error('invalid token'); }
  };
  const fakeCredential = (claims) => Buffer.from(JSON.stringify(claims)).toString('base64url');
  async function googleLogin(email, extra = {}) {
    const claims = { email, emailVerified: true, hostedDomain: String(email).split('@')[1], name: 'Test Student', ...extra };
    return call('/auth/google', { method: 'POST', body: { credential: fakeCredential(claims) } });
  }
  async function signIn(email) {
    const result = await googleLogin(email);
    assert.equal(result.response.status, 200);
    return { cookie: result.response.headers.get('set-cookie').split(';')[0], needsProfile: result.data.needsProfile };
  }
  async function profile(cookie, name) {
    const result = await call('/auth/profile', { method: 'POST', cookie, body: { name, department: 'Computer Science · 3rd year' } });
    assert.equal(result.response.status, 200);
  }
  function futureDate(days = 2) {
    const pieces = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map(p => [p.type, p.value]));
    const d = new Date(Date.UTC(Number(pieces.year), Number(pieces.month) - 1, Number(pieces.day) + days));
    return d.toISOString().slice(0, 10);
  }
  async function postTrip(cookie, seats = 1) {
    return call('/api/trips', { method: 'POST', cookie, body: { origin: 'IIT Roorkee main gate', destination: 'Rishikesh', route: '', mode: 'Car', modeOther: '', date: futureDate(), time: '07:30', seats, cost: 250, notes: '' } });
  }

  await t.test('rejects non-IITR accounts, lookalike domains, unverified emails and bad tokens', async () => {
    for (const email of ['student@gmail.com', 'x@evil-iitr.ac.in', 'x@iitr.ac.in.evil.com']) {
      const result = await googleLogin(email);
      assert.equal(result.response.status, 403);
      assert.ok(result.data.error);
    }
    assert.equal((await googleLogin('a@iitr.ac.in', { emailVerified: false })).response.status, 403);
    assert.equal((await googleLogin('a@iitr.ac.in', { hostedDomain: undefined })).response.status, 403);
    assert.equal((await googleLogin('a@iitr.ac.in', { hostedDomain: 'gmail.com' })).response.status, 403);
    const bad = await call('/auth/google', { method: 'POST', body: { credential: 'not-a-real-token' } });
    assert.equal(bad.response.status, 401);
    const missing = await call('/auth/google', { method: 'POST', body: {} });
    assert.equal(missing.response.status, 400);
  });

  await t.test('valid IITR Google account creates a session and new user must complete profile', async () => {
    const loggedIn = await signIn('First.Student+trip@CS.iitr.ac.in');
    assert.equal(loggedIn.needsProfile, true);
    const gated = await call('/api/me', { cookie: loggedIn.cookie });
    assert.equal(gated.response.status, 401);
    await profile(loggedIn.cookie, 'First Student');
    const me = await call('/api/me', { cookie: loggedIn.cookie });
    assert.equal(me.response.status, 200);
    assert.equal(me.data.name, 'First Student');
    assert.equal(JSON.stringify(me.data).includes('@'), false);
    t.organizer = loggedIn.cookie;
  });

  await t.test('two students post trips, request to join, and organizer controls acceptance and remaining seats', async () => {
    const second = await signIn('second@iitr.ac.in');
    assert.equal(second.needsProfile, true);
    await profile(second.cookie, 'Second Student');
    const third = await signIn('third@iitr.ac.in');
    assert.equal(third.needsProfile, true);
    await profile(third.cookie, 'Third Student');

    const trip = await postTrip(t.organizer, 1);
    assert.equal(trip.response.status, 201);
    const secondTrip = await postTrip(second.cookie, 2);
    assert.equal(secondTrip.response.status, 201);
    assert.equal(typeof trip.data.id, 'string');
    const tripId = trip.data.id;
    assert.equal((await call('/api/trips', { cookie: second.cookie })).response.status, 200);
    const unauthenticated = await call('/api/trips');
    assert.equal(unauthenticated.response.status, 401);

    assert.equal((await call(`/api/trips/${tripId}/requests`, { method: 'POST', cookie: second.cookie, body: { message: 'Happy to join.' } })).response.status, 201);
    const listForOrganizer = await call('/api/trips', { cookie: t.organizer });
    const owned = listForOrganizer.data.find(x => x.id === tripId);
    assert.equal(owned.requests.length, 1);
    const requestId = owned.requests[0].id;
    const listForOther = await call('/api/trips', { cookie: third.cookie });
    const privateTrip = listForOther.data.find(x => x.id === tripId);
    assert.deepEqual(privateTrip.requests, []);
    assert.equal(JSON.stringify(listForOther.data).includes('@'), false);

    const duplicate = await call(`/api/trips/${tripId}/requests`, { method: 'POST', cookie: second.cookie, body: { message: 'Again' } });
    assert.equal(duplicate.response.status, 409);
    const thirdRequest = await call(`/api/trips/${tripId}/requests`, { method: 'POST', cookie: third.cookie, body: { message: 'Can I come?' } });
    assert.equal(thirdRequest.response.status, 201);
    const updated = await call('/api/trips', { cookie: t.organizer });
    const requests = updated.data.find(x => x.id === tripId).requests;
    const thirdRequestId = requests.find(x => x.name === 'Third Student').id;
    assert.equal((await call(`/api/requests/${requestId}`, { method: 'PATCH', cookie: third.cookie, body: { status: 'Accepted' } })).response.status, 403);
    assert.equal((await call(`/api/requests/${requestId}`, { method: 'PATCH', cookie: t.organizer, body: { status: 'Accepted' } })).response.status, 200);
    const afterAccept = await call('/api/trips', { cookie: t.organizer });
    assert.equal(afterAccept.data.find(x => x.id === tripId).seats, 0);
    const noSeat = await call(`/api/requests/${thirdRequestId}`, { method: 'PATCH', cookie: t.organizer, body: { status: 'Accepted' } });
    assert.equal(noSeat.response.status, 409);
    assert.equal(noSeat.data.error, 'No seats remaining on this trip.');
  });

  await t.test('path traversal and dotfiles are not served', async () => {
    assert.equal((await call('/.env')).response.status, 404);
    assert.equal((await call('/%2e%2e/server.js')).response.status, 404);
  });
});
