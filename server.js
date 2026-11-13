
/* =========================================================
   SATELLITE EXPLORER PRO-1
   GLOBAL AIRCRAFT PROXY SERVER
   ADSB.FI + ADSB.LOL
   VERSION 7.1.0
   TARGET RADIUS: 8000 KM
   NODE.JS 18+
   ========================================================= */

'use strict';

const express = require('express');
const cors = require('cors');

const app = express();
const PORT = Number(process.env.PORT) || 10000;

app.disable('x-powered-by');

/* ================= CONFIG ================= */

const VERSION = '7.1.0';
const TARGET_RADIUS_KM = 8000;

const PROVIDER_DISTANCE_NM = 250;
const PROVIDER_RADIUS_KM = PROVIDER_DISTANCE_NM * 1.852;

const GRID_SPACING_KM = 700;
const BATCH_SIZE = 2;

const REQUEST_TIMEOUT = 10000;
const PROVIDER_MIN_INTERVAL = 1100;

const TILE_CACHE_TTL = 5 * 60 * 1000;
const AIRCRAFT_CACHE_TTL = 90 * 1000;

const MAX_AIRCRAFT_CACHE = 30000;
const MAX_TILE_CACHE = 2500;

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
    return callback(error);
  },
  methods: ['GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));

app.use(express.json({ limit: '20kb' }));

/* ================= STATE ================= */

const providerStatus = Object.fromEntries(
  providers.map(p => [
    p.name,
    {
      available: null,
      lastCheck: null,
      error: null,
      aircraft: 0,
      requests: 0
    }
  ])
);

const tileCache = new Map();
const aircraftCache = new Map();

let currentScanKey = null;
let currentGrid = [];
let currentScannedTiles = new Set();

let scanCursor = 0;
let scanLock = Promise.resolve();

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

  return typeof value === 'string' &&
    ['true', '1', 'yes'].includes(
      value.trim().toLowerCase()
    );
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

/* ================= GRID ================= */

function generateGrid(centerLat, centerLon, radiusKm) {
  const points = [
    { lat: centerLat, lon: centerLon }
  ];

  const rowStep = GRID_SPACING_KM * Math.sqrt(3) / 2;
  const maxRows = Math.ceil(radiusKm / rowStep);

  const seen = new Set([
    `${centerLat.toFixed(4)}:${centerLon.toFixed(4)}`
  ]);

  for (let row = -maxRows; row <= maxRows; row++) {
    const north = row * rowStep;

    const offset = (Math.abs(row) % 2)
      ? GRID_SPACING_KM / 2
      : 0;

    const maxCols = Math.ceil(radiusKm / GRID_SPACING_KM) + 1;

    for (let col = -maxCols; col <= maxCols; col++) {
      const east = col * GRID_SPACING_KM + offset;
      const distance = Math.hypot(east, north);

      if (distance < 1 || distance > radiusKm) continue;

      const bearing =
        (Math.atan2(east, north) * 180 / Math.PI + 360) % 360;

      const point = destinationPoint(
        centerLat,
        centerLon,
        bearing,
        distance
      );

      const key =
        `${point.lat.toFixed(4)}:${point.lon.toFixed(4)}`;

      if (!seen.has(key)) {
        seen.add(key);
        points.push(point);
      }
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

    return {
      hex: String(
        a.hex || a.icao24 || ''
      ).trim().toLowerCase(),

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
        'User-Agent': `SatelliteExplorerPro/${VERSION}`
      },
      signal: controller.signal
    });

    const body = await response.text();

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}: ${body.slice(0, 250)}`
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

async function waitProviderLimit(name) {
  const wait = Math.max(
    0,
    PROVIDER_MIN_INTERVAL -
    (Date.now() - lastProviderRequest[name])
  );

  if (wait) await sleep(wait);

  lastProviderRequest[name] = Date.now();
}

async function getProviderAircraft(provider, lat, lon) {
  await waitProviderLimit(provider.name);

  const url =
    `${provider.base}/lat/${lat.toFixed(5)}` +
    `/lon/${lon.toFixed(5)}` +
    `/dist/${PROVIDER_DISTANCE_NM}`;

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

function aircraftScore(p) {
  let score = 0;

  if (p.flight) score += 3;
  if (p.alt_baro !== null) score++;
  if (p.gs !== null) score++;
  if (p.track !== null) score++;
  if (p.r) score += 2;
  if (p.t) score++;
  if (p.desc) score++;
  if (p.category) score++;
  if (p.seen_pos !== null) score++;

  return score;
}

function mergeAircraft(results) {
  const map = new Map();

  for (const result of results) {
    for (const plane of result.aircraft || []) {
      const old = map.get(plane.hex);

      if (!old) {
        map.set(plane.hex, plane);
        continue;
      }

      const preferred =
        aircraftScore(plane) > aircraftScore(old)
          ? plane
          : old;

      const secondary =
        preferred === plane ? old : plane;

      map.set(plane.hex, {
        ...secondary,
        ...Object.fromEntries(
          Object.entries(preferred).filter(
            ([, value]) =>
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

/* ================= SCAN ================= */

function initializeScan(lat, lon, radiusKm) {
  const key =
    `${lat.toFixed(3)}:${lon.toFixed(3)}:${radiusKm}`;

  if (key === currentScanKey) return;

  currentScanKey = key;

  currentGrid = generateGrid(
    lat,
    lon,
    radiusKm
  );

  currentScannedTiles = new Set();
  scanCursor = 0;

  aircraftCache.clear();

  console.log(
    `[SCAN] New grid: ${currentGrid.length} tiles`
  );
}

function tileKey(index) {
  return `${currentScanKey}:${index}`;
}

function tileIsCached(index) {
  const item = tileCache.get(tileKey(index));

  return Boolean(
    item &&
    Date.now() - item.time < TILE_CACHE_TTL
  );
}

function rememberAircraft(planes) {
  for (const plane of planes) {
    const old = aircraftCache.get(plane.hex);

    const merged = old
      ? mergeAircraft([
          { aircraft: [old.plane] },
          { aircraft: [plane] }
        ])[0]
      : plane;

    aircraftCache.set(plane.hex, {
      plane: merged,
      time: Date.now()
    });
  }
}

async function scanTile(tile, index) {
  const key = tileKey(index);
  const cached = tileCache.get(key);

  if (
    cached &&
    Date.now() - cached.time < TILE_CACHE_TTL
  ) {
    currentScannedTiles.add(index);
    rememberAircraft(cached.aircraft);

    return {
      ok: true,
      aircraft: cached.aircraft,
      cached: true
    };
  }

  const results = [];

  // Primary provider
  const primary = await getProviderAircraft(
    providers[0],
    tile.lat,
    tile.lon
  );

  results.push(primary);

  // Fallback provider if primary fails
  if (!primary.ok) {
    const secondary = await getProviderAircraft(
      providers[1],
      tile.lat,
      tile.lon
    );

    results.push(secondary);
  }

  const planes = mergeAircraft(results);

  if (results.some(r => r.ok)) {
    tileCache.set(key, {
      time: Date.now(),
      aircraft: planes
    });

    while (tileCache.size > MAX_TILE_CACHE) {
      tileCache.delete(tileCache.keys().next().value);
    }

    rememberAircraft(planes);
    currentScannedTiles.add(index);
  }

  return {
    ok: results.some(r => r.ok),
    aircraft: planes,
    cached: false
  };
}

/* ================= BATCH SCAN ================= */

async function performBatch() {
  let completed = 0;
  let checked = 0;
  let successful = 0;

  while (
    checked < currentGrid.length &&
    completed < BATCH_SIZE
  ) {
    const index = scanCursor;

    scanCursor =
      (scanCursor + 1) % currentGrid.length;

    checked++;

    if (tileIsCached(index)) {
      currentScannedTiles.add(index);

      const cached = tileCache.get(tileKey(index));
      rememberAircraft(cached.aircraft);

      successful++;
      continue;
    }

    const result = await scanTile(
      currentGrid[index],
      index
    );

    if (result.ok) successful++;

    completed++;
  }

  return { successful };
}

async function runScan(lat, lon, radiusKm) {
  const task = scanLock.then(async () => {
    initializeScan(lat, lon, radiusKm);
    return performBatch();
  });

  scanLock = task.catch(() => undefined);

  return task;
}

/* ================= CACHE CLEANUP ================= */

function cleanupCache() {
  const now = Date.now();

  for (const [key, item] of tileCache) {
    if (now - item.time > TILE_CACHE_TTL) {
      tileCache.delete(key);

      if (
        currentScanKey &&
        key.startsWith(currentScanKey + ':')
      ) {
        const index = Number(
          key.slice(key.lastIndexOf(':') + 1)
        );

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
    aircraftCache.delete(
      aircraftCache.keys().next().value
    );
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
    providerRadiusKm: PROVIDER_RADIUS_KM,

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

  const total = currentGrid.length;
  const scanned = currentScannedTiles.size;

  res.json({
    ok: true,
    version: VERSION,

    targetRadiusKm: TARGET_RADIUS_KM,
    providerRadiusKm: PROVIDER_RADIUS_KM,
    providerRadiusNm: PROVIDER_DISTANCE_NM,

    gridSpacingKm: GRID_SPACING_KM,
    batchSize: BATCH_SIZE,

    totalTiles: total,
    scannedTiles: scanned,

    progressPercent: total
      ? Math.round(scanned / total * 100)
      : 0,

    providers: providerStatus
  });
});

/* ================= AIRCRAFT HANDLER ================= */

async function aircraftHandler(req, res) {
  res.set('Cache-Control', 'no-store');

  const latValue = req.query.lat ?? req.query.latitude;
  const lonValue = req.query.lon ?? req.query.longitude;

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

  let radiusKm = TARGET_RADIUS_KM;

  if (req.query.radiusKm !== undefined) {
    radiusKm = numericOrNull(req.query.radiusKm);

  } else if (req.query.dist !== undefined) {
    const legacyDist = numericOrNull(req.query.dist);

    radiusKm = legacyDist === null
      ? null
      : (
          legacyDist <= PROVIDER_DISTANCE_NM
            ? legacyDist * 1.852
            : legacyDist
        );
  }

  if (
    radiusKm === null ||
    radiusKm < 1 ||
    radiusKm > TARGET_RADIUS_KM
  ) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid radius',
      minimumKm: 1,
      maximumKm: TARGET_RADIUS_KM,
      note:
        'radiusKm is measured in kilometers; legacy dist values up to 250 are interpreted as nautical miles.'
    });
  }

  try {
    await runScan(lat, lon, radiusKm);

    const now = Date.now();
    const aircraft = [];

    for (const item of aircraftCache.values()) {
      const p = item.plane;

      if (
        now - item.time <= AIRCRAFT_CACHE_TTL &&
        haversine(
          lat,
          lon,
          p.lat,
          p.lon
        ) <= radiusKm
      ) {
        aircraft.push(p);
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

    const total = currentGrid.length;
    const scanned = currentScannedTiles.size;

    const progress = total
      ? Math.round(scanned / total * 100)
      : 0;

    const hasUsableData =
      availableSources.length > 0 ||
      aircraft.length > 0;

    console.log(
      `[AIRCRAFT] lat=${lat} lon=${lon} ` +
      `radius=${radiusKm}km ` +
      `grid=${total} progress=${progress}% ` +
      `planes=${aircraft.length}`
    );

    return res.status(hasUsableData ? 200 : 502).json({
      ok: hasUsableData,

      service: 'Satellite Explorer Aircraft Proxy',
      version: VERSION,

      ac: aircraft,
      total: aircraft.length,

      source: availableSources.join(',') || null,
      availableSources,
      failedSources,

      coverage: {
        targetRadiusKm: radiusKm,

        providerRadiusNm: PROVIDER_DISTANCE_NM,
        providerRadiusKm: PROVIDER_RADIUS_KM,

        gridSpacingKm: GRID_SPACING_KM,

        totalTiles: total,
        scannedTiles: scanned,

        progressPercent: progress,

        batchSize: BATCH_SIZE,

        complete:
          total > 0 &&
          scanned >= total
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

  console.log(
    `PROVIDER RADIUS: ${PROVIDER_DISTANCE_NM} NM (${PROVIDER_RADIUS_KM} KM)`
  );

  console.log(`GRID SPACING: ${GRID_SPACING_KM} KM`);
  console.log(`BATCH SIZE: ${BATCH_SIZE}`);

  console.log('PROVIDERS: ADSB.FI + ADSB.LOL');
  console.log(`SERVER PORT: ${PORT}`);

  console.log('==========================================');
});
