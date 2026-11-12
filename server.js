
/* =========================================================
   SATELLITE EXPLORER PRO
   AIRCRAFT PROXY SERVER
   ADSB.FI + ADSB.LOL
   VERSION 4.0.0
   Node.js 18+
   ========================================================= */

'use strict';

const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 10000;

app.disable('x-powered-by');

/* =========================================================
   CORS
   ========================================================= */

const allowedOrigins = [
  'https://hasannek5-cpu.github.io'
];

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error('Origin not allowed by CORS'));
  },
  methods: ['GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));

app.use(express.json({ limit: '20kb' }));

/* =========================================================
   SERVER CONFIGURATION
   ========================================================= */

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

const providerStatus = {
  'adsb.fi': {
    available: null,
    lastCheck: null,
    error: null
  },
  'adsb.lol': {
    available: null,
    lastCheck: null,
    error: null
  }
};

/* =========================================================
   BASIC ROUTES
   ========================================================= */

app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'Satellite Explorer Aircraft Proxy',
    version: '4.0.0',
    providers: providers.map(p => p.name),
    endpoints: [
      '/health',
      '/api/status',
      '/api/aircraft',
      '/flights'
    ]
  });
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    status: 'running',
    service: 'Satellite Explorer Aircraft Proxy',
    time: new Date().toISOString()
  });
});

app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    version: '4.0.0',
    providers: providerStatus
  });
});

/* =========================================================
   VALIDATION
   ========================================================= */

function validNumber(value, min, max) {
  if (
    value === undefined ||
    value === null ||
    value === ''
  ) {
    return false;
  }

  const n = Number(value);

  return Number.isFinite(n) &&
    n >= min &&
    n <= max;
}

function numericOrNull(value) {
  if (
    value === undefined ||
    value === null ||
    value === ''
  ) {
    return null;
  }

  const n = Number(value);

  return Number.isFinite(n) ? n : null;
}

function altitudeOrNull(value) {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const n = Number(value);

    return Number.isFinite(n) ? n : value;
  }

  return null;
}

/* =========================================================
   FETCH JSON WITH TIMEOUT
   ========================================================= */

async function fetchJSON(url) {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT);

  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'SatelliteExplorer/4.0'
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.json();

  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('Request timeout');
    }

    throw error;

  } finally {
    clearTimeout(timer);
  }
}

/* =========================================================
   NORMALIZE AIRCRAFT
   ========================================================= */

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

    const flight = String(
      a.flight || a.callsign || ''
    ).trim();

    return {
      hex,
      flight,

      lat,
      lon,

      alt_baro: altitudeOrNull(
        a.alt_baro ?? a.altitude
      ),

      alt_geom: altitudeOrNull(a.alt_geom),

      gs: numericOrNull(a.gs ?? a.speed),

      track: numericOrNull(
        a.track ?? a.heading
      ),

      squawk: a.squawk ?? null,

      category: a.category ?? null,

      seen: numericOrNull(a.seen),

      seen_pos: numericOrNull(a.seen_pos),

      gnd: Boolean(a.gnd ?? a.on_ground ?? false),

      r: a.r ?? a.registration ?? null,

      t: a.t ?? a.type ?? null,

      desc: a.desc ?? a.description ?? null,

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

/* =========================================================
   PROVIDER REQUEST
   ========================================================= */

async function getProviderAircraft(provider, lat, lon, dist) {
  const url =
    `${provider.base}/lat/${lat}/lon/${lon}/dist/${dist}`;

  try {
    const data = await fetchJSON(url);

    const aircraft = normalizeAircraft(
      data,
      provider.name
    );

    providerStatus[provider.name] = {
      available: true,
      lastCheck: new Date().toISOString(),
      error: null
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
      error: error.message
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

/* =========================================================
   MERGE AIRCRAFT
   ========================================================= */

function mergeAircraft(results) {
  const aircraftMap = new Map();

  for (const result of results) {
    for (const plane of result.aircraft) {
      const previous = aircraftMap.get(plane.hex);

      if (!previous) {
        aircraftMap.set(plane.hex, plane);
        continue;
      }

      const previousScore = getAircraftScore(previous);
      const currentScore = getAircraftScore(plane);

      if (currentScore > previousScore) {
        aircraftMap.set(plane.hex, {
          ...previous,
          ...plane
        });
      }
    }
  }

  return Array.from(aircraftMap.values());
}

function getAircraftScore(plane) {
  let score = 0;

  if (plane.flight) score += 2;
  if (plane.alt_baro !== null) score++;
  if (plane.gs !== null) score++;
  if (plane.track !== null) score++;
  if (plane.r) score++;
  if (plane.t) score++;
  if (plane.category) score++;

  return score;
}

/* =========================================================
   AIRCRAFT API HANDLER
   ========================================================= */

async function aircraftHandler(req, res) {
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
    .filter(result => result.ok)
    .map(result => result.provider);

  const failedSources = results
    .filter(result => !result.ok)
    .map(result => ({
      provider: result.provider,
      error: result.error
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

    version: '4.0.0',

    ac: aircraft,

    total: aircraft.length,

    source: availableSources.join(',') || null,

    availableSources,

    failedSources,

    now: Date.now()
  });
}

/* =========================================================
   AIRCRAFT ENDPOINTS
   ========================================================= */

// Main API
app.get('/api/aircraft', aircraftHandler);

// Compatible endpoint for older frontend modules
app.get('/flights', aircraftHandler);

// Additional compatibility endpoint
app.get('/api/flights', aircraftHandler);

/* =========================================================
   404 HANDLER
   ========================================================= */

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

/* =========================================================
   ERROR HANDLER
   ========================================================= */

app.use((err, req, res, next) => {
  console.error('[SERVER ERROR]', err.message);

  if (res.headersSent) {
    return next(err);
  }

  res.status(500).json({
    ok: false,
    error: 'Internal server error'
  });
});

/* =========================================================
   START SERVER
   ========================================================= */

app.listen(PORT, '0.0.0.0', () => {
  console.log(
    '=========================================='
  );

  console.log(
    'SATELLITE EXPLORER AIRCRAFT PROXY v4.0.0'
  );

  console.log(
    `Server running on port ${PORT}`
  );

  console.log(
    'Providers: ADSB.fi + ADSB.lol'
  );

  console.log(
    '=========================================='
  );
});
