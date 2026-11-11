const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 10000;
const ALLOWED_ORIGINS = new Set([
  'https://hasannek5-cpu.github.io'
]);

app.disable('x-powered-by');

app.use(cors({
  origin(origin, callback) {
    if (!origin || ALLOWED_ORIGINS.has(origin)) return callback(null, true);
    return callback(new Error('Origin not allowed by CORS'));
  },
  methods: ['GET'],
  allowedHeaders: ['Accept']
}));

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'Satellite Explorer Aircraft Proxy',
    endpoint: '/api/aircraft?lat=52.52&lon=13.405&dist=250'
  });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

let cache = { key: '', expires: 0, data: null };

app.get('/api/aircraft', async (req, res) => {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  const dist = Number(req.query.dist || 250);

  if (!Number.isFinite(lat) || lat < -90 || lat > 90 ||
      !Number.isFinite(lon) || lon < -180 || lon > 180 ||
      !Number.isFinite(dist) || dist < 1 || dist > 250) {
    return res.status(400).json({
      error: 'Invalid coordinates or distance. dist must be 1..250 nautical miles.'
    });
  }

  const key = [lat.toFixed(2), lon.toFixed(2), Math.round(dist)].join(':');
  if (cache.key === key && cache.expires > Date.now() && cache.data) {
    res.set('Cache-Control', 'no-store');
    return res.json(cache.data);
  }

  try {
    const upstream =
      'https://api.adsb.lol/v2/lat/' + encodeURIComponent(lat) +
      '/lon/' + encodeURIComponent(lon) +
      '/dist/' + encodeURIComponent(Math.round(dist));

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    let response;
    try {
      response = await fetch(upstream, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'SatelliteExplorer/1.0'
        },
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      return res.status(502).json({
        error: 'Aircraft data provider returned HTTP ' + response.status
      });
    }

    const data = await response.json();
    if (!data || !Array.isArray(data.ac)) {
      return res.status(502).json({
        error: 'Invalid aircraft provider response'
      });
    }

    cache = { key, expires: Date.now() + 12000, data };
    res.set('Cache-Control', 'no-store');
    return res.json(data);
  } catch (error) {
    console.error('Aircraft provider error:', error);
    return res.status(502).json({
      error: error.name === 'AbortError'
        ? 'Aircraft provider timeout'
        : 'Could not retrieve aircraft data'
    });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('Aircraft proxy listening on port ' + PORT);
});
