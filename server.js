
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
    version: '4.0',
    endpoint: '/api/aircraft?lat=52.52&lon=13.405&dist=250'
  });
});

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

async function getAircraft(provider) {
  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    TIMEOUT
  );

  try {
    const response = await fetch(provider.url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'SatelliteExplorer/4.0'
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error('HTTP ' + response.status);
    }

    const json = await response.json();

    let aircraft = [];

    if (Array.isArray(json.ac)) {
      aircraft = json.ac;
    } else if (Array.isArray(json.aircraft)) {
      aircraft = json.aircraft;
    } else {
      throw new Error('Invalid API response');
    }

    aircraft = aircraft.filter(plane =>
      plane &&
      plane.lat !== null &&
      plane.lon !== null &&
      plane.lat !== undefined &&
      plane.lon !== undefined &&
      Number.isFinite(Number(plane.lat)) &&
      Number.isFinite(Number(plane.lon)) &&
      Number(plane.lat) >= -90 &&
      Number(plane.lat) <= 90 &&
      Number(plane.lon) >= -180 &&
      Number(plane.lon) <= 180
    );

    console.log(
      '[AIRCRAFT OK]',
      provider.name,
      aircraft.length
    );

    return {
      success: true,
      provider: provider.name,
      aircraft
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
      ok: false,
      error: 'Invalid coordinates or distance'
    });
  }

  const radius = Math.round(dist);

  const key = [
    lat.toFixed(3),
    lon.toFixed(3),
    radius
  ].join(':');

  res.set('Cache-Control', 'no-store');

  if (
    cache.key === key &&
    cache.expires > Date.now() &&
    cache.data
  ) {
    console.log('[AIRCRAFT CACHE] HIT');
    return res.json(cache.data);
  }

  const providers = [
    {
      name: 'adsb.lol',
      url: `https://api.adsb.lol/v2/point/${lat}/${lon}/${radius}`
    },
    {
      name: 'airplanes.live',
      url: `https://api.airplanes.live/v2/point/${lat}/${lon}/${radius}`
    },
    {
      name: 'adsb.fi',
      url: `https://opendata.adsb.fi/api/v3/lat/${lat}/lon/${lon}/dist/${radius}`
    }
  ];

  console.log('[AIRCRAFT] Request started');

  const results = await Promise.allSettled(
    providers.map(provider => getAircraft(provider))
  );

  const successful = [];
  const errors = [];

  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      successful.push(result.value);
    } else {
      const message =
        result.reason.name === 'AbortError'
          ? 'Timeout'
          : result.reason.message;

      errors.push({
        provider: providers[index].name,
        error: message
      });

      console.error(
        '[AIRCRAFT ERROR]',
        providers[index].name,
        message
      );
    }
  });

  if (successful.length === 0) {
    return res.status(502).json({
      ok: false,
      error: 'Could not retrieve aircraft data',
      providers: errors
    });
  }

  successful.sort(
    (a, b) => b.aircraft.length - a.aircraft.length
  );

  const best = successful[0];

  const output = {
    ok: true,
    ac: best.aircraft,
    total: best.aircraft.length,
    source: best.provider,
    availableSources: successful.map(item => item.provider),
    failedSources: errors,
    msg: 'No error',
    now: Date.now()
  };

  cache = {
    key,
    expires: Date.now() + CACHE_TIME,
    data: output
  };

  console.log(
    '[AIRCRAFT COMPLETE]',
    'Source:',
    best.provider,
    'Total:',
    best.aircraft.length
  );

  return res.json(output);
});

app.use((err, req, res, next) => {
  console.error('[SERVER ERROR]', err.message);

  res.status(
    err.message === 'Origin not allowed by CORS'
      ? 403
      : 500
  ).json({
    ok: false,
    error: err.message
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(
    'Satellite Explorer Aircraft Proxy v4.0 running on port ' + PORT
  );
});
