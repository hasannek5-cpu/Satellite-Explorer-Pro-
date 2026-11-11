
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 10000;

const ALLOWED_ORIGINS = new Set([
  'https://hasannek5-cpu.github.io'
]);

const CACHE_DURATION = 10000;
const REQUEST_TIMEOUT = 12000;

app.disable('x-powered-by');

app.use(cors({
  origin(origin, callback) {
    if (!origin || ALLOWED_ORIGINS.has(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Origin not allowed by CORS'));
  },
  methods: ['GET'],
  allowedHeaders: ['Accept']
}));

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'Satellite Explorer Aircraft Proxy',
    version: '2.0',
    endpoint: '/api/aircraft?lat=52.52&lon=13.405&dist=250',
    providers: ['adsb.lol', 'airplanes.live', 'adsb.fi']
  });
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'aircraft-proxy'
  });
});

let cache = {
  key: '',
  expires: 0,
  data: null
};

async function fetchProvider(url, name) {
  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'SatelliteExplorer/2.0'
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error('HTTP ' + response.status);
    }

    const data = await response.json();

    if (!data || !Array.isArray(data.ac)) {
      throw new Error('Invalid aircraft response');
    }

    console.log(
      '[AIRCRAFT] Provider:',
      name,
      '| Aircraft:',
      data.ac.length
    );

    return data;

  } catch (error) {
    console.error(
      '[AIRCRAFT] ' + name + ' failed:',
      error.message
    );

    throw error;

  } finally {
    clearTimeout(timeout);
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
      error: 'Invalid coordinates or distance. dist must be 1..250.'
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
    res.set('Cache-Control', 'no-store');
    return res.json(cache.data);
  }

  const providers = [
    {
      name: 'adsb.lol',
      url:
        'https://api.adsb.lol/v2/point/' +
        lat + '/' + lon + '/' + radius
    },
    {
      name: 'airplanes.live',
      url:
        'https://api.airplanes.live/v2/point/' +
        lat + '/' + lon + '/' + radius
    },
    {
      name: 'adsb.fi',
      url:
        'https://opendata.adsb.fi/api/v3/lat/' +
        lat + '/lon/' + lon + '/dist/' + radius
    }
  ];

  const errors = [];

  for (const provider of providers) {
    try {
      const data = await fetchProvider(
        provider.url,
        provider.name
      );

      const result = {
        ...data,
        ac: data.ac.filter(plane =>
          Number.isFinite(Number(plane.lat)) &&
          Number.isFinite(Number(plane.lon)) &&
          Number(plane.lat) >= -90 &&
          Number(plane.lat) <= 90 &&
          Number(plane.lon) >= -180 &&
          Number(plane.lon) <= 180
        ),
        source: provider.name
      };

      cache = {
        key,
        expires: Date.now() + CACHE_DURATION,
        data: result
      };

      res.set('Cache-Control', 'no-store');

      return res.json(result);

    } catch (error) {
      errors.push({
        provider: provider.name,
        error: error.message
      });
    }
  }

  console.error(
    '[AIRCRAFT] All providers failed:',
    JSON.stringify(errors)
  );

  return res.status(502).json({
    error: 'Could not retrieve aircraft data',
    details: errors
  });
});

app.use((err, _req, res, _next) => {
  console.error('[SERVER ERROR]', err.message);

  if (err.message === 'Origin not allowed by CORS') {
    return res.status(403).json({
      error: 'Origin not allowed'
    });
  }

  return res.status(500).json({
    error: 'Internal server error'
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(
    'Satellite Explorer Aircraft Proxy listening on port ' + PORT
  );
});
