
/* =========================================================
   SATELLITE EXPLORER PRO-1
   AIRCRAFT PROXY SERVER
   ADSB.FI + ADSB.LOL
   VERSION 5.0.0
   Node.js 18+
   ========================================================= */

'use strict';

const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 10000;

app.disable('x-powered-by');

const ALLOWED_ORIGINS = [
  'https://hasannek5-cpu.github.io'
];

app.use(cors({
  origin(origin, callback) {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true);
    }
    const error = new Error('Origin not allowed by CORS');
    error.status = 403;
    callback(error);
  },
  methods: ['GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));

app.use(express.json({ limit: '20kb' }));

/* ================= CONFIG ================= */

const REQUEST_TIMEOUT = 12000;
const MAX_DISTANCE = 250;

const providers = [
  {
    name: 'adsb.fi',
    base: 'https://opendata.adsb.fi/api/v3'
  },
  {
    name: 'adsb.lol',
    base: 'https://api.adsb.lol/v2'
  }
];

const providerStatus = {};

for (const p of providers) {
  providerStatus[p.name] = {
    available: null,
    lastCheck: null,
    error: null,
    aircraft: 0
  };
}

/* ================= HELPERS ================= */

function numericOrNull(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function validNumber(value, min, max) {
  const n = numericOrNull(value);
  return n !== null && n >= min && n <= max;
}

function booleanValue(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;

  if (typeof value === 'string') {
    return ['true', '1', 'yes'].includes(
      value.trim().toLowerCase()
    );
  }

  return false;
}

function cleanText(value) {
  if (value === null || value === undefined) return null;
  return String(value).trim() || null;
}

/* ================= FETCH ================= */

async function fetchJSON(url) {
  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT
  );

  try {
    const response = await fetch(url, {
      method: 'GET',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'SatelliteExplorerPro/5.0'
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.json();

  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('Provider request timeout');
    }
    throw error;

  } finally {
    clearTimeout(timer);
  }
}

/* ================= NORMALIZE ================= */

function normalizeAircraft(data, provider) {
  const list = Array.isArray(data?.ac)
    ? data.ac
    : Array.isArray(data?.aircraft)
      ? data.aircraft
      : [];

  return list.map(a => {
    const lat = numericOrNull(a.lat ?? a.latitude);
    const lon = numericOrNull(a.lon ?? a.longitude);

    const hex = String(
      a.hex || a.icao24 || ''
    ).trim().toLowerCase();

    return {
      hex,

      flight: cleanText(a.flight || a.callsign),

      lat,
      lon,

      alt_baro: a.alt_baro ?? a.altitude ?? null,
      alt_geom: a.alt_geom ?? null,

      gs: numericOrNull(a.gs ?? a.speed),

      track: numericOrNull(a.track ?? a.heading),

      squawk: cleanText(a.squawk),
      category: cleanText(a.category),

      seen: numericOrNull(a.seen),
      seen_pos: numericOrNull(a.seen_pos),

      gnd: booleanValue(a.gnd ?? a.on_ground),

      r: cleanText(a.r ?? a.registration),
      t: cleanText(a.t ?? a.type),
      desc: cleanText(a.desc ?? a.description),

      source: provider
    };

  }).filter(a =>
    a.hex &&
    a.lat !== null &&
    a.lon !== null &&
    a.lat >= -90 &&
    a.lat <= 90 &&
    a.lon >= -180 &&
    a.lon <= 180
  );
}

/* ================= PROVIDERS ================= */

async function getProviderAircraft(provider, lat, lon, dist) {
  const url =
    `${provider.base}/lat/${lat}/lon/${lon}/dist/${dist}`;

  try {
    const data = await fetchJSON(url);

    const aircraft = normalizeAircraft(data, provider.name);

    providerStatus[provider.name] = {
      available: true,
      lastCheck: new Date().toISOString(),
      error: null,
      aircraft: aircraft.length
    };

    return {
      ok: true,
      provider: provider.name,
      aircraft
    };

  } catch (error) {
    providerStatus[provider.name] = {
      available: false,
      lastCheck: new Date().toISOString(),
      error: error.message,
      aircraft: 0
    };

    console.error(
      `[${provider.name}] ${error.message}`
    );

    return {
      ok: false,
      provider: provider.name,
      aircraft: [],
      error: error.message
    };
  }
}

/* ================= MERGE ================= */

function getAircraftScore(plane) {
  let score = 0;

  if (plane.flight) score += 3;
  if (plane.alt_baro !== null) score++;
  if (plane.gs !== null) score++;
  if (plane.track !== null) score++;
  if (plane.r) score += 2;
  if (plane.t) score++;
  if (plane.desc) score++;
  if (plane.category) score++;
  if (plane.seen_pos !== null) score++;

  return score;
}

function mergeAircraft(results) {
  const aircraftMap = new Map();

  for (const result of results) {
    for (const plane of result.aircraft) {
      const previous = aircraftMap.get(plane.hex);

      if (!previous) {
        aircraftMap.set(plane.hex, plane);
        continue;
      }

      const preferred =
        getAircraftScore(plane) > getAircraftScore(previous)
          ? plane
          : previous;

      const secondary = preferred === plane ? previous : plane;

      const merged = { ...secondary };

      for (const [key, value] of Object.entries(preferred)) {
        if (
          value !== null &&
          value !== undefined &&
          value !== ''
        ) {
          merged[key] = value;
        }
      }

      aircraftMap.set(plane.hex, merged);
    }
  }

  return Array.from(aircraftMap.values());
}

/* ================= ROUTES ================= */

app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store');

  res.json({
    ok: true,
    service: 'Satellite Explorer Aircraft Proxy',
    version: '5.0.0',
    providers: providers.map(p => p.name),
    endpoints: [
      '/',
      '/health',
      '/api/status',
      '/api/aircraft',
      '/api/flights',
      '/flights'
    ]
  });
});

app.get('/health', (req, res) => {
  res.set('Cache-Control', 'no-store');

  res.json({
    ok: true,
    status: 'running',
    version: '5.0.0',
    time: new Date().toISOString()
  });
});

app.get('/api/status', (req, res) => {
  res.set('Cache-Control', 'no-store');

  res.json({
    ok: true,
    version: '5.0.0',
    providers: providerStatus
  });
});

/* ================= AIRCRAFT HANDLER ================= */

async function aircraftHandler(req, res) {
  res.set('Cache-Control', 'no-store');

  const latValue = req.query.lat;
  const lonValue = req.query.lon;
  const distValue = req.query.dist ?? 100;

  if (
    !validNumber(latValue, -90, 90) ||
    !validNumber(lonValue, -180, 180) ||
    !validNumber(distValue, 1, MAX_DISTANCE)
  ) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid coordinates or distance',
      example:
        '/api/aircraft?lat=35.6892&lon=51.3890&dist=100'
    });
  }

  const lat = Number(latValue);
  const lon = Number(lonValue);
  const dist = Number(distValue);

  const results = await Promise.all(
    providers.map(provider =>
      getProviderAircraft(provider, lat, lon, dist)
    )
  );

  const availableSources = results
    .filter(r => r.ok)
    .map(r => r.provider);

  const failedSources = results
    .filter(r => !r.ok)
    .map(r => ({
      provider: r.provider,
      error: r.error
    }));

  const aircraft = mergeAircraft(results);

  const ok = availableSources.length > 0;

  console.log(
    `[AIRCRAFT] ${new Date().toISOString()} ` +
    `lat=${lat} lon=${lon} dist=${dist} ` +
    `planes=${aircraft.length} ` +
    `sources=${availableSources.join(',') || 'none'}`
  );

  return res.status(ok ? 200 : 502).json({
    ok,
    service: 'Satellite Explorer Aircraft Proxy',
    version: '5.0.0',
    ac: aircraft,
    total: aircraft.length,
    source: availableSources.join(',') || null,
    availableSources,
    failedSources,
    now: Date.now()
  });
}

app.get('/api/aircraft', aircraftHandler);
app.get('/api/flights', aircraftHandler);
app.get('/flights', aircraftHandler);

/* ================= 404 ================= */

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: 'Endpoint not found',
    requested: req.originalUrl,
    availableEndpoints: [
      '/',
      '/health',
      '/api/status',
      '/api/aircraft',
      '/api/flights',
      '/flights'
    ]
  });
});

/* ================= ERROR HANDLER ================= */

app.use((err, req, res, next) => {
  console.error('[SERVER ERROR]', err.message);

  if (res.headersSent) {
    return next(err);
  }

  res.status(err.status || 500).json({
    ok: false,
    error: err.status === 403
      ? 'Origin not allowed by CORS'
      : 'Internal server error'
  });
});

/* ================= START ================= */

app.listen(PORT, '0.0.0.0', () => {
  console.log('==========================================');
  console.log('SATELLITE EXPLORER AIRCRAFT PROXY v5.0.0');
  console.log(`Server running on port ${PORT}`);
  console.log('Providers: ADSB.fi + ADSB.lol');
  console.log('==========================================');
});
