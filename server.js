
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
  methods: ['GET'],
  allowedHeaders: ['Accept']
}));

const TIMEOUT = 8000;
const CACHE_TIME = 10000;

let cache = {
  key: '',
  expires: 0,
  data: null
};

app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'Satellite Explorer Aircraft Proxy',
    version: '3.0',
    endpoint: '/api/aircraft?lat=52.52&lon=13.405&dist=250'
  });
});

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

async function getAircraft(url, provider) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);

  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'SatelliteExplorer/3.0'
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error('HTTP ' + response.status);
    }

    const json = await response.json();

    // Normalize different provider response formats
    let aircraft = [];

    if (Array.isArray(json.ac)) {
      aircraft = json.ac;
    } else if (Array.isArray(json.aircraft)) {
      aircraft = json.aircraft;
    } else {
      throw new Error('Unknown response format');
    }

    console.log(
      '[AIRCRAFT] ' + provider +
      ' returned ' + aircraft.length + ' aircraft'
    );

    return {
      aircraft,
      provider
    };

  } finally {
    clearTimeout(timer);
  }
}

app.get('/api/aircraft', async (req, res) => {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  const dist = Number(req.query.dist || 250);

  if (
    !Number.isFinite(lat) ||
    lat < -90 || lat > 90 ||
    !Number.isFinite(lon) ||
    lon < -180 || lon > 180 ||
    !Number.isFinite(dist) ||
    dist < 1 || dist > 250
  ) {
    return res.status(400).json({
      error: 'Invalid coordinates or distance'
    });
  }

  const radius = Math.round(dist);

  const key = [
    lat.toFixed(3),
    lon.toFixed(3),
    radius
  ].join(':');

  if (
    cache.key === key &&
    cache.expires > Date.now() &&
    cache.data
  ) {
    return res.json(cache.data);
  }

  const providers = [
    {
      name: 'adsb.lol',
      url:
        `https://api.adsb.lol/v2/point/${lat}/${lon}/${radius}`
    },
    {
      name: 'airplanes.live',
      url:
        `https://api.airplanes.live/v2/point/${lat}/${lon}/${radius}`
    },
    {
      name: 'adsb.fi',
      url:
        `https://opendata.adsb.fi/api/v3/lat/${lat}/lon/${lon}/dist/${radius}`
    }
  ];

  const errors = [];

  for (const provider of providers) {
    try {
      const result = await getAircraft(
        provider.url,
        provider.name
      );

      const aircraft = result.aircraft
        .filter(plane =>
          Number.isFinite(Number(plane.lat)) &&
          Number.isFinite(Number(plane.lon)) &&
          plane.lat !== null &&
          plane.lon !== null
        );

      const output = {
        ac: aircraft,
        total: aircraft.length,
        source: provider.name,
        msg: 'No error',
        now: Date.now()
      };

      cache = {
        key,
        expires: Date.now() + CACHE_TIME,
        data: output
      };

      res.set('Cache-Control', 'no-store');

      return res.json(output);

    } catch (error) {
      console.error(
        '[AIRCRAFT ERROR]',
        provider.name,
        error.message
      );

      errors.push({
        provider: provider.name,
        error: error.name === 'AbortError'
          ? 'Timeout'
          : error.message
      });
    }
  }

  return res.status(502).json({
    ok: false,
    error: 'Could not retrieve aircraft data',
    providers: errors
  });
});

app.use((err, req, res, next) => {
  console.error('[SERVER]', err.message);

  res.status(
    err.message === 'Origin not allowed by CORS'
      ? 403
      : 500
  ).json({
    error: err.message
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(
    'Satellite Explorer Aircraft Proxy running on ' + PORT
  );
});
