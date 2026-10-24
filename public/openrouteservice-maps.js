/* TravelleR maps, geocoding, routing, and live autocomplete.
 * Routing/geocoding: openrouteservice services hosted at api.heigit.org.
 * Basemap: OpenStreetMap raster tiles rendered by Leaflet.
 * Browser API keys are visible to visitors; use a backend proxy for production.
 */
(() => {
  'use strict';

  const mapInstances = new Map();
  const requestVersions = new Map();
  // Keep the exact coordinates returned for a selected suggestion. Re-geocoding only
  // its label can otherwise snap a precise gate/venue to a city or campus centroid.
  const selectedPlaceCache = new Map();
  // Requests go to our own server (/ors/...), which adds the API key and forwards to api.heigit.org.
  const API_BASE = '/ors';
  const PELIAS_BASE = `${API_BASE}/pelias/v1`;
  const ORS_BASE = `${API_BASE}/openrouteservice/v2`;
  const apiKey = () => String(window.ORS_API_KEY || '').trim();
  const hasKey = () => true; // the key lives on the server
  const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  // IIT Roorkee campus focus improves ranking for nearby gates, hostels, buildings and roads.
  const CAMPUS_FOCUS = { lat: '29.86635', lon: '77.89621' };

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  }

  function setStatus(id, message) {
    const element = document.getElementById(id);
    if (element) element.textContent = message;
  }

  function loadingMarkup(title, message) {
    return `<div class="map-placeholder"><b>${escapeHtml(title)}</b><span>${escapeHtml(message)}</span></div>`;
  }

  async function parseResponse(response, serviceName) {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = data?.error?.message || data?.message || data?.error || data?.messageText || '';
      let message = (typeof detail === 'string' && detail) || `${serviceName} request failed (${response.status}).`;
      if (response.status === 401 || response.status === 403) {
        message = `${serviceName} access was denied. Sign in again, or ask the site admin to check the server map key.`;
      } else if (response.status === 429) {
        message = `${serviceName} usage limit reached. Wait a little before trying again.`;
      } else if (response.status === 400) {
        message = `${serviceName} rejected the request. ${typeof detail === 'string' ? detail : 'Choose more specific locations and try again.'}`;
      }
      throw new Error(message);
    }
    return data;
  }

  function orsHeaders(json = false) {
    const headers = {};
    if (json) headers['Content-Type'] = 'application/json';
    return headers;
  }

  function getMap(mapId) {
    if (!window.L) throw new Error('The map library did not load. Check your internet connection and reload.');
    const container = document.getElementById(mapId);
    if (!container) throw new Error(`Map container #${mapId} was not found.`);

    let record = mapInstances.get(mapId);
    if (record && record.container !== container) {
      record.map.remove();
      mapInstances.delete(mapId);
      record = null;
    }
    if (!record) {
      container.innerHTML = '';
      const map = L.map(container, { scrollWheelZoom: false, preferCanvas: true, zoomControl: false }).setView([29.86635, 77.89621], 8);
      L.control.zoom({ position: 'topright' }).addTo(map);
      // Hide Leaflet's branding prefix but retain OpenStreetMap attribution as required.
      map.attributionControl.setPrefix(false);
      // OpenStreetMap tiles are separate from openrouteservice; keep attribution visible
      // and avoid bulk downloads/pre-fetching of tiles.
      L.tileLayer(TILE_URL, {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>'
      }).addTo(map);
      const routeLayer = L.layerGroup().addTo(map);
      const stopLayer = L.layerGroup().addTo(map);
      record = { map, routeLayer, stopLayer, container };
      mapInstances.set(mapId, record);
    }
    window.setTimeout(() => record.map.invalidateSize(), 120);
    return record;
  }

  function peliasParams(entries) {
    const params = new URLSearchParams();
    Object.entries(entries).forEach(([name, value]) => {
      if (value !== undefined && value !== null && String(value) !== '') params.set(name, String(value));
    });
    return params;
  }

  function featureToPlace(feature, fallback = '') {
    const props = feature?.properties || {};
    const coords = feature?.geometry?.coordinates || [];
    const lon = Number(coords[0]);
    const lat = Number(coords[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return {
      name: props.name || props.locality || props.localadmin || props.label || fallback,
      lat,
      lon,
      address: props.label || [props.name, props.locality, props.region, props.country]
        .filter((value, index, array) => value && array.indexOf(value) === index).join(', ') || fallback,
      properties: props,
      feature
    };
  }

  function isIitrCenturyGateQuery(value) {
    const text = normalizePlaceName(value);
    // The autocomplete focus is IIT Roorkee, so recognise the common local spellings
    // even when the user types only “Centure gate”.
    return /cent(?:ure|ury|enary)/.test(text) && /gate/.test(text);
  }

  function queryVariants(place) {
    if (isIitrCenturyGateQuery(place)) {
      return [
        'Centenary Gate, IIT Roorkee, Roorkee, Uttarakhand, India',
        'Century Gate, IIT Roorkee, Roorkee, Uttarakhand, India',
        'Centenary Gate, Roorkee, Uttarakhand, India',
        'Century Gate, Roorkee, Uttarakhand, India',
        'IIT Roorkee Century Gate, India'
      ];
    }
    return [place];
  }

  async function geocode(place) {
    const requested = String(place || '').trim();
    const cached = selectedPlaceCache.get(normalizePlaceName(requested));
    if (cached && Number.isFinite(cached.lat) && Number.isFinite(cached.lon)) {
      return { ...cached, name: cached.name || requested };
    }

    const variants = queryVariants(requested);
    let lastError = null;
    for (const query of variants) {
      const url = new URL(`${PELIAS_BASE}/search`, window.location.origin);
      url.search = peliasParams({
        text: query,
        size: isIitrCenturyGateQuery(requested) ? 8 : 5,
        'boundary.country': 'IND',
        'focus.point.lat': CAMPUS_FOCUS.lat,
        'focus.point.lon': CAMPUS_FOCUS.lon,
        lang: 'en'
      }).toString();
      try {
        const data = await parseResponse(await fetch(url, { headers: orsHeaders() }), 'Geocoding');
        const features = (data.features || []).map((item) => featureToPlace(item, query)).filter(Boolean);
        let selected = features[0];
        if (isIitrCenturyGateQuery(requested)) {
          // Never silently substitute the campus/city centroid for a gate. Only accept a
          // search result that actually names the gate/centenary landmark.
          selected = features.find((feature) => {
            const props = feature.properties || {};
            const searchable = normalizePlaceName([props.name, props.label, props.venue, props.street].filter(Boolean).join(' '));
            return /gate/.test(searchable) && /cent(?:ure|ury|enary)/.test(searchable);
          });
        }
        if (selected) return selected;
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError && variants.length === 1) throw lastError;
    if (isIitrCenturyGateQuery(requested)) {
      throw new Error('The suggestion was found, but openrouteservice map data did not return an exact Century/Centenary Gate point. Try “Century Gate IIT Roorkee” or choose a nearby named road/landmark; the map will not guess a gate coordinate.');
    }
    throw new Error(`Could not find “${requested}”. Choose a suggestion, or add the city/state and a nearby landmark.`);
  }

  function parsePlannedStops(value) {
    return String(value || '')
      .split(/\s*(?:;|\||→|->|>)\s*|\s*,\s*|\s+then\s+/i)
      .map((part) => part.replace(/^then\s+/i, '').trim())
      .filter(Boolean)
      .slice(0, 6);
  }

  async function calculateRoute(locations, mode) {
    // ORS does not expose a public-transit/bus routing profile. Bus and Other therefore
    // use the driving-car profile and are explicitly labelled as approximations.
    const profile = mode === 'Bike' ? 'cycling-regular' : 'driving-car';
    const usedFallback = mode === 'Bus' || mode === 'Other';
    const endpoint = `${ORS_BASE}/directions/${profile}/geojson`;
    const body = {
      coordinates: locations.map((point) => [point.lon, point.lat]),
      instructions: false,
      elevation: false
    };
    const data = await parseResponse(await fetch(endpoint, {
      method: 'POST',
      headers: orsHeaders(true),
      body: JSON.stringify(body)
    }), 'Road routing');

    const feature = data.type === 'FeatureCollection'
      ? (data.features || []).find((item) => item.geometry?.coordinates?.length)
      : data.type === 'Feature' ? data : null;
    if (!feature || !feature.geometry || !feature.geometry.coordinates) {
      throw new Error('openrouteservice could not calculate a road route for these locations. Try choosing more specific suggestions.');
    }
    return { feature, usedFallback };
  }

  function routeLatLngs(geometry) {
    if (!geometry || !geometry.coordinates) return [];
    if (geometry.type === 'LineString') return geometry.coordinates.map((coord) => [Number(coord[1]), Number(coord[0])]);
    if (geometry.type === 'MultiLineString') return geometry.coordinates.flatMap((line) => line.map((coord) => [Number(coord[1]), Number(coord[0])]));
    return [];
  }

  function metersBetween(a, b) {
    const R = 6371000;
    const toRad = (degrees) => degrees * Math.PI / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function sampleRoute(routeCoords, maxSamples = 10) {
    if (!Array.isArray(routeCoords) || routeCoords.length < 2) return { samples: [], totalDistance: 0 };
    const cumulative = [0];
    for (let i = 1; i < routeCoords.length; i += 1) {
      cumulative.push(cumulative[i - 1] + metersBetween(
        { lat: routeCoords[i - 1][0], lon: routeCoords[i - 1][1] },
        { lat: routeCoords[i][0], lon: routeCoords[i][1] }
      ));
    }
    const totalDistance = cumulative[cumulative.length - 1];
    if (!Number.isFinite(totalDistance) || totalDistance < 1500) return { samples: [], totalDistance };
    const sampleCount = Math.min(maxSamples, Math.max(2, Math.ceil(totalDistance / 40000)));
    const samples = [];
    for (let i = 1; i <= sampleCount; i += 1) {
      const progress = i / (sampleCount + 1);
      const target = totalDistance * progress;
      let low = 1;
      let high = cumulative.length - 1;
      while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (cumulative[mid] < target) low = mid + 1;
        else high = mid;
      }
      const end = low;
      const start = Math.max(0, end - 1);
      const segmentLength = cumulative[end] - cumulative[start];
      const ratio = segmentLength > 0 ? (target - cumulative[start]) / segmentLength : 0;
      const [lat1, lon1] = routeCoords[start];
      const [lat2, lon2] = routeCoords[end];
      samples.push({
        lat: lat1 + (lat2 - lat1) * ratio,
        lon: lon1 + (lon2 - lon1) * ratio,
        progress,
        alongMeters: target
      });
    }
    return { samples, totalDistance };
  }

  function normalizePlaceName(value) {
    return String(value || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLocaleLowerCase()
      .replace(/\b(city|town|village|municipality|tehsil|taluka)\b/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  async function reverseGeocodeSettlement(point) {
    const url = new URL(`${PELIAS_BASE}/reverse`, window.location.origin);
    url.search = peliasParams({
      'point.lat': point.lat,
      'point.lon': point.lon,
      size: 1,
      layers: 'locality,localadmin,county',
      'boundary.country': 'IND',
      lang: 'en'
    }).toString();
    const data = await parseResponse(await fetch(url, { headers: orsHeaders() }), 'Settlement lookup');
    const feature = (data.features || [])[0];
    if (!feature) return null;
    const props = feature.properties || {};
    const name = [props.locality, props.localadmin, props.name, props.county]
      .map((value) => String(value || '').trim())
      .find((value) => value && !/^india$/i.test(value) && !/^uttarakhand$/i.test(value));
    if (!name) return null;
    const contextParts = [props.county, props.region, props.country]
      .map((value) => String(value || '').trim())
      .filter((value, index, values) => value && normalizePlaceName(value) !== normalizePlaceName(name)
        && values.findIndex((other) => normalizePlaceName(other) === normalizePlaceName(value)) === index);
    const layer = String(props.layer || '').toLowerCase();
    const kind = layer === 'locality' ? 'City / settlement'
      : layer === 'localadmin' ? 'Town / settlement'
        : 'Area / settlement';
    return {
      id: `settlement:${normalizePlaceName(name)}`,
      name,
      address: contextParts.join(', '),
      // Marker remains on the route, not at a possibly distant settlement centroid.
      lat: point.lat,
      lon: point.lon,
      kind,
      routeProgress: point.progress,
      alongMeters: point.alongMeters
    };
  }

  async function searchSettlementsAlongRoute(routeCoords) {
    const { samples, totalDistance } = sampleRoute(routeCoords);
    if (!samples.length) return { settlements: [], totalDistance, errors: [] };
    const settlements = [];
    const errors = [];
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < samples.length) {
        const index = nextIndex++;
        try {
          const settlement = await reverseGeocodeSettlement(samples[index]);
          if (settlement) settlements.push(settlement);
        } catch (error) {
          errors.push(error);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, samples.length) }, () => worker()));
    settlements.sort((a, b) => a.routeProgress - b.routeProgress);
    const unique = [];
    const seen = new Set();
    for (const settlement of settlements) {
      const key = normalizePlaceName(settlement.name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      unique.push(settlement);
    }
    if (!unique.length && errors.length === samples.length) throw errors[0];
    return { settlements: unique, totalDistance, errors };
  }

  function formatDistance(meters) {
    if (!Number.isFinite(meters)) return '';
    return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
  }

  function renderStops(stopsId, stops, mapId, stopLayer) {
    const container = document.getElementById(stopsId);
    if (!container) return;
    container.hidden = false;
    if (!stops.length) {
      container.innerHTML = '<div class="route-stops-empty">The road route loaded, but openrouteservice geocoding did not identify any distinct city, town, or village along it. Try a longer route or a more specific destination.</div>';
      return;
    }
    container.innerHTML = `<div class="route-stops-heading"><h3>Cities &amp; villages along the way</h3><span>${stops.length} settlements</span></div><div class="route-stops-list">${stops.map((stop, index) => {
      const detail = [stop.kind, `Around ${Math.round(stop.routeProgress * 100)}% of the route`, stop.address].filter(Boolean).join(' · ');
      return `<article class="route-stop-card"><span class="route-stop-number">${index + 1}</span><div class="route-stop-copy"><b>${escapeHtml(stop.name)}</b><small>${escapeHtml(detail)}</small></div><button type="button" class="route-stop-focus" data-stop-lat="${stop.lat}" data-stop-lon="${stop.lon}" aria-label="Show ${escapeHtml(stop.name)} on map">Show</button></article>`;
    }).join('')}</div>`;

    stops.forEach((stop) => {
      stop.marker = L.marker([stop.lat, stop.lon]).bindPopup(`<strong>${escapeHtml(stop.name)}</strong><br>${escapeHtml(stop.kind)}<br>Approx. ${Math.round(stop.routeProgress * 100)}% along the route${stop.address ? `<br>${escapeHtml(stop.address)}` : ''}`).addTo(stopLayer);
    });
    container.querySelectorAll('[data-stop-lat]').forEach((button) => {
      button.addEventListener('click', () => {
        const lat = Number(button.dataset.stopLat);
        const lon = Number(button.dataset.stopLon);
        const stop = stops.find((item) => item.lat === lat && item.lon === lon);
        const record = mapInstances.get(mapId);
        if (record) {
          record.map.setView([lat, lon], 14);
          if (stop && stop.marker) stop.marker.openPopup();
        }
      });
    });
  }

  function addEndpointMarkers(layer, locations) {
    locations.forEach((point, index) => {
      const label = index === 0 ? 'Start' : index === locations.length - 1 ? 'Destination' : 'Planned stop';
      L.marker([point.lat, point.lon])
        .bindPopup(`<strong>${escapeHtml(label)}</strong><br>${escapeHtml(point.name)}<br>${escapeHtml(point.address || '')}`)
        .addTo(layer);
    });
  }

  async function showRoute(options) {
    const { mapId, stopsId, statusId, origin, destination, plannedStops = '', mode = 'Car' } = options;
    const mapContainer = document.getElementById(mapId);
    if (!mapContainer) return;
    const version = (requestVersions.get(mapId) || 0) + 1;
    requestVersions.set(mapId, version);
    const isLatest = () => requestVersions.get(mapId) === version;
    const previousStops = document.getElementById(stopsId);
    if (previousStops) { previousStops.hidden = true; previousStops.innerHTML = ''; }

    if (!hasKey()) {
      mapContainer.innerHTML = loadingMarkup('Add your openrouteservice API key', 'Open openrouteservice-config.js and replace YOUR_OPENROUTESERVICE_API_KEY, then reload the page.');
      setStatus(statusId, 'openrouteservice API key is not configured yet.');
      return;
    }
    if (!mapInstances.has(mapId)) mapContainer.innerHTML = loadingMarkup('Loading route…', 'Finding locations, calculating a route, and identifying settlements along the way.');
    setStatus(statusId, 'Looking up locations and calculating the route…');

    try {
      const intermediateNames = parsePlannedStops(plannedStops);
      const placeNames = [origin, ...intermediateNames, destination].map((place) => String(place || '').trim()).filter(Boolean);
      if (placeNames.length < 2) throw new Error('Enter a departure and destination first.');
      const locations = await Promise.all(placeNames.map(geocode));
      if (!isLatest()) return;
      const record = getMap(mapId);
      record.routeLayer.clearLayers();
      record.stopLayer.clearLayers();
      addEndpointMarkers(record.routeLayer, locations);

      const isTrain = mode === 'Train';
      let routeCoords = locations.map((place) => [place.lat, place.lon]);
      let routeSummary = '';
      let routeFallback = false;
      if (!isTrain) {
        setStatus(statusId, 'Calculating the openrouteservice road route…');
        const result = await calculateRoute(locations, mode);
        if (!isLatest()) return;
        const feature = result.feature;
        routeFallback = result.usedFallback;
        routeCoords = routeLatLngs(feature.geometry);
        if (routeCoords.length < 2) throw new Error('The route response did not contain enough map points. Try different locations.');
        L.geoJSON(feature, { style: { color: '#176b50', weight: 5, opacity: 0.9 } }).addTo(record.routeLayer);
        const props = feature.properties || {};
        const summary = props.summary || {};
        const distance = Number(summary.distance ?? props.distance);
        const duration = Number(summary.duration ?? props.duration);
        routeSummary = [
          Number.isFinite(distance) ? formatDistance(distance) : '',
          Number.isFinite(duration) ? `${Math.round(duration / 60)} min estimated` : '',
          routeFallback ? (mode === 'Bus' ? 'car-route approximation (no public bus profile)' : 'car-route approximation') : ''
        ].filter(Boolean).join(' · ');
      } else {
        L.polyline(routeCoords, { color: '#176b50', weight: 4, opacity: 0.7, dashArray: '7 8' }).addTo(record.routeLayer);
        routeSummary = 'Locations only — not a train line or timetable';
      }

      record.map.fitBounds(L.latLngBounds(routeCoords).pad(0.12), { maxZoom: 12 });
      window.setTimeout(() => record.map.invalidateSize(), 150);
      if (isTrain) {
        setStatus(statusId, `Mapped the locations. ${routeSummary}. Check a rail operator for current train schedules.`);
        return;
      }

      setStatus(statusId, `${routeSummary || 'Road route calculated.'} Identifying cities, towns and villages along the journey…`);
      const { settlements, errors } = await searchSettlementsAlongRoute(routeCoords);
      if (!isLatest()) return;
      const endpointNames = new Set(locations.map((place) => normalizePlaceName(place.name)));
      const stops = settlements.filter((item) => !endpointNames.has(normalizePlaceName(item.name))).slice(0, 18);
      renderStops(stopsId, stops, mapId, record.stopLayer);
      if (!stops.length) {
        setStatus(statusId, `${routeSummary}. The route loaded, but distinct city/town/village checkpoints were not identified. Settlement results depend on map data coverage.`);
      } else {
        const partialNote = errors.length ? ' Some lookup points could not be checked.' : '';
        setStatus(statusId, `${routeSummary}. Found ${stops.length} distinct settlement checkpoint(s), ordered along the route.${partialNote} These are approximate geographic suggestions, not verified pickup points or live traffic information.`);
      }
    } catch (error) {
      if (!isLatest()) return;
      console.error('openrouteservice route preview failed:', error);
      const record = mapInstances.get(mapId);
      if (record) {
        record.routeLayer.clearLayers();
        record.stopLayer.clearLayers();
      } else {
        mapContainer.innerHTML = loadingMarkup('Route preview unavailable', error.message || 'Check your API key, API access, and network connection.');
      }
      setStatus(statusId, error.message || 'Could not load this route.');
    }
  }

  function resizeMap(mapId) {
    const record = mapInstances.get(mapId);
    if (record) window.setTimeout(() => record.map.invalidateSize(), 80);
  }

  function localSuggestions(query) {
    // Do not create a fake coordinate-less gate result: only show selectable places that
    // have real coordinates, so choosing a suggestion can actually be routed.
    return [];
  }

  function autocompleteVariants(query) {
    if (isIitrCenturyGateQuery(query)) {
      return [
        'Centenary Gate, IIT Roorkee, Roorkee, Uttarakhand, India',
        'Century Gate, IIT Roorkee, Roorkee, Uttarakhand, India',
        'Centenary Gate, Roorkee, Uttarakhand, India',
        'Century Gate, Roorkee, Uttarakhand, India',
        query
      ];
    }
    // Expand short campus-local queries so Pelias can match names with campus context.
    const normalized = normalizePlaceName(query);
    if (/(iitr|iit roorkee)/.test(normalized)) {
      return [query, `${query}, IIT Roorkee, Roorkee, Uttarakhand, India`];
    }
    return [query];
  }

  function initAutocomplete(inputId, options = {}) {
    const input = document.getElementById(inputId);
    if (!input) return;
    const field = input.closest('.field') || input.parentElement;
    if (!field) return;
    field.classList.add('has-ors-autocomplete');

    const list = document.createElement('div');
    list.className = 'ors-suggestions';
    list.id = `${inputId}-suggestions`;
    list.setAttribute('role', 'listbox');
    list.hidden = true;
    field.appendChild(list);
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', list.id);
    input.setAttribute('aria-expanded', 'false');

    let timer = null;
    let controller = null;
    let suggestions = [];
    let activeIndex = -1;
    let requestId = 0;
    let suppressAutocompleteInput = false;

    const close = () => {
      list.hidden = true;
      list.innerHTML = '';
      activeIndex = -1;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
    };
    const setActive = (next) => {
      if (!suggestions.length) return;
      activeIndex = (next + suggestions.length) % suggestions.length;
      [...list.querySelectorAll('.ors-suggestion')].forEach((button, index) => {
        button.classList.toggle('is-active', index === activeIndex);
        button.setAttribute('aria-selected', String(index === activeIndex));
      });
      input.setAttribute('aria-activedescendant', `${list.id}-item-${activeIndex}`);
      list.querySelectorAll('.ors-suggestion')[activeIndex]?.scrollIntoView({ block: 'nearest' });
    };

    const getQueryContext = () => {
      const value = input.value;
      if (!options.multiStop) return { query: value.trim(), start: 0, end: value.length };
      const caret = input.selectionStart ?? value.length;
      // Search the active segment only, so “Haridwar; Rishikesh” suggests Rishikesh.
      const delimiter = /(?:,|;|\||→|->|\bthen\b)/gi;
      let start = 0;
      let end = value.length;
      let match;
      while ((match = delimiter.exec(value))) {
        const after = match.index + match[0].length;
        if (after <= caret) start = after;
        else if (match.index >= caret) { end = match.index; break; }
      }
      return { query: value.slice(start, caret).trim(), start, end };
    };

    const choose = (item) => {
      let chosenText = item.formatted || item.address_line1 || item.name || '';
      if (options.multiStop) {
        // Use the compact place name, not a comma-filled full address, because commas also
        // separate manually entered stops in this field. Keep the exact selected coordinates.
        chosenText = item.name || item.address_line1 || chosenText;
        const context = getQueryContext();
        const before = input.value.slice(0, context.start);
        const after = input.value.slice(context.end);
        const leadingSpace = context.start > 0 && before && !/\s$/.test(before) ? ' ' : '';
        const trailingSpace = after && !/^\s|^,|^;|^\||^→|^->/.test(after) ? ' ' : '';
        input.value = `${before}${leadingSpace}${chosenText}${trailingSpace}${after}`.trimEnd();
      } else {
        input.value = chosenText;
      }
      const selectedLat = item.lat !== null && item.lat !== undefined && item.lat !== '' && Number.isFinite(Number(item.lat)) ? Number(item.lat) : null;
      const selectedLon = item.lon !== null && item.lon !== undefined && item.lon !== '' && Number.isFinite(Number(item.lon)) ? Number(item.lon) : null;
      input.dataset.orsLat = selectedLat !== null ? String(selectedLat) : '';
      input.dataset.orsLon = selectedLon !== null ? String(selectedLon) : '';
      input.dataset.orsLayer = String(item.result_type || '');
      if (selectedLat !== null && selectedLon !== null) {
        selectedPlaceCache.set(normalizePlaceName(chosenText), {
          name: item.name || chosenText,
          lat: selectedLat, lon: selectedLon,
          address: item.formatted || item.address_line2 || chosenText,
          properties: { layer: item.result_type || '', label: item.formatted || chosenText }
        });
      }
      close();
      input.dispatchEvent(new Event('change', { bubbles: true }));
      if (inputId === 'filter-destination') {
        suppressAutocompleteInput = true;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    };

    const render = (results, query = '') => {
      const extras = localSuggestions(query);
      const local = extras.filter((item) => !results.some((result) => normalizePlaceName(result.name) === normalizePlaceName(item.name)));
      suggestions = [...local, ...results].slice(0, options.limit || 8);
      activeIndex = -1;
      list.innerHTML = '';
      if (!suggestions.length) {
        list.innerHTML = '<div class="ors-suggestion-message">No matching places found. Try adding a city/state or a nearby landmark.</div>';
        list.hidden = false;
        input.setAttribute('aria-expanded', 'true');
        return;
      }
      suggestions.forEach((item, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'ors-suggestion';
        button.id = `${list.id}-item-${index}`;
        button.setAttribute('role', 'option');
        button.setAttribute('aria-selected', 'false');
        const title = item.name || item.address_line1 || item.city || item.state || item.formatted;
        const context = [item.city, item.state, item.country]
          .filter((value, i, array) => value && array.indexOf(value) === i && value !== title).join(', ');
        const subtitle = item.address_line2 || context || item.formatted || item.result_type || '';
        const icon = ['locality', 'localadmin', 'region'].includes(item.result_type) ? '⌖' : '⌁';
        button.innerHTML = `<span class="ors-suggestion-icon" aria-hidden="true">${icon}</span><span class="ors-suggestion-text"><b></b><small></small></span><span class="ors-suggestion-enter" aria-hidden="true">↵</span>`;
        button.querySelector('b').textContent = title || 'Location';
        button.querySelector('small').textContent = subtitle;
        button.addEventListener('pointerdown', (event) => event.preventDefault());
        button.addEventListener('click', () => choose(item));
        list.appendChild(button);
      });
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
    };

    const runSearch = async (query) => {
      const local = localSuggestions(query);
      if (!hasKey()) {
        render([], query);
        if (!local.length) {
          const message = list.querySelector('.ors-suggestion-message');
          if (message) message.textContent = 'Add your openrouteservice key in openrouteservice-config.js to enable live suggestions.';
        }
        return;
      }
      if (controller) controller.abort();
      controller = new AbortController();
      const current = ++requestId;
      try {
        const variants = autocompleteVariants(query);
        const combined = [];
        for (const searchText of variants) {
          const url = new URL(`${PELIAS_BASE}/autocomplete`, window.location.origin);
          url.search = peliasParams({
            text: searchText,
            size: options.limit || 8,
            'boundary.country': 'IND',
            // Rank near IIT Roorkee, helping campus gates and named buildings surface.
            'focus.point.lat': CAMPUS_FOCUS.lat,
            'focus.point.lon': CAMPUS_FOCUS.lon,
            lang: 'en',
            layers: options.localityOnly
              ? 'locality,localadmin,county,region'
              : 'address,venue,street,neighbourhood,locality,localadmin,county,region'
          }).toString();
          const response = await fetch(url, { headers: orsHeaders(), signal: controller.signal });
          const data = await parseResponse(response, 'Location suggestions');
          if (current !== requestId) return;
          const results = (data.features || []).map((feature) => {
            const place = featureToPlace(feature, searchText);
            if (!place) return null;
            const props = feature.properties || {};
            return {
              name: props.name || props.venue || props.locality || props.localadmin || props.label,
              formatted: props.label || place.address,
              address_line1: props.name || props.venue || props.locality || props.localadmin || '',
              address_line2: [props.locality, props.localadmin, props.county, props.region, props.country]
                .filter((value, index, array) => value && array.indexOf(value) === index).join(', '),
              city: props.locality || props.localadmin || '',
              state: props.region || '',
              country: props.country || '',
              result_type: props.layer || '',
              lat: place.lat,
              lon: place.lon,
              label: props.label || ''
            };
          }).filter(Boolean);
          for (const item of results) {
            const key = `${normalizePlaceName(item.name)}|${Number(item.lat).toFixed(5)}|${Number(item.lon).toFixed(5)}`;
            if (!combined.some((existing) => existing._key === key)) combined.push({ ...item, _key: key });
          }
          // If an exact gate result is found, stop querying variants and prioritize it.
          if (isIitrCenturyGateQuery(query) && results.some((item) => /gate/i.test(`${item.name} ${item.formatted}`) && /cent(?:ure|ury|enary)/i.test(`${item.name} ${item.formatted}`))) break;
        }
        if (current !== requestId) return;
        let results = combined.map(({ _key, ...item }) => item);
        if (isIitrCenturyGateQuery(query)) {
          results.sort((a, b) => {
            const aExact = /gate/i.test(`${a.name} ${a.formatted}`) && /cent(?:ure|ury|enary)/i.test(`${a.name} ${a.formatted}`) ? 1 : 0;
            const bExact = /gate/i.test(`${b.name} ${b.formatted}`) && /cent(?:ure|ury|enary)/i.test(`${b.name} ${b.formatted}`) ? 1 : 0;
            return bExact - aExact;
          });
        }
        render(results, query);
      } catch (error) {
        if (error.name === 'AbortError' || current !== requestId) return;
        console.warn('openrouteservice autocomplete failed:', error);
        render([], query);
        if (!local.length) {
          list.innerHTML = `<div class="ors-suggestion-message">${escapeHtml(error.message || 'Suggestions are unavailable right now. You can still type the location manually.')}</div>`;
        }
      }
    };

    input.addEventListener('input', () => {
      if (suppressAutocompleteInput) { suppressAutocompleteInput = false; return; }
      input.dataset.orsLat = '';
      input.dataset.orsLon = '';
      input.dataset.orsLayer = '';
      const context = getQueryContext();
      const query = context.query;
      clearTimeout(timer);
      if (controller) controller.abort();
      suggestions = [];
      requestId += 1;
      if (query.length < 2) { close(); return; }
      list.innerHTML = '<div class="ors-suggestion-message">Searching precise places, landmarks, and addresses…</div>';
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      timer = window.setTimeout(() => runSearch(query), 300);
    });
    input.addEventListener('keydown', (event) => {
      if (list.hidden) return;
      if (event.key === 'ArrowDown') { event.preventDefault(); setActive(activeIndex + 1); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(activeIndex <= 0 ? suggestions.length - 1 : activeIndex - 1); }
      else if (event.key === 'Enter' && activeIndex >= 0 && suggestions[activeIndex]) { event.preventDefault(); choose(suggestions[activeIndex]); }
      else if (event.key === 'Escape') close();
    });
    input.addEventListener('focus', () => {
      const { query } = getQueryContext();
      if (query.length >= 2 && list.innerHTML && list.hidden) {
        list.hidden = false;
        input.setAttribute('aria-expanded', 'true');
      }
    });
    document.addEventListener('click', (event) => { if (!field.contains(event.target)) close(); });
  }

  document.addEventListener('DOMContentLoaded', () => {
    initAutocomplete('post-origin');
    initAutocomplete('post-destination');
    initAutocomplete('post-route', { multiStop: true, limit: 8 });
    initAutocomplete('filter-destination', { localityOnly: true, limit: 6 });
  });

  window.TravellerMaps = { showRoute, resizeMap };
})();
