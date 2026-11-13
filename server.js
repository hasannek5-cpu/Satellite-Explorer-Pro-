
'use strict';

const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 10000;

const VERSION = '8.0.0';
const TARGET_RADIUS_KM = 2000;
const PROVIDER_DISTANCE_NM = 250;
const PROVIDER_RADIUS_KM = PROVIDER_DISTANCE_NM * 1.852;

const GRID_SPACING_KM = 550;
const BATCH_SIZE = 2;
const MAX_TILE_ATTEMPTS = 3;
const RETRY_DELAY = 15000;
const REQUEST_TIMEOUT = 12000;
const PROVIDER_MIN_INTERVAL = 1100;
const TILE_CACHE_TTL = 15 * 60 * 1000;
const AIRCRAFT_CACHE_TTL = 3 * 60 * 1000;

const PROVIDERS = {
  'adsb.fi': 'https://opendata.adsb.fi/api/v3',
  'adsb.lol': 'https://api.adsb.lol/v2'
};

app.use(cors({
  origin(origin, callback) {
    if (
      !origin ||
      origin === 'https://hasannek5-cpu.github.io'
    ) {
      return callback(null, true);
    }
    callback(new Error('Origin not allowed'));
  }
}));

app.use(express.json({ limit: '1mb' }));

const providerStatus = {};
const providerQueues = {};
const lastProviderRequest = {};

for (const name of Object.keys(PROVIDERS)) {
  providerStatus[name] = {
    available: false,
    requests: 0,
    successes: 0,
    failures: 0,
    aircraft: 0,
    lastCheck: null,
    lastError: null
  };

  providerQueues[name] = Promise.resolve();
  lastProviderRequest[name] = 0;
}

const tileCache = new Map();
const aircraftCache = new Map();
const tileStates = new Map();

let currentScanKey = null;
let currentGrid = [];
let scanCursor = 0;
let scanRunning = false;
let scanQueue = Promise.resolve();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function num(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function rad(value) {
  return value * Math.PI / 180;
}

function deg(value) {
  return value * 180 / Math.PI;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) *
    Math.cos(rad(lat2)) *
    Math.sin(dLon / 2) ** 2;

  return 2 * R * Math.atan2(
    Math.sqrt(a),
    Math.sqrt(1 - a)
  );
}

function destinationPoint(lat, lon, northKm, eastKm) {
  const distance = Math.hypot(northKm, eastKm);
  if (!distance) return { lat, lon };

  const bearing = Math.atan2(eastKm, northKm);
  const angular = distance / 6371;

  const lat1 = rad(lat);
  const lon1 = rad(lon);

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angular) +
    Math.cos(lat1) * Math.sin(angular) *
    Math.cos(bearing)
  );

  const lon2 = lon1 + Math.atan2(
    Math.sin(bearing) * Math.sin(angular) *
    Math.cos(lat1),
    Math.cos(angular) -
    Math.sin(lat1) * Math.sin(lat2)
  );

  return {
    lat: deg(lat2),
    lon: ((deg(lon2) + 540) % 360) - 180
  };
}

function normalizeAircraft(raw, source) {
  if (!raw || typeof raw !== 'object') return null;

  const lat = num(raw.lat ?? raw.latitude);
  const lon = num(raw.lon ?? raw.longitude);

  if (
    lat === null || lon === null ||
    lat < -90 || lat > 90 ||
    lon < -180 || lon > 180
  ) return null;

  const hex = String(
    raw.hex || raw.icao || raw.icao24 || ''
  ).trim().toLowerCase();

  if (!hex) return null;

  return {
    hex,
    flight: String(raw.flight || raw.callsign || '').trim(),
    lat,
    lon,
    altitude: num(
      raw.alt_baro ?? raw.altitude ??
      raw.altitude_baro ?? raw.alt_geom
    ),
    altitude_geom: num(raw.alt_geom),
    speed: num(raw.gs ?? raw.speed ?? raw.velocity),
    track: num(raw.track ?? raw.heading),
    vertical_rate: num(raw.baro_rate ?? raw.vertical_rate),
    squawk: raw.squawk || null,
    category: raw.category || null,
    registration: raw.r || raw.registration || null,
    aircraft_type: raw.t || raw.type || null,
    emergency: raw.emergency || null,
    on_ground: raw.ground === true || raw.on_ground === true,
    seen: num(raw.seen),
    seen_pos: num(raw.seen_pos),
    sources: [source],
    updatedAt: Date.now()
  };
}

function mergeAircraft(oldPlane, newPlane) {
  if (!oldPlane) return newPlane;

  const newer = newPlane.updatedAt >= oldPlane.updatedAt
    ? newPlane
    : oldPlane;

  const older = newer === newPlane ? oldPlane : newPlane;
  const merged = { ...older, ...newer };

  for (const key of Object.keys(merged)) {
    if (
      merged[key] === null ||
      merged[key] === undefined ||
      merged[key] === ''
    ) {
      merged[key] = older[key] ?? null;
    }
  }

  merged.sources = [
    ...new Set([
      ...(oldPlane.sources || []),
      ...(newPlane.sources || [])
    ])
  ];

  merged.updatedAt = Math.max(
    oldPlane.updatedAt,
    newPlane.updatedAt
  );

  return merged;
}

function rememberAircraft(planes) {
  for (const plane of planes) {
    const old = aircraftCache.get(plane.hex);
    aircraftCache.set(
      plane.hex,
      mergeAircraft(old, plane)
    );
  }
}

function scheduleProviderRequest(name, operation) {
  const task = providerQueues[name]
    .catch(() => undefined)
    .then(async () => {
      const wait = Math.max(
        0,
        PROVIDER_MIN_INTERVAL -
        (Date.now() - lastProviderRequest[name])
      );

      if (wait) await sleep(wait);

      lastProviderRequest[name] = Date.now();
      return operation();
    });

  providerQueues[name] = task.then(
    () => undefined,
    () => undefined
  );

  return task;
}

async function getProviderAircraft(name, lat, lon) {
  return scheduleProviderRequest(name, async () => {
    const url =
      `${PROVIDERS[name]}/lat/${lat}/lon/${lon}/dist/${PROVIDER_DISTANCE_NM}`;

    const status = providerStatus[name];
    status.requests++;
    status.lastCheck = new Date().toISOString();

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT
    );

    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'SatelliteExplorerPro/8.0'
        },
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();

      const raw = Array.isArray(data.ac)
        ? data.ac
        : Array.isArray(data.aircraft)
          ? data.aircraft
          : [];

      const planes = raw
        .map(item => normalizeAircraft(item, name))
        .filter(Boolean);

      status.available = true;
      status.successes++;
      status.aircraft = planes.length;
      status.lastError = null;

      return { ok: true, planes };

    } catch (error) {
      status.available = false;
      status.failures++;
      status.lastError = error.message;

      return {
        ok: false,
        planes: [],
        error: error.message
      };

    } finally {
      clearTimeout(timeout);
    }
  });
}

function generateGrid(centerLat, centerLon, radiusKm) {
  const grid = [];
  const coverageRadius =
    radiusKm + PROVIDER_RADIUS_KM + 50;

  const spacing = GRID_SPACING_KM;
  const rowStep = spacing * Math.sqrt(3) / 2;
  const maxRows = Math.ceil(coverageRadius / rowStep);
  const maxCols = Math.ceil(coverageRadius / spacing);
  const seen = new Set();

  for (let row = -maxRows; row <= maxRows; row++) {
    const north = row * rowStep;
    const offset = Math.abs(row % 2) * spacing / 2;

    for (
      let col = -maxCols - 1;
      col <= maxCols + 1;
      col++
    ) {
      const east = col * spacing + offset;

      if (Math.hypot(north, east) > coverageRadius) {
        continue;
      }

      const point = destinationPoint(
        centerLat,
        centerLon,
        north,
        east
      );

      const key =
        `${point.lat.toFixed(4)},${point.lon.toFixed(4)}`;

      if (seen.has(key)) continue;
      seen.add(key);

      grid.push({
        lat: Number(point.lat.toFixed(5)),
        lon: Number(point.lon.toFixed(5))
      });
    }
  }

  return grid;
}

function initializeScan(lat, lon, radiusKm) {
  const key =
    `${lat.toFixed(3)}:${lon.toFixed(3)}:${radiusKm}`;

  if (currentScanKey === key) return;

  currentScanKey = key;
  currentGrid = generateGrid(lat, lon, radiusKm);
  scanCursor = 0;

  tileStates.clear();
  aircraftCache.clear();

  for (let i = 0; i < currentGrid.length; i++) {
    tileStates.set(i, {
      status: 'pending',
      attempts: 0,
      retryAt: 0,
      lastError: null
    });
  }
}

async function scanTile(index) {
  const point = currentGrid[index];
  if (!point) return { ok: false, error: 'Invalid tile' };

  const cacheKey = `${currentScanKey}:${index}`;
  const cached = tileCache.get(cacheKey);

  if (
    cached &&
    Date.now() - cached.timestamp < TILE_CACHE_TTL
  ) {
    rememberAircraft(cached.planes);
    return { ok: true, cached: true };
  }

  // هر دو منبع مستقل فراخوانی می‌شوند.
  const results = await Promise.all([
    getProviderAircraft('adsb.fi', point.lat, point.lon),
    getProviderAircraft('adsb.lol', point.lat, point.lon)
  ]);

  const successful = results.filter(item => item.ok);

  if (!successful.length) {
    return {
      ok: false,
      error: 'Both providers failed'
    };
  }

  const merged = new Map();

  for (const result of successful) {
    for (const plane of result.planes) {
      merged.set(
        plane.hex,
        mergeAircraft(merged.get(plane.hex), plane)
      );
    }
  }

  const planes = [...merged.values()];

  rememberAircraft(planes);

  tileCache.set(cacheKey, {
    timestamp: Date.now(),
    planes
  });

  return {
    ok: true,
    count: planes.length,
    providersSucceeded: successful.length
  };
}

async function performBatch() {
  if (!currentGrid.length) return;

  scanRunning = true;

  try {
    let processed = 0;
    let checked = 0;

    while (
      processed < BATCH_SIZE &&
      checked < currentGrid.length
    ) {
      const index = scanCursor;
      scanCursor = (scanCursor + 1) % currentGrid.length;
      checked++;

      const state = tileStates.get(index);
      if (!state || state.status === 'success') continue;
      if (state.status === 'failed') continue;

      if (state.retryAt && Date.now() < state.retryAt) {
        continue;
      }

      processed++;
      state.attempts++;

      const result = await scanTile(index);

      if (result.ok) {
        state.status = 'success';
        state.retryAt = 0;
        state.lastError = null;

      } else if (state.attempts >= MAX_TILE_ATTEMPTS) {
        state.status = 'failed';
        state.retryAt = 0;
        state.lastError = result.error;

      } else {
        state.status = 'pending';
        state.retryAt = Date.now() + RETRY_DELAY;
        state.lastError = result.error;
      }

      tileStates.set(index, state);
    }

  } finally {
    scanRunning = false;
  }
}

function runScan(lat, lon, radiusKm) {
  const task = scanQueue
    .catch(() => undefined)
    .then(async () => {
      initializeScan(lat, lon, radiusKm);
      await performBatch();
    });

  scanQueue = task.catch(() => undefined);
  return task;
}

function getScanStatus() {
  let successful = 0;
  let failed = 0;
  let pending = 0;

  for (const state of tileStates.values()) {
    if (state.status === 'success') successful++;
    else if (state.status === 'failed') failed++;
    else pending++;
  }

  const total = currentGrid.length;
  const processed = successful + failed;

  return {
    totalTiles: total,
    scannedTiles: successful,
    successful,
    failed,
    pending,
    processed,
    progressPercent: total
      ? Math.round(processed / total * 100)
      : 0,
    complete: total > 0 && processed === total,
    coverageComplete: total > 0 && successful === total,
    batchSize: BATCH_SIZE,
    running: scanRunning
  };
}

function cleanupCaches() {
  const now = Date.now();

  for (const [key, value] of tileCache.entries()) {
    if (now - value.timestamp > TILE_CACHE_TTL) {
      tileCache.delete(key);

      if (currentScanKey && key.startsWith(currentScanKey + ':')) {
        const index = Number(
          key.slice(currentScanKey.length + 1)
        );

        const state = tileStates.get(index);

        if (state && state.status === 'success') {
          state.status = 'pending';
          state.attempts = 0;
          state.retryAt = 0;
        }
      }
    }
  }

  for (const [hex, plane] of aircraftCache.entries()) {
    if (now - plane.updatedAt > AIRCRAFT_CACHE_TTL) {
      aircraftCache.delete(hex);
    }
  }

  if (tileCache.size > 5000) {
    const sorted = [...tileCache.entries()].sort(
      (a, b) => a[1].timestamp - b[1].timestamp
    );

    for (const [key] of sorted.slice(0, tileCache.size - 4000)) {
      tileCache.delete(key);
    }
  }
}

setInterval(cleanupCaches, 30000);

async function aircraftHandler(req, res) {
  try {
    const lat = num(req.query.lat);
    const lon = num(req.query.lon);

    if (lat === null || lon === null) {
      return res.status(400).json({
        ok: false,
        error: 'Valid lat and lon are required'
      });
    }

    if (
      lat < -90 || lat > 90 ||
      lon < -180 || lon > 180
    ) {
      return res.status(400).json({
        ok: false,
        error: 'Coordinates out of range'
      });
    }

    let radiusKm = TARGET_RADIUS_KM;

    if (req.query.radiusKm !== undefined) {
      radiusKm = num(req.query.radiusKm);

    } else if (req.query.dist !== undefined) {
      const dist = num(req.query.dist);

      if (dist === null || dist <= 0) {
        return res.status(400).json({
          ok: false,
          error: 'Invalid dist parameter'
        });
      }

      radiusKm = dist <= 250 ? dist * 1.852 : dist;
    }

    if (
      radiusKm === null ||
      radiusKm <= 0 ||
      radiusKm > TARGET_RADIUS_KM
    ) {
      return res.status(400).json({
        ok: false,
        error: `radiusKm must be between 1 and ${TARGET_RADIUS_KM}`
      });
    }

    await runScan(lat, lon, radiusKm);

    const scan = getScanStatus();
    const now = Date.now();
    const aircraft = [];

    for (const plane of aircraftCache.values()) {
      if (now - plane.updatedAt > AIRCRAFT_CACHE_TTL) continue;

      const distanceKm = haversineKm(
        lat, lon, plane.lat, plane.lon
      );

      if (distanceKm <= radiusKm) {
        aircraft.push({
          ...plane,
          distanceKm: Number(distanceKm.toFixed(1))
        });
      }
    }

    aircraft.sort((a, b) => a.distanceKm - b.distanceKm);

    const activeSources = Object.keys(PROVIDERS).filter(
      name => providerStatus[name].available
    );

    const ok = activeSources.length > 0;

    return res.status(ok ? 200 : 502).json({
      ok,
      version: VERSION,
      center: { lat, lon },
      radiusKm,
      count: aircraft.length,
      ac: aircraft,
      coverage: {
        ...scan,
        targetRadiusKm: radiusKm,
        providerRadiusKm: PROVIDER_RADIUS_KM
      },
      sources: activeSources,
      providers: providerStatus,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Aircraft API error:', error);

    return res.status(500).json({
      ok: false,
      error: 'Internal server error',
      message: error.message
    });
  }
}

app.get('/', (req, res) => {
  res.json({
    service: 'Satellite Explorer Pro Aircraft Server',
    version: VERSION,
    status: 'online',
    targetRadiusKm: TARGET_RADIUS_KM,
    providers: Object.keys(PROVIDERS),
    endpoints: [
      '/health',
      '/api/status',
      '/api/aircraft?lat=35.7&lon=51.4&radiusKm=2000'
    ]
  });
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    version: VERSION,
    service: 'Satellite Explorer Pro'
  });
});

app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    version: VERSION,
    scan: getScanStatus(),
    providers: providerStatus,
    targetRadiusKm: TARGET_RADIUS_KM,
    providerRadiusKm: PROVIDER_RADIUS_KM,
    gridSpacingKm: GRID_SPACING_KM,
    timestamp: new Date().toISOString()
  });
});

app.get('/api/aircraft', aircraftHandler);
app.get('/api/flights', aircraftHandler);
app.get('/flights', aircraftHandler);

app.use((error, req, res, next) => {
  console.error('Server error:', error);

  if (res.headersSent) return next(error);

  res.status(500).json({
    ok: false,
    error: error.message || 'Server error'
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('======================================');
  console.log('SATELLITE EXPLORER PRO AIRCRAFT SERVER');
  console.log('VERSION:', VERSION);
  console.log('PORT:', PORT);
  console.log('TARGET RADIUS:', TARGET_RADIUS_KM, 'KM');
  console.log('PROVIDERS:', Object.keys(PROVIDERS).join(', '));
  console.log('======================================');
});
