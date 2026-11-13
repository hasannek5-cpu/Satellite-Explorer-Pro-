
/* =========================================================
   SATELLITE EXPLORER PRO-1
   GLOBAL AIRCRAFT VPN SERVER
   ADSB.FI + ADSB.LOL
   VERSION 7.0.0
   TARGET RADIUS: 8000 KM
   NODE.JS 18+
   ========================================================= */

'use strict';

const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 10000;

app.disable('x-powered-by');

/* ================= CONFIG ================= */

const VERSION = '7.0.0';

const TARGET_RADIUS_KM = 8000;

const MAX_DISTANCE_NM = 250;
const MAX_DISTANCE_KM = 463;

const GRID_SPACING_KM = 600;

const BATCH_SIZE = 2;

const REQUEST_TIMEOUT = 12000;

const PROVIDER_MIN_INTERVAL = 1150;

const TILE_CACHE_TTL = 10 * 60 * 1000;
const AIRCRAFT_CACHE_TTL = 15 * 60 * 1000;

const LOL_EVERY_N_TILES = 4;

const MAX_AIRCRAFT_CACHE = 30000;

const ALLOWED_ORIGINS = [
  'https://hasannek5-cpu.github.io'
];

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

/* ================= STATE ================= */

const providerStatus = {};

for (const provider of providers) {
  providerStatus[provider.name] = {
    available: null,
    lastCheck: null,
    error: null,
    aircraft: 0,
    requests: 0
  };
}

const tileCache = new Map();
const aircraftCache = new Map();

let currentScanKey = null;
let currentGrid = [];
let currentScannedTiles = new Set();

let scanCursor = 0;
let scanLock = null;
let tileCounter = 0;

const lastProviderRequest = {
  'adsb.fi': 0,
  'adsb.lol': 0
};

/* ================= HELPERS ================= */

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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

function normalizeLongitude(lon) {
  return ((lon + 540) % 360) - 180;
}

/* ================= GEOGRAPHY ================= */

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
    lon: normalizeLongitude(deg(lon2))
  };
}

function generateGrid(centerLat, centerLon, radiusKm) {
  const points = [];

  const maxSteps = Math.ceil(
    radiusKm / GRID_SPACING_KM
  );

  for (let y = -maxSteps; y <= maxSteps; y++) {
    for (let x = -maxSteps; x <= maxSteps; x++) {
      const east = x * GRID_SPACING_KM;
      const north = y * GRID_SPACING_KM;

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

/* ================= NORMALIZATION ================= */

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

      alt_baro: numericOrNull(a.alt_baro ?? a.altitude),
      alt_geom: numericOrNull(a.alt_geom),

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

/* ================= PROVIDER REQUEST ================= */

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
        'User-Agent': 'SatelliteExplorerPro/7.0'
      },
      signal: controller.signal
    });

    const body = await response.text();

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}: ${body.slice(0, 350)}`
      );
    }

    try {
      return JSON.parse(body);
    } catch {
      throw new Error('Invalid JSON response from provider');
    }

  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('Provider request timeout');
    }

    throw error;

  } finally {
    clearTimeout(timer);
  }
}

async function waitProviderLimit(providerName) {
  const elapsed =
    Date.now() - lastProviderRequest[providerName];

  const wait = Math.max(
    0,
    PROVIDER_MIN_INTERVAL - elapsed
  );

  if (wait > 0) {
    await sleep(wait);
  }

  lastProviderRequest[providerName] = Date.now();
}

async function getProviderAircraft(provider, lat, lon) {
  await waitProviderLimit(provider.name);

  const url =
    `${provider.base}/lat/${lat.toFixed(5)}` +
    `/lon/${lon.toFixed(5)}` +
    `/dist/${MAX_DISTANCE_NM}`;

  providerStatus[provider.name].requests++;

  try {
    const data = await fetchJSON(url);

    const aircraft = normalizeAircraft(
      data,
      provider.name
    );

    providerStatus[provider.name] = {
      ...providerStatus[provider.name],
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
      ...providerStatus[provider.name],
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
    for (const plane of result.aircraft || []) {
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

/* ================= SCAN STATE ================= */

function initializeScan(lat, lon, radiusKm) {
  const key = [
    lat.toFixed(3),
    lon.toFixed(3),
    radiusKm
  ].join(':');

  if (key === currentScanKey) {
    return;
  }

  currentScanKey = key;

  currentGrid = generateGrid(
    lat,
    lon,
    radiusKm
  );

  currentScannedTiles = new Set();

  scanCursor = 0;
  tileCounter = 0;

  aircraftCache.clear();

  console.log(
    `[SCAN] New grid: ${currentGrid.length} tiles`
  );
}

function getTileKey(index) {
  return `${currentScanKey}:${index}`;
}

function isTileCached(index) {
  const item = tileCache.get(getTileKey(index));

  return Boolean(
    item &&
    Date.now() - item.time < TILE_CACHE_TTL
  );
}

/* ================= TILE SCAN ================= */

async function scanTile(tile, index) {
  const key = getTileKey(index);

  const cached = tileCache.get(key);

  if (
    cached &&
    Date.now() - cached.time < TILE_CACHE_TTL
  ) {
    currentScannedTiles.add(index);
    return cached.aircraft;
  }

  const results = [];

  // Primary provider: ADSB.fi
  const primary = await getProviderAircraft(
    providers[0],
    tile.lat,
    tile.lon
  );

  results.push(primary);

  // Secondary provider: limited periodic requests
  tileCounter++;

  if (tileCounter % LOL_EVERY_N_TILES === 0) {
    const secondary = await getProviderAircraft(
      providers[1],
      tile.lat,
      tile.lon
    );

    results.push(secondary);
  }

  const aircraft = mergeAircraft(results);

  tileCache.set(key, {
    time: Date.now(),
    aircraft
  });

  for (const plane of aircraft) {
    const previous = aircraftCache.get(plane.hex);

    const merged = previous
      ? mergeAircraft([
          { aircraft: [previous.plane] },
          { aircraft: [plane] }
        ])[0]
      : plane;

    aircraftCache.set(plane.hex, {
      plane: merged,
      time: Date.now()
    });
  }

  currentScannedTiles.add(index);

  return aircraft;
}

/* ================= BATCH SCAN ================= */

async function performBatch() {
  if (!currentGrid.length) return;

  let completed = 0;
  let checked = 0;

  while (
    checked < currentGrid.length &&
    completed < BATCH_SIZE
  ) {
    const index = scanCursor;

    scanCursor =
      (scanCursor + 1) % currentGrid.length;

    checked++;

    if (isTileCached(index)) {
      currentScannedTiles.add(index);
      continue;
    }

    const tile = currentGrid[index];

    await scanTile(tile, index);

    completed++;
  }
}

async function scanBatch() {
  if (scanLock) {
    await scanLock;
    return;
  }

  scanLock = performBatch();

  try {
    await scanLock;
  } finally {
    scanLock = null;
  }
}

/* ================= CACHE CLEANUP ================= */

function cleanupCache() {
  const now = Date.now();

  for (const [key, item] of tileCache) {
    if (now - item.time > TILE_CACHE_TTL) {
      tileCache.delete(key);

      if (currentScanKey && key.startsWith(currentScanKey + ':')) {
        const index = Number(key.split(':').pop());
        if (Number.isInteger(index)) {
          currentScannedTiles.delete(index);
        }
      }
    }
  }

  for (const [hex, item] of aircraftCache) {
    if (now - item.time > AIRCRAFT_CACHE_TTL) {
      aircraftCache.delete(hex);
    }
  }

  while (aircraftCache.size > MAX_AIRCRAFT_CACHE) {
    const oldest = aircraftCache.keys().next().value;
    aircraftCache.delete(oldest);
  }
}

setInterval(cleanupCache, 30000).unref();

/* ================= ROOT ================= */

app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store');

  res.json({
    ok: true,
    service: 'Satellite Explorer Aircraft Proxy',
    version: VERSION,
    targetRadiusKm: TARGET_RADIUS_KM,
    providerRadiusKm: MAX_DISTANCE_KM,
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

/* ================= HEALTH ================= */

app.get('/health', (req, res) => {
  res.set('Cache-Control', 'no-store');

  res.json({
    ok: true,
    status: 'running',
    version: VERSION,
    time: new Date().toISOString()
  });
});

/* ================= STATUS ================= */

app.get('/api/status', (req, res) => {
  res.set('Cache-Control', 'no-store');

  res.json({
    ok: true,
    version: VERSION,

    targetRadiusKm: TARGET_RADIUS_KM,
    providerRadiusKm: MAX_DISTANCE_KM,

    gridSpacingKm: GRID_SPACING_KM,
    batchSize: BATCH_SIZE,

    totalTiles: currentGrid.length,
    scannedTiles: currentScannedTiles.size,

    progressPercent: currentGrid.length
      ? Math.round(
          currentScannedTiles.size /
          currentGrid.length * 100
        )
      : 0,

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
        '/api/aircraft?lat=35.6892&lon=51.3890&radiusKm=8000'
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

  // radiusKm is always kilometers.
  // Legacy dist values <= 250 are nautical miles.
  const radiusKm =
    req.query.radiusKm !== undefined
      ? radius
      : radius <= MAX_DISTANCE_NM
        ? radius * 1.852
        : radius;

  try {
    initializeScan(lat, lon, radiusKm);

    // Scan only a small number of tiles per request.
    // This prevents sending hundreds of requests at once.
    await scanBatch();

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

    const progress = currentGrid.length
      ? Math.round(
          currentScannedTiles.size /
          currentGrid.length * 100
        )
      : 0;

    const ok = availableSources.length > 0;

    console.log(
      `[AIRCRAFT] ${new Date().toISOString()} ` +
      `lat=${lat} lon=${lon} ` +
      `radius=${radiusKm}km ` +
      `grid=${currentGrid.length} ` +
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

        gridSpacingKm: GRID_SPACING_KM,

        totalTiles: currentGrid.length,
        scannedTiles: currentScannedTiles.size,

        progressPercent: progress,

        batchSize: BATCH_SIZE,

        complete:
          currentGrid.length > 0 &&
          currentScannedTiles.size >= currentGrid.length
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

/* ================= ROUTES ================= */

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
  console.log(`GRID SPACING: ${GRID_SPACING_KM} KM`);
  console.log(`BATCH SIZE: ${BATCH_SIZE}`);
  console.log('PROVIDERS: ADSB.FI + ADSB.LOL');
  console.log(`SERVER PORT: ${PORT}`);
  console.log('==========================================');
});
