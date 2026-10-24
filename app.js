/* TravelleR front-end
 * Talks to the TravelleR server (see the API contract in API-CONTRACT.md).
 * Trips, join requests and the signed-in student all come from the server;
 * nothing important is stored in the browser any more.
 */
(() => {
  'use strict';

  const $ = (selector, parent = document) => parent.querySelector(selector);
  const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];
  // Set window.API_BASE (e.g. in a small inline script) only if the API lives on another origin.
  const API_BASE = String(window.API_BASE || '');
  let currentUser = null;

  // One place for every server call: JSON in/out, cookies sent, friendly errors, sign-in redirect on 401.
  async function api(path, { method = 'GET', body } = {}) {
    let response;
    try {
      response = await fetch(`${API_BASE}${path}`, {
        method,
        credentials: 'same-origin',
        headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined
      });
    } catch (networkError) {
      throw new Error('Could not reach the server. Check your connection and try again.');
    }
    if (response.status === 401) {
      window.location.href = `${API_BASE}/auth/login`;
      const signInError = new Error('Please sign in to continue.');
      signInError.silent = true;
      throw signInError;
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
    return data;
  }
  function reportError(error) {
    if (error && error.silent) return;
    toast(error && error.message ? error.message : 'Something went wrong. Please try again.');
  }
  function setBusy(button, busy) {
    if (!button) return;
    button.disabled = busy;
    button.setAttribute('aria-busy', busy ? 'true' : 'false');
  }

  const plusDays = (days) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  let trips = [];
  let refreshSeq = 0;

  // The server is the source of truth. This makes the data safe to use in the page
  // (string ids, plain 'YYYY-MM-DD' / 'HH:MM' values, numbers as numbers).
  function normalizeTrip(raw) {
    return {
      ...raw,
      id: String(raw.id),
      date: String(raw.date || '').slice(0, 10),
      time: String(raw.time || '').slice(0, 5),
      seats: Math.max(0, Number(raw.seats) || 0),
      cost: Number(raw.cost) || 0,
      mine: Boolean(raw.mine),
      requested: Boolean(raw.requested),
      verified: raw.verified !== false,
      requests: Array.isArray(raw.requests) ? raw.requests.map((request) => ({ ...request, id: String(request.id) })) : []
    };
  }

  async function refreshTrips() {
    const seq = ++refreshSeq;
    const data = await api('/api/trips');
    if (seq !== refreshSeq) return; // a newer refresh is already on its way
    const list = Array.isArray(data) ? data : (data.trips || []);
    trips = list.map(normalizeTrip).filter((trip) => trip.id && trip.destination && trip.origin);
    renderTrips();
    renderRequests();
    updateRequestCounts();
  }

  let activeTripId = null;
  let quickDestination = '';
  let toastTimer = null;
  let lastModalTrigger = null;

  // Small, safe utility helpers.
  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  }
  function formatDate(value) {
    if (!value) return 'Date flexible';
    const date = new Date(`${value}T12:00:00`);
    if (Number.isNaN(date.getTime())) return escapeHtml(value);
    return date.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
  }
  function formatTime(value) {
    if (!value) return 'Time TBD';
    const [hours, minutes] = value.split(':').map(Number);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return escapeHtml(value);
    return `${hours % 12 || 12}:${String(minutes).padStart(2, '0')} ${hours >= 12 ? 'PM' : 'AM'}`;
  }
  function currentTrip(id = activeTripId) { return trips.find((trip) => trip.id === id); }
  function toast(message) {
    const element = $('#toast');
    element.textContent = message;
    element.classList.add('is-visible');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => element.classList.remove('is-visible'), 3200);
  }
  function modeIcon(mode) {
    return ({ Car: '↗', Train: '▰', Bus: '▤', Bike: '⌁', Other: '⇢' })[mode] || '↗';
  }
  function displayMode(trip) {
    return trip.mode === 'Other' && trip.modeOther ? `Other — ${trip.modeOther}` : trip.mode;
  }

  function navigate(screenName) {
    const valid = ['explore', 'post', 'requests', 'detail', 'my-trips', 'about'];
    if (!valid.includes(screenName)) screenName = 'explore';
    $$('.screen').forEach((screen) => screen.classList.toggle('is-active', screen.id === `screen-${screenName}`));
    $$('[data-nav]').forEach((button) => {
      button.classList.toggle('is-active', button.dataset.nav === screenName && button.matches('.nav-link, .mobile-nav-link'));
      if (button.matches('a[data-nav]')) button.setAttribute('aria-current', button.dataset.nav === screenName ? 'page' : 'false');
    });
    if (screenName === 'explore') renderTrips();
    if (screenName === 'requests') renderRequests();
    if (screenName === 'my-trips') { renderMyTrips(); openNotifications(); }
    if (screenName === 'about') renderAbout();
    if (currentUser && (screenName === 'explore' || screenName === 'requests')) refreshTrips().catch(reportError);
    updateRequestCounts();
    window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }

  function renderTripCard(trip) {
    const isSent = trip.requested;
    const full = trip.seats <= 0;
    let pillClass = 'status-pill';
    let pillText = trip.mine ? 'Your trip' : (trip.verified ? '✓ Student verified' : 'Community trip');
    if (full) { pillClass += ' is-full'; pillText = 'Fully booked'; }
    else if (trip.mine) pillClass += ' is-mine';
    const description = trip.notes ? `<p class="trip-description">${escapeHtml(trip.notes.length > 140 ? `${trip.notes.slice(0, 137)}…` : trip.notes)}</p>` : '';
    const seatsLabel = full ? 'No seats left' : `${trip.seats} seat${trip.seats === 1 ? '' : 's'} left`;
    const actionText = trip.mine ? 'Manage trip ↗' : (isSent ? 'Request sent ✓' : 'View trip ↗');
    return `
      <article class="trip-card">
        <div class="trip-top"><div><h3 class="trip-destination">${escapeHtml(trip.destination)}</h3><div class="trip-origin">Leaving from ${escapeHtml(trip.origin)}</div></div><span class="${pillClass}">${pillText}</span></div>
        <div class="trip-route-strip"><div class="route-endpoint"><span class="route-dot"></span><span class="route-label" title="${escapeHtml(trip.origin)}">${escapeHtml(trip.origin)}</span></div><span class="route-dash" aria-hidden="true"></span><div class="route-endpoint"><span class="route-dot destination"></span><span class="route-label" title="${escapeHtml(trip.destination)}">${escapeHtml(trip.destination)}</span></div></div>
        <div class="trip-meta"><span><span class="meta-symbol" aria-hidden="true">◷</span>${formatDate(trip.date)} · ${formatTime(trip.time)}</span><span><span class="meta-symbol" aria-hidden="true">${modeIcon(trip.mode)}</span>${escapeHtml(displayMode(trip))}</span><span><span class="meta-symbol" aria-hidden="true">♧</span>${seatsLabel}</span><span><span class="meta-symbol" aria-hidden="true">₹</span>${Number(trip.cost || 0).toLocaleString('en-IN')} est.</span></div>
        ${description}
        <div class="trip-footer"><div class="organizer"><span class="avatar">${escapeHtml(trip.initials || initialsFor(trip.organizer))}</span><span class="organizer-copy"><b>${escapeHtml(trip.organizer)}${trip.verified ? '<span class="organizer-check" title="Verified student">✓</span>' : ''}</b><small>${trip.mine ? 'Your published trip' : escapeHtml(trip.department || 'Student traveller')}</small></span></div><button type="button" class="button button-primary trip-action" data-action="detail" data-trip-id="${escapeHtml(trip.id)}">${actionText}</button></div>
      </article>`;
  }

  function initialsFor(name) {
    return String(name || '?').trim().split(/\s+/).slice(0, 2).map((part) => part[0] || '').join('').toUpperCase() || '?';
  }

  function renderTrips() {
    const search = ($('#filter-destination').value || '').trim().toLocaleLowerCase();
    const date = $('#filter-date').value;
    const mode = $('#filter-mode').value;
    const visible = trips.filter((trip) => {
      const searchText = [trip.destination, trip.origin, trip.route, trip.notes, trip.modeOther].join(' ').toLocaleLowerCase();
      return trip.status !== 'closed'
        && (!search || searchText.includes(search))
        && (!date || trip.date === date)
        && (!mode || trip.mode === mode)
        && (!quickDestination || trip.destination.toLocaleLowerCase().includes(quickDestination.toLocaleLowerCase()));
    }).sort((a, b) => `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`));

    $('#result-count').textContent = `${visible.length} trip${visible.length === 1 ? '' : 's'} to explore · Search destinations, starting points, or stops`;
    $('#trip-list').innerHTML = visible.length ? visible.map(renderTripCard).join('') : `
      <div class="empty-state"><div class="empty-illustration" aria-hidden="true">⌁</div><h3>No trips found just yet</h3><p>Try a different destination, date, route, or transport mode — or be the first to post your trip.</p><div class="empty-actions"><button class="button button-primary" data-action="navigate" data-screen="post">＋ Post a trip</button><button class="button button-outline" data-action="reset-filters">Clear filters</button></div></div>`;
    $$('[data-quick]').forEach((button) => button.classList.toggle('is-selected', button.dataset.quick === quickDestination));
  }

  function factsMarkup(trip) {
    const facts = [
      ['STARTING POINT', trip.origin], ['DESTINATION', trip.destination],
      ['DEPARTURE', `${formatDate(trip.date)} · ${formatTime(trip.time)}`], ['TRANSPORT', displayMode(trip)],
      ['PLANNED STOPS', trip.route || 'Direct route / to be confirmed'], ['ESTIMATED COST', `₹${Number(trip.cost || 0).toLocaleString('en-IN')} per person`],
      ['SEATS AVAILABLE', `${Math.max(0, Number(trip.seats) || 0)} remaining`], ['ORGANIZER', trip.organizer]
    ];
    return facts.map(([label, value]) => `<div class="detail-fact"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>`).join('');
  }

  function schematicMarkup(trip, className = 'detail-map') {
    // This is a decorative schematic only; it is deliberately not presented as a real map.
    const start = escapeHtml((trip.origin || 'Start').slice(0, 24));
    const end = escapeHtml((trip.destination || 'Destination').slice(0, 24));
    const stop = escapeHtml((trip.route || 'Planned route').slice(0, 24));
    return `<div class="${className}" role="img" aria-label="Illustrative route from ${start} to ${end}; not a live map">
      <svg viewBox="0 0 720 205" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><rect width="720" height="205" fill="#eaf0e5"/><path d="M-5 36 90 74 155 24 266 66 372 19 479 66 604 28 730 54M-5 157 105 119 215 183 326 128 441 175 560 120 730 165M60 -10 93 220M236 -10 254 220M432 -10 405 220M624 -10 600 220" fill="none" stroke="#fff" stroke-width="16"/><path d="M116 143 Q210 55 305 92 T493 99 T617 46" fill="none" stroke="#347a57" stroke-width="4" stroke-dasharray="8 7"/><circle cx="116" cy="143" r="9" fill="#176b50" stroke="#fff" stroke-width="4"/><circle cx="617" cy="46" r="9" fill="#ed9b66" stroke="#fff" stroke-width="4"/><g fill="#536c58" font-family="sans-serif" font-size="12" font-weight="700"><text x="80" y="169">${start}</text><text x="540" y="27">${end}</text><text x="306" y="81">${stop}</text></g></svg><span class="preview-badge">SCHEMATIC PREVIEW · NOT TO SCALE</span></div>`;
  }

  function renderDetail(tripId) {
    const trip = trips.find((item) => item.id === tripId);
    if (!trip) { navigate('explore'); toast('That trip is no longer available.'); return; }
    activeTripId = tripId;
    const wasSent = trip.requested;
    const isFull = trip.seats <= 0;
    const joinButtonText = wasSent ? '✓ Request sent' : isFull ? 'No seats available' : 'Request to join ↗';
    $('#detail-content').innerHTML = `
      <div class="detail-hero"><div class="detail-hero-top"><div><p class="eyebrow">${trip.verified ? '✓ STUDENT-ORGANIZED TRIP' : 'COMMUNITY TRIP'}</p><h1 id="detail-title">${escapeHtml(trip.destination)}<span class="period">.</span></h1></div><span class="status-pill ${trip.mine ? 'is-mine' : ''}">${trip.mine ? 'Your trip' : (trip.verified ? '✓ Student verified' : 'Student organizer')}</span></div><p class="detail-hero-copy">${escapeHtml(trip.notes || 'A student-organized trip. Contact the organizer to coordinate details and pickup arrangements.')}</p></div>
      <div class="detail-grid"><div class="detail-main">
        <section class="detail-card"><h2>Journey details</h2><div class="detail-facts">${factsMarkup(trip)}</div></section>
        <section class="detail-card"><h2>Route and possible stops</h2><div id="detail-route-map" class="form-map-preview detail-route-map ors-map" role="region" aria-label="openrouteservice route map"><div class="map-placeholder"><b>openrouteservice route preview</b><span>Add your openrouteservice API key to load the route map.</span></div></div><div class="map-tools"><span id="detail-map-status" class="field-help" aria-live="polite">Loading route and possible stops…</span></div><div id="detail-route-stops" class="route-stops" hidden></div><p class="field-help map-help">Stops are suggestions from openrouteservice search data, not endorsements. Check hours, current access, and actual detour before travelling. Route proximity is not a live traffic or opening-hours check. Train trips show locations only, not a rail route or timetable.</p></section>
      </div><aside class="detail-aside">
        <section class="detail-card"><h2>Trip organizer</h2><div class="detail-organizer"><span class="avatar">${escapeHtml(trip.initials || initialsFor(trip.organizer))}</span><span><b>${escapeHtml(trip.organizer)}${trip.verified ? '<span class="organizer-check" title="Verified student">✓</span>' : ''}</b><small>${escapeHtml(trip.department || 'Student traveller')}</small><small>${trip.verified ? 'Verified student' : 'Not verified'}</small></span></div><p class="detail-note">Personal contact details stay private here. Coordinate pickup, costs, and the meeting point with care before travelling.</p><div class="organizer-actions">${trip.mine ? `<button class="button button-outline" data-action="manage-requests">Review join requests (${trip.requests.filter((request) => request.status === 'Pending').length})</button><button class="button button-outline" data-action="maps" data-trip-id="${escapeHtml(trip.id)}">Show route map ↓</button>` : `<button class="button button-primary" data-action="join" data-trip-id="${escapeHtml(trip.id)}" ${wasSent || isFull ? 'disabled' : ''}>${joinButtonText}</button><button class="button button-outline" data-action="maps" data-trip-id="${escapeHtml(trip.id)}">Show route map ↓</button>`}</div></section>
        <section class="detail-card"><h2>Before you join</h2><p class="detail-safety">✓ Check who is organizing the trip.<br><br>✓ Agree on pickup details and cost ahead of time.<br><br>✓ Share your itinerary with someone you trust.<br><br>✓ Never share passwords or OTPs.</p></section>
      </aside></div>`;
    navigate('detail');
    if (window.TravellerMaps) {
      window.TravellerMaps.showRoute({
        mapId: 'detail-route-map',
        stopsId: 'detail-route-stops',
        statusId: 'detail-map-status',
        origin: trip.origin,
        destination: trip.destination,
        plannedStops: trip.route || '',
        mode: trip.mode || 'Car'
      });
    }
  }

  function openJoinModal(tripId, trigger) {
    const trip = trips.find((item) => item.id === tripId);
    if (!trip || trip.mine) { toast('You can only request to join another organizer’s trip.'); return; }
    if (trip.seats <= 0) { toast('Sorry, this trip has no seats available.'); return; }
    if (trip.requested) { toast('You have already requested to join this trip.'); return; }
    activeTripId = trip.id;
    lastModalTrigger = trigger || document.activeElement;
    $('#join-modal-description').textContent = `You’re requesting a seat on the trip to ${trip.destination} on ${formatDate(trip.date)}. Introduce yourself to ${trip.organizer}.`;
    $('#join-form').reset();
    fillJoinIdentity();
    $('#join-modal').hidden = false;
    document.body.style.overflow = 'hidden';
    $('#join-message').focus();
  }
  // Name and department come from the signed-in account, so the form shows them read-only.
  function fillJoinIdentity() {
    const nameInput = $('#join-name');
    const collegeInput = $('#join-college');
    if (nameInput) { nameInput.value = currentUser ? currentUser.name : ''; nameInput.readOnly = true; }
    if (collegeInput) { collegeInput.value = currentUser ? (currentUser.department || 'IIT Roorkee') : ''; collegeInput.readOnly = true; }
  }
  function closeJoinModal() {
    $('#join-modal').hidden = true;
    document.body.style.overflow = '';
    if (lastModalTrigger && typeof lastModalTrigger.focus === 'function') lastModalTrigger.focus();
  }

  function requestCardMarkup(trip, request) {
    const statusClass = request.status.toLowerCase();
    const actionButtons = request.status === 'Pending'
      ? `<div class="request-buttons"><button class="button button-primary" data-action="request-status" data-trip-id="${escapeHtml(trip.id)}" data-request-id="${escapeHtml(request.id)}" data-status="Accepted">✓ Accept request</button><button class="button button-danger" data-action="request-status" data-trip-id="${escapeHtml(trip.id)}" data-request-id="${escapeHtml(request.id)}" data-status="Declined">Decline</button></div>`
      : `<div class="request-buttons"><button class="button button-outline" data-action="request-status" data-trip-id="${escapeHtml(trip.id)}" data-request-id="${escapeHtml(request.id)}" data-status="Pending">Reopen request</button></div>`;
    return `<article class="request-card"><div class="request-top"><div class="request-person"><span class="avatar">${escapeHtml(request.initials || initialsFor(request.name))}</span><span><b>${escapeHtml(request.name)}</b><small>${escapeHtml(request.college || 'Student traveller')}</small></span></div><span class="request-status ${statusClass}">${escapeHtml(request.status)}</span></div><div class="request-tripline">Request for ${escapeHtml(trip.destination)} · ${formatDate(trip.date)} at ${formatTime(trip.time)}</div><p class="request-message">${escapeHtml(request.message || 'No message was added.')}</p>${actionButtons}</article>`;
  }

  
function renderMyTrips() {
  const hostedTrips = trips.filter((trip) => trip.mine);
  const requestedTrips = trips.filter(
    (trip) => !trip.mine && trip.requested
  );

  const hostedList = $('#my-hosted-trips');
  const requestedList = $('#my-requested-trips');

  if (!hostedList || !requestedList) return;

  hostedList.innerHTML = hostedTrips.length
    ? hostedTrips.map((trip) => myTripCardMarkup(trip, true)).join('')
    : '<p class="empty-state">You have not posted any upcoming trips.</p>';

  requestedList.innerHTML = requestedTrips.length
    ? requestedTrips.map((trip) => myTripCardMarkup(trip, false)).join('')
    : '<p class="empty-state">You have not requested to join any upcoming trips.</p>';
}

function myTripCardMarkup(trip, isHost) {
  const members = Array.isArray(trip.members) ? trip.members : [];
  const requests = Array.isArray(trip.requests) ? trip.requests : [];

  const status = isHost
    ? 'Hosting'
    : (trip.myRequestStatus || 'Pending');

  const memberMarkup = trip.isMember || isHost
    ? (members.length
        ? `<div class="my-trip-members">
            <h3>Accepted members (${members.length})</h3>
            ${members.map((member) => `
              <div class="my-trip-member">
                <strong>${escapeHtml(member.name || 'Member')}</strong>
                <div>${escapeHtml(member.email || 'Email unavailable')}</div>
                <div>${escapeHtml(member.department || '')}</div>
              </div>
            `).join('')}
          </div>`
        : '<p class="empty-state">No accepted members yet.</p>')
    : '';

  const pendingMarkup = isHost
    ? requests.filter((request) => request.status === 'Pending').length
      ? `<div class="my-trip-pending">
          <h3>Pending requests</h3>
          ${requests
            .filter((request) => request.status === 'Pending')
            .map((request) => `
              <div class="my-trip-member">
                <strong>${escapeHtml(request.name || 'Requester')}</strong>
                <div>${escapeHtml(request.college || '')}</div>
                <div>${escapeHtml(request.message || '')}</div>
                <span>Pending</span>
              </div>
            `).join('')}
          <button class="button button-primary"
            data-nav="requests" type="button">
            Manage requests
          </button>
        </div>`
      : '<p>No pending join requests.</p>'
    : '';

  const hostDetails = !isHost
    ? `<div class="my-trip-host">
        <h3>Trip host</h3>
        <strong>${escapeHtml(trip.organizer || 'Host')}</strong>
        <div>${escapeHtml(trip.organizerEmail || (
          trip.isMember ? 'Email unavailable' : 'Email available after acceptance'
        ))}</div>
      </div>`
    : '';

  return `
    
<article class="request-card my-trip-card">
  <div class="request-top my-trip-header">
    <div class="my-trip-route">
      <span class="my-trip-eyebrow">TRIP ROUTE</span>
      <h3>${escapeHtml(trip.origin)} <span class="route-arrow">→</span> ${escapeHtml(trip.destination)}</h3>
    </div>

    <div class="my-trip-actions">
      <span class="status-pill">${escapeHtml(status)}</span>
      ${(isHost || trip.isMember) ? `
        <button
          class="button chat-open-button"
          type="button"
          data-action="open-chat"
          data-trip-id="${escapeHtml(trip.id)}">
          💬 Chat
          ${!isHost && ['Accepted', 'Pending'].includes(trip.myRequestStatus) ? `
        <button
          class="button leave-trip-button"
          type="button"
          data-action="leave-trip"
          data-trip-id="${escapeHtml(trip.id)}">
          ${trip.myRequestStatus === 'Accepted' ? '🚪 Leave trip' : '✕ Cancel request'}
        </button>
      ` : ''}
        </button>
      ` : ''}
      ${isHost ? `
        <button
          class="button button-outline delete-trip-button"
          type="button"
          data-action="delete-trip"
          data-trip-id="${escapeHtml(trip.id)}">
          🗑 Delete Trip
        </button>
      ` : ''}
    </div>
  </div>

  <div class="trip-info-grid">
    <div class="trip-info-item">
      <span class="trip-info-label">📅 Departure</span>
      <span class="trip-info-value">${escapeHtml(trip.date || '')}</span>
      <span class="trip-info-subvalue">${escapeHtml(trip.time || '')}</span>
    </div>

    <div class="trip-info-item">
      <span class="trip-info-label">🚘 Transport</span>
      <span class="trip-info-value">${escapeHtml(trip.mode || '')}</span>
      ${trip.modeOther ? `<span class="trip-info-subvalue">${escapeHtml(trip.modeOther)}</span>` : ''}
    </div>

    <div class="trip-info-item">
      <span class="trip-info-label">💺 Available seats</span>
      <span class="trip-info-value">${Number(trip.seats) || 0}</span>
    </div>

    <div class="trip-info-item">
      <span class="trip-info-label">₹ Cost per person</span>
      <span class="trip-info-value">₹${Number(trip.cost) || 0}</span>
    </div>
  </div>

  <div class="trip-notes">
    <span class="trip-info-label">TRIP NOTES</span>
    ${escapeHtml(trip.notes || 'No additional trip notes.')}
  </div>

      ${hostDetails}
      ${memberMarkup}
      ${pendingMarkup}
    </article>
  `;
}
function renderRequests() {
    const all = [];
    trips.filter((trip) => trip.mine).forEach((trip) => (trip.requests || []).forEach((request) => all.push({ trip, request })));
    const pending = all.filter(({ request }) => request.status === 'Pending').length;
    $('#pending-label').textContent = `${pending} pending`;
    $('#requests-list').innerHTML = all.length ? all
      .sort((a, b) => String(b.request.createdAt || '').localeCompare(String(a.request.createdAt || '')))
      .map(({ trip, request }) => requestCardMarkup(trip, request)).join('') : `
        <div class="empty-state"><div class="empty-illustration" aria-hidden="true">✉</div><h3>No join requests yet</h3><p>When students request to join one of your published trips, their details will appear here. You decide who joins.</p><div class="empty-actions"><button class="button button-primary" data-action="navigate" data-screen="post">＋ Post a trip</button><button class="button button-outline" data-action="navigate" data-screen="explore">Explore trips</button></div></div>`;
    updateRequestCounts();
  }

  function updateRequestCounts() {
    const pending = trips.filter((trip) => trip.mine).reduce((count, trip) => count + (trip.requests || []).filter((request) => request.status === 'Pending').length, 0);
    const desktopCount = $('#nav-count');
    desktopCount.textContent = String(pending);
    desktopCount.hidden = pending === 0;
    const mobileCount = $('#mobile-nav-count');
    mobileCount.textContent = String(pending);
    mobileCount.hidden = pending === 0;
    $('#pending-label').textContent = `${pending} pending`;
  }

  function resetFilters() {
    $('#filter-destination').value = '';
    $('#filter-date').value = '';
    $('#filter-mode').value = '';
    quickDestination = '';
    renderTrips();
  }

  // Event delegation keeps dynamically rendered cards interactive.
  document.addEventListener('click', (event) => {
    const nav = event.target.closest('[data-nav]');
    if (nav) {
      event.preventDefault();
      navigate(nav.dataset.nav);
      return;
    }
    const scroll = event.target.closest('[data-scroll]');
    if (scroll) {
      const section = document.getElementById(scroll.dataset.scroll);
      if (section) section.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      return;
    }
    const quick = event.target.closest('[data-quick]');
    if (quick) { quickDestination = quick.dataset.quick; renderTrips(); return; }
    const action = event.target.closest('[data-action]');
    if (!action) return;
    const tripId = action.dataset.tripId;
    switch (action.dataset.action) {
      case 'navigate': navigate(action.dataset.screen); break;
      case 'detail': renderDetail(tripId); break;
      case 'reset-filters': resetFilters(); break;
      case 'join': openJoinModal(tripId, action); break;
      case 'manage-requests': navigate('requests'); break;
      case 'maps': {
        const trip = trips.find((item) => item.id === tripId);
        if (trip) { const map = $('#detail-route-map'); if (map) { map.scrollIntoView({ behavior: 'smooth', block: 'center' }); if (window.TravellerMaps) window.TravellerMaps.resizeMap('detail-route-map'); } }
        break;
      }
      case 'request-status': updateRequestStatus(tripId, action.dataset.requestId, action.dataset.status); break;
      case 'delete-trip': deleteTrip(tripId); break;
      case 'open-chat': openTripChat(tripId); break;
      case 'leave-trip': leaveTrip(tripId); break;
      default: break;
    }
  });

  const requestsInFlight = new Set();
  async function updateRequestStatus(tripId, requestId, nextStatus) {
    if (!['Pending', 'Accepted', 'Declined'].includes(nextStatus)) return;
    const trip = trips.find((item) => item.id === tripId);
    const request = trip && (trip.requests || []).find((item) => item.id === requestId);
    if (!trip || !request || request.status === nextStatus || requestsInFlight.has(requestId)) return;
    requestsInFlight.add(requestId);
    try {
      // The server checks you own the trip and that seats remain; it does the seat counting.
      await api(`/api/requests/${encodeURIComponent(requestId)}`, { method: 'PATCH', body: { status: nextStatus } });
      await refreshTrips();
      toast(nextStatus === 'Pending' ? 'Request reopened.' : `Request ${nextStatus.toLowerCase()}.`);
    } catch (error) {
      reportError(error);
      refreshTrips().catch(() => {}); // show the real state after a conflict (e.g. no seats left)
    } finally {
      requestsInFlight.delete(requestId);
    }
  }

  
async function deleteTrip(tripId) {
  const trip = trips.find((item) => String(item.id) === String(tripId));

  if (!trip || !trip.mine) {
    toast('Only the trip host can delete this trip.');
    return;
  }

  const memberCount = Array.isArray(trip.members) ? trip.members.length : 0;
  const route = `${trip.origin} → ${trip.destination}`;

  const confirmed = window.confirm(memberCount
    ? `Cancel the trip ${route}?\n\n${memberCount} accepted member${memberCount > 1 ? 's' : ''} will be notified with your reason.\nThis cannot be undone.`
    : `Delete the trip ${route}?\n\nThis will also remove its join requests.\nThis cannot be undone.`);
  if (!confirmed) return;

  let reason = '';
  if (memberCount) {
    while (!reason) {
      const answer = window.prompt(
        'Reason for cancelling (your members will see this, max 300 characters):',
        ''
      );
      if (answer === null) return; // clicked Cancel, so the trip is NOT deleted
      reason = answer.trim().slice(0, 300);
      if (!reason) window.alert('Please enter a reason so your members know what happened.');
    }
  } else {
    // Optional reason if there are only pending requests
    const answer = window.prompt('Optional: reason for cancelling (pending requesters will see this):', '');
    if (answer === null) return;
    reason = answer.trim().slice(0, 300);
  }

  try {
    const res = await fetch(`/api/trips/${encodeURIComponent(tripId)}`, {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason })
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      toast(data.error || 'Could not delete the trip. Please try again.');
      return;
    }

    toast(data.notified
      ? `Trip cancelled. ${data.notified} ${data.notified === 1 ? 'person was' : 'people were'} notified.`
      : 'Trip deleted successfully.');

    if (chatTripId === String(tripId)) closeTripChat();
    await refreshTrips();
    renderMyTrips();
  } catch {
    toast('Network error. Please try again.');
  }
}


// ================= Trip chat =================
let chatTripId = null;
let chatTimer = null;
let chatLastKey = null;

function openTripChat(tripId) {
  const trip = trips.find((t) => String(t.id) === String(tripId));
  if (!trip || !(trip.mine || trip.isMember)) {
    toast('Chat opens once your join request is accepted.');
    return;
  }

  closeTripChat();
  chatTripId = String(tripId);
  chatLastKey = null;

  const overlay = document.createElement('div');
  overlay.className = 'chat-backdrop';
  overlay.id = 'trip-chat';
  overlay.innerHTML = `
    <div class="chat-panel" role="dialog" aria-modal="true" aria-labelledby="chat-title">
      <header class="chat-header">
        <div class="chat-header-text">
          <span class="chat-eyebrow">TRIP CHAT</span>
          <h2 id="chat-title">${escapeHtml(trip.origin)} <span class="route-arrow">→</span> ${escapeHtml(trip.destination)}</h2>
          <p>${escapeHtml(trip.date || '')} · Visible only to the host and accepted members</p>
        </div>
        <button class="chat-close" type="button" aria-label="Close chat">✕</button>
      </header>

      <div class="chat-messages" id="chat-messages">
        <p class="chat-empty">Loading messages…</p>
      </div>

      <form class="chat-form" id="chat-form">
        <textarea id="chat-input" rows="1" maxlength="2000"
          placeholder="Type a message… (Enter to send, Shift+Enter for a new line)"></textarea>
        <button class="button button-primary chat-send" type="submit">Send</button>
      </form>
      <p class="chat-privacy">🔒 No need to share phone numbers — plan pickup and timings right here.</p>
    </div>`;

  document.body.appendChild(overlay);
  document.body.classList.add('chat-open');

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeTripChat();
  });
  overlay.querySelector('.chat-close').addEventListener('click', closeTripChat);

  const input = overlay.querySelector('#chat-input');
  overlay.querySelector('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    sendChatMessage();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  });
  input.focus();

  loadChatMessages();
  chatTimer = setInterval(loadChatMessages, 4000); // check for new messages every 4 seconds
}

function closeTripChat() {
  clearInterval(chatTimer);
  chatTimer = null;
  chatTripId = null;
  chatLastKey = null;
  document.getElementById('trip-chat')?.remove();
  document.body.classList.remove('chat-open');
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && chatTripId) closeTripChat();
});

async function loadChatMessages() {
  if (!chatTripId) return;
  const tripId = chatTripId;

  try {
    const res = await fetch(`/api/trips/${encodeURIComponent(tripId)}/messages`, {
      credentials: 'same-origin'
    });
    const data = await res.json().catch(() => ({}));

    if (tripId !== chatTripId) return; // chat was closed or switched meanwhile

    if (!res.ok) {
      if (res.status === 403 || res.status === 404) {
        closeTripChat();
        toast(data.error || 'You no longer have access to this chat.');
      }
      return;
    }

    renderChatMessages(Array.isArray(data) ? data : []);
  } catch {
    // Temporary network problem: the next refresh will try again.
  }
}

function renderChatMessages(messages) {
  const box = document.getElementById('chat-messages');
  if (!box) return;

  // Re-draw only when something changed, so the scroll position isn't disturbed.
  const key = `${messages.length}:${messages.length ? messages[messages.length - 1].id : ''}`;
  if (key === chatLastKey) return;
  const firstRender = chatLastKey === null;
  chatLastKey = key;

  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;

  if (!messages.length) {
    box.innerHTML = '<p class="chat-empty">No messages yet. Say hello to your travel crew 👋</p>';
    return;
  }

  let lastDay = '';
  box.innerHTML = messages.map((m) => {
    const d = new Date(m.created_at);
    const day = d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
    const time = d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
    const divider = day !== lastDay ? `<div class="chat-day"><span>${escapeHtml(day)}</span></div>` : '';
    lastDay = day;

    return `${divider}
      <div class="chat-msg ${m.mine ? 'is-mine' : ''}">
        ${m.mine ? '' : `<span class="chat-sender">${escapeHtml(m.sender_name || 'Member')}</span>`}
        <div class="chat-bubble">${escapeHtml(m.message)}</div>
        <span class="chat-time">${escapeHtml(time)}</span>
      </div>`;
  }).join('');

  if (firstRender || nearBottom) box.scrollTop = box.scrollHeight;
}

async function sendChatMessage() {
  const input = document.getElementById('chat-input');
  const button = document.querySelector('#trip-chat .chat-send');
  if (!input || !button || !chatTripId || button.disabled) return;

  const message = input.value.trim();
  if (!message) return;

  // Gentle warning if someone is about to share an Indian mobile number.
  if (/(\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}/.test(message) &&
      !window.confirm('This message looks like it contains a phone number. Send it anyway?')) {
    return;
  }

  button.disabled = true;
  try {
    const res = await fetch(`/api/trips/${encodeURIComponent(chatTripId)}/messages`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message })
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      toast(data.error || 'Message could not be sent.');
      return;
    }

    input.value = '';
    await loadChatMessages();
    const box = document.getElementById('chat-messages');
    if (box) box.scrollTop = box.scrollHeight;
  } catch {
    toast('Network error — message not sent. Please try again.');
  } finally {
    button.disabled = false;
    input.focus();
  }
}


// ================= Leave trip =================
async function leaveTrip(tripId) {
  const trip = trips.find((t) => String(t.id) === String(tripId));
  if (!trip || trip.mine) return;

  const accepted = trip.myRequestStatus === 'Accepted';
  const route = `${trip.origin} → ${trip.destination}`;

  const ok = window.confirm(accepted
    ? `Leave the trip ${route}?\n\nThe host will be notified, your seat will be released and you'll lose access to the trip chat.`
    : `Cancel your join request for ${route}?`);
  if (!ok) return;

  let reason = '';
  if (accepted) {
    const answer = window.prompt('Optional: let the host know why you can\'t come (max 300 characters).', '');
    if (answer === null) return; // clicked Cancel
    reason = answer.trim().slice(0, 300);
  }

  try {
    const res = await fetch(`/api/trips/${encodeURIComponent(tripId)}/leave`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason })
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      toast(data.error || 'Could not leave the trip. Please try again.');
      return;
    }

    toast(accepted ? 'You left the trip. The host has been notified.' : 'Join request cancelled.');
    if (chatTripId === String(tripId)) closeTripChat();
    await refreshTrips();
    renderMyTrips();
  } catch {
    toast('Network error. Please try again.');
  }
}

// ================= Notifications =================
async function loadNotifications() {
  try {
    const res = await fetch('/api/notifications', { credentials: 'same-origin' });
    if (!res.ok) return null;
    const data = await res.json();
    updateNotificationBadge(data.unread || 0);
    renderNotifications(Array.isArray(data.items) ? data.items : []);
    return data;
  } catch {
    return null;
  }
}

async function openNotifications() {
  const data = await loadNotifications();
  if (!data || !data.unread) return;

  // Something changed (e.g. a trip was cancelled): reload the trip list too.
  try {
    await refreshTrips();
    renderMyTrips();
  } catch { /* keep showing what we have */ }

  try {
    await fetch('/api/notifications/read', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    updateNotificationBadge(0);
  } catch { /* try again next time */ }
}

function updateNotificationBadge(count) {
  document.querySelectorAll('.nav-link[data-nav="my-trips"], .mobile-nav-link[data-nav="my-trips"]').forEach((btn) => {
    let badge = btn.querySelector('.notif-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'notif-badge';
      btn.appendChild(badge);
    }
    badge.textContent = count > 9 ? '9+' : String(count);
    badge.hidden = !count;
  });
}

function renderNotifications(items) {
  const screen = document.getElementById('screen-my-trips');
  if (!screen) return;

  let box = document.getElementById('my-notifications');
  if (!box) {
    box = document.createElement('div');
    box.id = 'my-notifications';
    screen.insertBefore(box, screen.querySelector('.requests-toolbar'));
    box.addEventListener('click', handleNotificationClick);
  }

  if (!items.length) {
    box.innerHTML = '';
    return;
  }

  box.innerHTML = `
    <div class="notif-panel">
      <div class="notif-head">
        <h2>🔔 Notifications</h2>
        <button class="notif-clear-all" type="button" data-notif-action="clear-all">
          Clear all
        </button>
      </div>
      ${items.slice(0, 10).map((n) => `
        <div class="notif-item ${n.isRead ? '' : 'is-unread'}">
          <p>${escapeHtml(n.message)}</p>
          <div class="notif-meta">
            <span>${escapeHtml(new Date(n.createdAt).toLocaleString('en-IN', {
              day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit'
            }))}</span>
            <button
              class="notif-delete"
              type="button"
              data-notif-action="delete"
              data-notif-id="${escapeHtml(n.id)}"
              aria-label="Delete notification"
              title="Delete">✕</button>
          </div>
        </div>
      `).join('')}
    </div>`;
}

async function handleNotificationClick(event) {
  const button = event.target.closest('[data-notif-action]');
  if (!button || button.disabled) return;

  // Delete one notification
  if (button.dataset.notifAction === 'delete') {
    const item = button.closest('.notif-item');
    button.disabled = true;
    if (item) item.classList.add('is-removing');

    const ok = await deleteNotificationRequest(
      `/api/notifications/${encodeURIComponent(button.dataset.notifId)}`
    );

    if (!ok) {
      toast('Could not delete the notification. Please try again.');
      button.disabled = false;
      if (item) item.classList.remove('is-removing');
      return;
    }

    await loadNotifications(); // redraw the list and update the badge
    return;
  }

  // Delete all notifications
  if (button.dataset.notifAction === 'clear-all') {
    if (!window.confirm('Delete all your notifications? This cannot be undone.')) return;

    button.disabled = true;
    const ok = await deleteNotificationRequest('/api/notifications');

    if (!ok) {
      toast('Could not clear notifications. Please try again.');
      button.disabled = false;
      return;
    }

    toast('All notifications cleared.');
    await loadNotifications();
  }
}

async function deleteNotificationRequest(url) {
  try {
    const res = await fetch(url, {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    // 404 means it was already deleted (e.g. from another tab): treat as done
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}loadNotifications();
setInterval(loadNotifications, 30000);

// ================= Unread chat dots =================
let chatUnreadBusy = false;

async function checkUnreadChats() {
  // Skip if the previous check is still running or the tab isn't visible
  if (chatUnreadBusy || document.hidden) return;
  chatUnreadBusy = true;

  try {
    const res = await fetch('/api/chats/unread', {
      credentials: 'same-origin',
      cache: 'no-store'
    });
    if (!res.ok) return;

    const data = await res.json();
    const unread = new Set((data.tripIds || []).map(String));

    document.querySelectorAll('[data-action="open-chat"]').forEach((btn) => {
      const id = String(btn.dataset.tripId);
      // No dot for the chat that is currently open
      const showDot = unread.has(id) && id !== String(chatTripId);
      btn.classList.toggle('has-unread', showDot);
      btn.setAttribute('aria-label', showDot ? 'Chat, new messages' : 'Chat');
    });
  } catch {
    // Network blip: try again next second
  } finally {
    chatUnreadBusy = false;
  }
}

checkUnreadChats();
setInterval(checkUnreadChats, 1000);

// Check again the moment you come back to this tab
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) checkUnreadChats();
});

  $('#search-button').addEventListener('click', () => { quickDestination = ''; renderTrips(); });
  $('#reset-filters').addEventListener('click', resetFilters);
  $('#filter-destination').addEventListener('input', () => { quickDestination = ''; renderTrips(); });
  $('#filter-date').addEventListener('change', () => { quickDestination = ''; renderTrips(); });
  $('#filter-mode').addEventListener('change', () => { quickDestination = ''; renderTrips(); });
  $('#filter-destination').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); quickDestination = ''; renderTrips(); } });

  const postMode = $('#post-mode');
  const otherModeField = $('#other-mode-field');
  const otherModeInput = $('#post-mode-other');
  function syncOtherModeField() { const show = postMode.value === 'Other'; otherModeField.hidden = !show; otherModeInput.required = show; if (!show) otherModeInput.value = ''; }
  postMode.addEventListener('change', syncOtherModeField);
  syncOtherModeField();

  $('#post-date').min = plusDays(0);
  $('#filter-date').min = plusDays(0);
  $('#preview-post-route').addEventListener('click', () => {
    const origin = $('#post-origin').value.trim();
    const destination = $('#post-destination').value.trim();
    if (!origin || !destination) {
      $('#post-map-status').textContent = 'Enter a departure location and destination before previewing the route.';
      if (!origin) $('#post-origin').focus(); else $('#post-destination').focus();
      return;
    }
    if (!window.TravellerMaps) {
      $('#post-map-status').textContent = 'The map script did not load. Check the internet connection and reload the page.';
      return;
    }
    window.TravellerMaps.showRoute({
      mapId: 'post-route-map',
      stopsId: 'post-route-stops',
      statusId: 'post-map-status',
      origin,
      destination,
      plannedStops: $('#post-route').value.trim(),
      mode: $('#post-mode').value || 'Car'
    });
  });

  $('#post-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const formData = new FormData(form);
    const payload = {
      origin: String(formData.get('origin') || '').trim(),
      destination: String(formData.get('destination') || '').trim(),
      date: String(formData.get('date') || ''),
      time: String(formData.get('time') || ''),
      route: String(formData.get('route') || '').trim(),
      mode: String(formData.get('mode') || ''),
      modeOther: String(formData.get('modeOther') || '').trim(),
      seats: Number(formData.get('seats') || 1),
      cost: Number(formData.get('cost') || 0),
      notes: String(formData.get('notes') || '').trim()
    };
    if (!payload.destination || !payload.origin) return;
    const submitButton = form.querySelector('[type="submit"]');
    setBusy(submitButton, true);
    try {
      const created = await api('/api/trips', { method: 'POST', body: payload });
      await refreshTrips();
      form.reset();
      syncOtherModeField();
      { const stops = $('#post-route-stops'); if (stops) { stops.hidden = true; stops.innerHTML = ''; } }
      $('#post-map-status').textContent = 'Enter a departure and destination to preview the route.';
      $('#post-date').min = plusDays(0);
      toast('Trip published. Nice one!');
      const newId = String((created && (created.id ?? (created.trip && created.trip.id))) ?? '');
      if (newId && trips.some((trip) => trip.id === newId)) renderDetail(newId); else navigate('explore');
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(submitButton, false);
    }
  });

  $('#join-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const trip = currentTrip();
    if (!trip || trip.mine || trip.seats < 1) { closeJoinModal(); toast('This trip is no longer accepting requests.'); return; }
    if (trip.requested) { closeJoinModal(); toast('You have already requested to join this trip.'); return; }
    const message = $('#join-message').value.trim();
    const submitButton = form.querySelector('[type="submit"]');
    setBusy(submitButton, true);
    try {
      // Only the message is sent: the server knows who you are from your sign-in.
      await api(`/api/trips/${encodeURIComponent(trip.id)}/requests`, { method: 'POST', body: { message } });
      trip.requested = true;
      closeJoinModal();
      await refreshTrips().catch(() => {});
      renderDetail(trip.id);
      toast('Request sent to the organizer.');
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(submitButton, false);
    }
  });

  $('#modal-close').addEventListener('click', closeJoinModal);
  $('#cancel-join').addEventListener('click', closeJoinModal);
  $('#join-modal').addEventListener('click', (event) => { if (event.target === $('#join-modal')) closeJoinModal(); });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('#join-modal').hidden) closeJoinModal();
  });

  function renderProfile() {
    const chip = $('.profile-chip');
    if (!chip || !currentUser) return;
    chip.setAttribute('aria-label', `Signed in as ${currentUser.name}`);
    const avatar = $('.avatar', chip);
    if (avatar) avatar.textContent = currentUser.initials;
    const nameElement = $('.profile-name', chip);
    if (nameElement) nameElement.textContent = currentUser.name;
    const dot = $('.verified-dot', chip);
    if (dot) dot.title = 'Verified IITR email';
  }

  // Optional: add <button id="logout-button"> to the header and this signs the student out.
  const logoutButton = $('#logout-button');
  if (logoutButton) logoutButton.addEventListener('click', async () => {
    try { await api('/auth/logout', { method: 'POST' }); } catch (error) { /* ignore */ }
    window.location.href = `${API_BASE}/`;
  });

  // Pick up new trips and requests when the student comes back to this tab.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && currentUser) refreshTrips().catch(() => {});
  });

  async function boot() {
    $('#trip-list').innerHTML = '<div class="empty-state"><h3>Loading trips…</h3></div>';
    try {
      const me = await api('/api/me');
      const user = (me && me.user) || me;
      currentUser = { ...user, initials: user.initials || initialsFor(user.name) };
      renderProfile();
      await refreshTrips();
    } catch (error) {
      if (error.silent) return; // being sent to sign in
      $('#trip-list').innerHTML = `<div class="empty-state"><h3>Couldn’t load trips</h3><p>${escapeHtml(error.message)}</p><div class="empty-actions"><button type="button" class="button button-primary" id="retry-load">Try again</button></div></div>`;
      const retry = $('#retry-load');
      if (retry) retry.addEventListener('click', boot);
    }
  }
  boot();


  // ================= About us =================
// ✏️ ONLY edit the text inside the quotes below.
// Links must start with https://  (leave '' to hide a link)
function getTeam() {
  return [
    {
      name: 'Jatin Kumar',
    linkedin: 'https://www.linkedin.com/in/jatin-kumar-02234b420?utm_source=share_via&utm_content=profile&utm_medium=member_android',
    instagram: 'https://www.instagram.com/jatin_g999?mdxt=YWxvbHBkM2x5bzN1',
    github: 'https://github.com/JatinKumar954'

    },
    {
      name: 'Vishwavijay Kumar',
    linkedin: 'https://www.linkedin.com/in/vishwavijay-kumar-477864434?utm_source=share_via&utm_content=profile&utm_medium=member_android',
    instagram: 'https://www.instagram.com/_vishwavijay_k?rpxt=M2sydzdjMHRpNGxp',
    github: 'https://github.com/vishwavijay-kumar' 
    },
    {
      name: 'Shivam',
    linkedin: 'https://www.linkedin.com/in/shivam-kaushik-237837284?utm_source=share_via&utm_content=profile&utm_medium=member_android',
    instagram: 'https://www.instagram.com/shivamkaushik557?cplk=MXdlYnFsYnBhNGpnNg==',
    github: 'https://github.com/shivamkaushik-sudo'
    },
    {
       name: 'Panshul',
    linkedin: 'https://www.linkedin.com/in/panshul-chaudhary-92a893446/?lipi=urn%3Ali%3Apage%3Ad_flagship3_profile_view_base_contact_details%3B5TiyhuAlRViDVcJkCMUaOw%3D%3D',
    instagram: 'https://www.instagram.com/panshul._.shivi?exln=Z3BraWVqbGpxNHk=',
    github: 'https://github.com/panshulchaudhary1202-maker'
    }
  ];
}

function safeUrl(url) {
  // Only allow real https links, so nothing harmful can be injected.
  const value = String(url || '').trim();
  return /^https:\/\//i.test(value) ? value : '';
}

function renderAbout() {
  const box = document.getElementById('about-team');
  if (!box) return;

  box.innerHTML = getTeam().map((dev, index) => {
    const name = String(dev.name || 'Team member').trim();
    const linkedin = safeUrl(dev.linkedin);
    const instagram = safeUrl(dev.instagram);
    const github = safeUrl(dev.github);

    const links = [
      linkedin && `<a class="about-link about-link-linkedin" href="${escapeHtml(linkedin)}" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(name)} on LinkedIn">LinkedIn</a>`,
      instagram && `<a class="about-link about-link-instagram" href="${escapeHtml(instagram)}" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(name)} on Instagram">Instagram</a>`,
      github && `<a class="about-link about-link-github" href="${escapeHtml(github)}" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(name)} on GitHub">GitHub</a>`
    ].filter(Boolean).join('');

    return `
      <article class="about-card">
        <span class="about-number">${String(index + 1).padStart(2, '0')}</span>
        <h3 class="about-name">${escapeHtml(name)}</h3>
        ${links
          ? `<div class="about-links">${links}</div>`
          : '<p class="about-no-links">Links coming soon</p>'}
      </article>`;
  }).join('');
}
})();

