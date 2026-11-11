
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 10000;

app.disable('x-powered-by');

app.use(cors({
  origin(origin, callback) {
    if (
      !origin ||
      origin === 'https://hasannek5-cpu.github.io'
    ) {
      return callback(null, true);
    }

    callback(new Error('Origin not allowed by CORS'));
  },
  methods: ['GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));

app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'Satellite Explorer Aircraft Proxy',
    version: '2.0.0'
  });
});

function validNumber(value, min, max) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max;
}

async function fetchJSON(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);

  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'SatelliteExplorer/2.0'
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function normalizeAircraft(data, provider) {
  const list = Array.isArray(data?.ac)
    ? data.ac
    : Array.isArray(data?.aircraft)
      ? data.aircraft
      : [];

  return list.map(a => ({
    hex: String(a.hex || a.icao24 || '').toLowerCase(),
    flight: String(a.flight || a.callsign || '').trim(),
    lat: Number(a.lat),
    lon: Number(a.lon),
    alt_baro: a.alt_baro ?? a.altitude ?? null,
    gs: a.gs ?? a.speed ?? null,
    track: a.track ?? a.heading ?? null,
    squawk: a.squawk ?? null,
    category: a.category ?? null,
    source: provider
  })).filter(a =>
    a.hex &&
    Number.isFinite(a.lat) &&
    Number.isFinite(a.lon) &&
    a.lat >= -90 &&
    a.lat <= 90 &&
    a.lon >= -180 &&
    a.lon <= 180
  );
}

async function getADSBfi(lat, lon, dist) {
  const url =
    `https://opendata.adsb.fi/api/v3/lat/${lat}/lon/${lon}/dist/${dist}`;

  const data = await fetchJSON(url);
  return normalizeAircraft(data, 'adsb.fi');
}

async function getADSBLOL(lat, lon, dist) {
  const url =
    `https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/${dist}`;

  const data = await fetchJSON(url);
  return normalizeAircraft(data, 'adsb.lol');
}

app.get('/api/aircraft', async (req, res) => {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  const dist = Number(req.query.dist ?? 100);

  if (
    !validNumber(lat, -90, 90) ||
    !validNumber(lon, -180, 180) ||
    !validNumber(dist, 1, 250)
  ) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid coordinates or distance',
      example: '/api/aircraft?lat=35.6892&lon=51.3890&dist=100'
    });
  }

  const providers = [
    { name: 'adsb.fi', run: getADSBfi },
    { name: 'adsb.lol', run: getADSBLOL }
  ];

  const results = await Promise.allSettled(
    providers.map(p => p.run(lat, lon, dist))
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
        if (seen.has(plane.hex)) continue;

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

app.listen(PORT, '0.0.0.0', () => {
  console.log(
    `Satellite Explorer aircraft proxy running on port ${PORT}`
  );
});
