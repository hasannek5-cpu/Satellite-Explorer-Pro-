
/* =========================================================
   SATELLITE EXPLORER PRO
   AIRCRAFT PROXY SERVER
   ADSB.FI + ADSB.LOL
   Node.js 18+
   ========================================================= */

'use strict';

const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 10000;

app.disable('x-powered-by');

app.use(cors({
  origin(origin, callback) {
    const allowedOrigins = [
      'https://hasannek5-cpu.github.io'
    ];

    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error('Origin not allowed by CORS'));
  },
  methods: ['GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));

app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'Satellite Explorer Aircraft Proxy',
    version: '3.0.0',
    providers: ['adsb.fi', 'adsb.lol']
  });
});

/* -------------------------
   Validation
------------------------- */

function validNumber(value, min, max) {
  if (value === undefined || value === null || value === '') {
    return false;
  }

  const n = Number(value);

  return Number.isFinite(n) && n >= min && n <= max;
}

function numericOrNull(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const n = Number(value);

  return Number.isFinite(n) ? n : null;
}

/* -------------------------
   Fetch with timeout
------------------------- */

async function fetchJSON(url) {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, 12000);

  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'SatelliteExplorer/3.0'
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

/* -------------------------
   Normalize aircraft data
------------------------- */

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
      hex: String(a.hex || a.icao24 || '').trim().toLowerCase(),

      flight: String(
        a.flight || a.callsign || ''
      ).trim(),

      lat,
      lon,

      alt_baro: a.alt_baro ?? a.altitude ?? null,
      alt_geom: a.alt_geom ?? null,

      gs: numericOrNull(a.gs ?? a.speed),

      track: numericOrNull(a.track ?? a.heading),

      squawk: a.squawk ?? null,

      category: a.category ?? null,

      seen: numericOrNull(a.seen),
      seen_pos: numericOrNull(a.seen_pos),

      gnd: a.gnd ?? a.on_ground ?? false,

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

/* -------------------------
   ADSB.fi
------------------------- */

async function getADSBfi(lat, lon, dist) {
  const url =
    `https://opendata.adsb.fi/api/v3/lat/${lat}/lon/${lon}/dist/${dist}`;

  const data = await fetchJSON(url);

  return normalizeAircraft(data, 'adsb.fi');
}

/* -------------------------
   ADSB.lol
------------------------- */

async function getADSBLOL(lat, lon, dist) {
  const url =
    `https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/${dist}`;

  const data = await fetchJSON(url);

  return normalizeAircraft(data, 'adsb.lol');
}

/* -------------------------
   Aircraft API
------------------------- */

app.get('/api/aircraft', async (req, res) => {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  const dist = Number(req.query.dist ?? 100);

  if (
    !validNumber(req.query.lat, -90, 90) ||
    !validNumber(req.query.lon, -180, 180) ||
    !validNumber(req.query.dist ?? 100, 1, 250)
  ) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid coordinates or distance',
      example: '/api/aircraft?lat=35.6892&lon=51.3890&dist=100'
    });
  }

  const providers = [
    {
      name: 'adsb.fi',
      run: getADSBfi
    },
    {
      name: 'adsb.lol',
      run: getADSBLOL
    }
  ];

  const results = await Promise.allSettled(
    providers.map(provider =>
      provider.run(lat, lon, dist)
    )
  );

  const aircraft = [];
  const availableSources = [];
  const failedSources = [];
  const seen = new Set();

  results.forEach((result, index) => {
    const provider = providers[index].name;

    if (result.status === 'fulfilled') {
      availableSources.push(provider);

      for (const plane of result.value) {
        if (seen.has(plane.hex)) {
          continue;
        }

        seen.add(plane.hex);
        aircraft.push(plane);
      }

    } else {
      failedSources.push({
        provider,
        error: result.reason?.message || 'Unknown error'
      });
    }
  });

  const ok = availableSources.length > 0;

  console.log(
    `[AIRCRAFT] ${new Date().toISOString()} | ` +
    `lat=${lat} lon=${lon} dist=${dist} | ` +
    `planes=${aircraft.length} | ` +
    `sources=${availableSources.join(',') || 'none'}`
  );

  return res.status(ok ? 200 : 502).json({
    ok,

    ac: aircraft,

    total: aircraft.length,

    source: availableSources.join(',') || null,

    availableSources,

    failedSources,

    now: Date.now()
  });
});

/* -------------------------
   404 handler
------------------------- */

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: 'Endpoint not found'
  });
});

/* -------------------------
   Error handler
------------------------- */

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

/* -------------------------
   Start server
------------------------- */

app.listen(PORT, '0.0.0.0', () => {
  console.log(
    `Satellite Explorer Aircraft Proxy running on port ${PORT}`
  );
});
