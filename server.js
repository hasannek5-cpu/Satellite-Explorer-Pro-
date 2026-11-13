
/* =========================================================
   SATELLITE EXPLORER PRO-1
   GLOBAL AIRCRAFT PROXY SERVER
   ADSB.FI + ADSB.LOL
   VERSION 6.0.0
   TARGET RADIUS: 8000 KM
   NODE.JS 18+
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

const VERSION = '6.0.0';

const TARGET_RADIUS_KM = 8000;

// Maximum provider radius: 250 nautical miles
const MAX_DISTANCE_NM = 250;
const MAX_DISTANCE_KM = 463;

// Grid spacing, with overlapping coverage
const GRID_X_KM = 400;
const GRID_Y_KM = 350;

// Six locations per API request
const BATCH_SIZE = 6;

const REQUEST_TIMEOUT = 12000;
const TILE_CACHE_TTL = 30000;
const AIRCRAFT_CACHE_TTL = 60000;

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

const tileCache = new Map();
const aircraftCache = new Map();

let scanCursor = 0;
let scannedTiles = new Set();

/* ================= HELPERS ================= */

function numericOrNull(value) {
  if (
    value === null ||
    value === undefined ||
    value === '' ||
    value === 'ground'
  ) {
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

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;

  const rad = n => n * Math.PI / 180;

  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) *
    Math.cos(rad(lat2)) *
    Math.sin(dLon / 2) ** 2;

  return 2 * R * Math.asin(
    Math.sqrt(Math.min(1, a))
  );
}

/* ================= GRID GENERATOR ================= */

function destinationPoint(lat, lon, bearing, distanceKm) {
  const R = 6371;

  const rad = n => n * Math.PI / 180;
  const deg = n => n * 180 / Math.PI;

  const angular = distanceKm / R;
  const brng = rad(bearing);

  const lat1 = rad(lat);
  const lon1 = rad(lon);

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angular) +
    Math.cos(lat1) * Math.sin(angular) *
    Math.cos(brng)
  );

  const lon2 = lon1 + Math.atan2(
    Math.sin(brng) * Math.sin(angular) *
    Math.cos(lat1),
    Math.cos(angular) -
    Math.sin(lat1) * Math.sin(lat2)
  );

  return {
    lat: deg(lat2),
    lon: ((deg(lon2) + 540) % 360) - 180
  };
}

function generateGrid(centerLat, centerLon, radiusKm) {
  const points = [];

  const maxY = Math.ceil(radiusKm / GRID_Y_KM);
  const maxX = Math.ceil(radiusKm / GRID_X_KM);

  for (let y = -maxY; y <= maxY; y++) {
    for (let x = -maxX; x <= maxX; x++) {
      const east = x * GRID_X_KM;
      const north = y * GRID_Y_KM;

      const distance = Math.hypot(east, north);

      if (distance > radiusKm) continue;

      if (distance === 0) {
        points.push({
          lat: centerLat,
          lon: centerLon
        });

        continue;
      }

      const bearing =
        (Math.atan2(east, north) * 180 / Math.PI + 360) % 360;

      points.push(
        destinationPoint(
          centerLat,
          centerLon,
          bearing,
          distance
        )
      );
    }
  }

  return points;
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
        'User-Agent': 'SatelliteExplorerPro/6.0'
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
    validNumber(a.lat, -90, 90) &&
    validNumber(a.lon, -180, 180)
  );
}

/* ================= PROVIDER ================= */

async function getProviderAircraft(provider, lat, lon) {
  const url =
    `${provider.base}/lat/${lat}/lon/${lon}/dist/${MAX_DISTANCE_NM}`;

  try {
    const data = await fetchJSON(url);

    const aircraft = normalizeAircraft(
      data,
      provider.name
    );

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
  const map = new Map();

  for (const result of results) {
    for (const plane of result.aircraft) {
      const previous = map.get(plane.hex);

      if (!previous) {
        map.set(plane.hex, plane);
        continue;
      }

      const preferred =
        getAircraftScore(plane) >
        getAircraftScore(previous)
          ? plane
          : previous;

      const secondary =
        preferred === plane ? previous : plane;

      map.set(plane.hex, {
        ...secondary,
        ...Object.fromEntries(
          Object.entries(preferred).filter(
            ([key, value]) =>
              value !== null &&
              value !== undefined &&
              value !== ''
          )
        )
      });
    }
  }

  return Array.from(map.values());
}

/* ================= TILE SCANNING ================= */

async function scanTile(tile, index) {
  const now = Date.now();

  const cached = tileCache.get(index);

  if (
    cached &&
    now - cached.time < TILE_CACHE_TTL
  ) {
    return cached.aircraft;
  }

  const results = await Promise.all(
    providers.map(provider =>
      getProviderAircraft(
        provider,
        tile.lat,
        tile.lon
      )
    )
  );

  const aircraft = mergeAircraft(results);

  tileCache.set(index, {
    time: Date.now(),
    aircraft
  });

  for (const plane of aircraft) {
    aircraftCache.set(plane.hex, {
      plane,
      time: Date.now()
    });
  }

  return aircraft;
}

async function scanBatch(grid) {
  const selected = [];

  let checked = 0;

  for (
    let i = 0;
    i < grid.length && checked < grid.length;
    i++
  ) {
    const index = scanCursor % grid.length;

    scanCursor = (scanCursor + 1) % grid.length;
    checked++;

    const cached = tileCache.get(index);

    if (
      cached &&
      Date.now() - cached.time < TILE_CACHE_TTL
    ) {
      continue;
    }

    selected.push({
      tile: grid[index],
      index
    });

    if (selected.length >= BATCH_SIZE) break;
  }

  const results = await Promise.all(
    selected.map(item =>
      scanTile(item.tile, item.index)
    )
  );

  for (const item of selected) {
    scannedTiles.add(item.index);
  }

  if (scannedTiles.size >= grid.length) {
    scannedTiles.clear();
  }

  return mergeAircraft(
    results.map(aircraft => ({
      aircraft
    }))
  );
}

/* ================= CACHE CLEANUP ================= */

function cleanupCache() {
  const now = Date.now();

  for (const [hex, item] of aircraftCache) {
    if (
      now - item.time > AIRCRAFT_CACHE_TTL
    ) {
      aircraftCache.delete(hex);
    }
  }

  for (const [index, item] of tileCache) {
    if (
      now - item.time > TILE_CACHE_TTL
    ) {
      tileCache.delete(index);
    }
  }
}

setInterval(cleanupCache, 15000).unref();

/* ================= ROUTES ================= */

app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store');

  res.json({
    ok: true,
    service: 'Satellite Explorer Aircraft Proxy',
    version: VERSION,
    targetRadiusKm: TARGET_RADIUS_KM,
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
    version: VERSION,
    time: new Date().toISOString()
  });
});

app.get('/api/status', (req, res) => {
  res.set('Cache-Control', 'no-store');

  res.json({
    ok: true,
    version: VERSION,
    targetRadiusKm: TARGET_RADIUS_KM,
    batchSize: BATCH_SIZE,
    providers: providerStatus
  });
});

/* ================= AIRCRAFT HANDLER ================= */

async function aircraftHandler(req, res) {
  res.set('Cache-Control', 'no-store');

  const latValue = req.query.lat;
  const lonValue = req.query.lon;

  if (
    !validNumber(latValue, -90, 90) ||
    !validNumber(lonValue, -180, 180)
  ) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid coordinates',
      example:
        '/api/aircraft?lat=35.6892&lon=51.3890&dist=8000'
    });
  }

  const lat = Number(latValue);
  const lon = Number(lonValue);

  const radiusValue =
    req.query.radiusKm ??
    req.query.dist ??
    TARGET_RADIUS_KM;

  const radius = numericOrNull(radiusValue);

  if (
    radius === null ||
    radius < 1 ||
    radius > TARGET_RADIUS_KM
  ) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid radius',
      minimumKm: 1,
      maximumKm: TARGET_RADIUS_KM
    });
  }

  // Backward compatibility:
  // Legacy dist values up to 250 mean nautical miles.
  // Larger values and radiusKm mean kilometers.

  const radiusKm =
    req.query.radiusKm !== undefined ||
    radius > MAX_DISTANCE_NM
      ? radius
      : radius * 1.852;

  const grid = generateGrid(
    lat,
    lon,
    radiusKm
  );

  if (!grid.length) {
    return res.status(400).json({
      ok: false,
      error: 'Unable to generate coverage grid'
    });
  }

  try {
    await scanBatch(grid);

    const now = Date.now();

    const aircraft = [];

    for (const item of aircraftCache.values()) {
      if (
        now - item.time <= AIRCRAFT_CACHE_TTL &&
        haversine(
          lat,
          lon,
          item.plane.lat,
          item.plane.lon
        ) <= radiusKm
      ) {
        aircraft.push(item.plane);
      }
    }

    const availableSources = Object.keys(providerStatus)
      .filter(name =>
        providerStatus[name].available === true
      );

    const failedSources = Object.keys(providerStatus)
      .filter(name =>
        providerStatus[name].available === false
      )
      .map(name => ({
        provider: name,
        error: providerStatus[name].error
      }));

    const ok = availableSources.length > 0;

    const progress = Math.round(
      (scannedTiles.size / grid.length) * 100
    );

    console.log(
      `[AIRCRAFT] ${new Date().toISOString()} ` +
      `lat=${lat} lon=${lon} ` +
      `radius=${radiusKm}km ` +
      `grid=${grid.length} ` +
      `progress=${progress}% ` +
      `planes=${aircraft.length}`
    );

    return res.status(ok ? 200 : 502).json({
      ok,
      service: 'Satellite Explorer Aircraft Proxy',
      version: VERSION,

      ac: aircraft,
      total: aircraft.length,

      source: availableSources.join(',') || null,
      availableSources,
      failedSources,

      coverage: {
        targetRadiusKm: radiusKm,
        providerRadiusNm: MAX_DISTANCE_NM,
        providerRadiusKm: MAX_DISTANCE_KM,
        totalTiles: grid.length,
        scannedTiles: scannedTiles.size,
        progressPercent: progress,
        batchSize: BATCH_SIZE,
        complete: scannedTiles.size >= grid.length
      },

      now: Date.now()
    });

  } catch (error) {
    console.error('[AIRCRAFT HANDLER]', error);

    return res.status(502).json({
      ok: false,
      error: 'Aircraft scan failed',
      message: error.message,
      ac: []
    });
  }
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
  console.log('SATELLITE EXPLORER AIRCRAFT PROXY');
  console.log(`VERSION: ${VERSION}`);
  console.log(`TARGET RADIUS: ${TARGET_RADIUS_KM} KM`);
  console.log(`PROVIDER RADIUS: ${MAX_DISTANCE_NM} NM`);
  console.log(`BATCH SIZE: ${BATCH_SIZE}`);
  console.log('PROVIDERS: ADSB.FI + ADSB.LOL');
  console.log(`SERVER PORT: ${PORT}`);
  console.log('==========================================');
});
