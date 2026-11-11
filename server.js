
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

    return callback(new Error('Origin not allowed by CORS'));
  },
  methods: ['GET'],
  allowedHeaders: ['Accept']
}));

const TIMEOUT = 15000;
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
    version: '5.0',
    endpoint: '/api/aircraft?lat=52.52&lon=13.405&dist=100'
  });
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'aircraft-proxy',
    version: '5.0'
  });
});

function validateCoordinates(lat, lon, dist) {
  return (
    Number.isFinite(lat) &&
    lat >= -90 &&
    lat <= 90 &&
    Number.isFinite(lon) &&
    lon >= -180 &&
    lon <= 180 &&
    Number.isFinite(dist) &&
    dist >= 1 &&
    dist <= 250
  );
}

async function getAircraft(provider) {
  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    TIMEOUT
  );

  try {
    console.log('[PROVIDER REQUEST]', provider.name, provider.url);

    const response = await fetch(provider.url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'SatelliteExplorer/5.0'
      },
      signal: controller.signal
    });

    const body = await response.text();

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}: ${body.slice(0, 300)}`
      );
    }

    let json;

    try {
      json = JSON.parse(body);
    } catch {
      throw new Error('Invalid JSON response');
    }

    let aircraft = [];

    if (Array.isArray(json.ac)) {
      aircraft = json.ac;
    } else if (Array.isArray(json.aircraft)) {
      aircraft = json.aircraft;
    } else {
      throw new Error('Aircraft array not found');
    }

    aircraft = aircraft.filter(plane => {
      if (!plane) return false;

      const lat = Number(plane.lat);
      const lon = Number(plane.lon);

      return (
        plane.lat != null &&
        plane.lon != null &&
        Number.isFinite(lat) &&
        Number.isFinite(lon) &&
        lat >= -90 &&
        lat <= 90 &&
        lon >= -180 &&
        lon <= 180
      );
    });

    console.log(
      '[PROVIDER SUCCESS]',
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
  const dist = Number(req.query.dist ?? 100);

  console.log('[AIRCRAFT INPUT]', {
    lat,
    lon,
    dist,
    original: req.query
  });

  if (!validateCoordinates(lat, lon, dist)) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid coordinates or distance',
      received: {
        lat: req.query.lat ?? null,
        lon: req.query.lon ?? null,
        dist: req.query.dist ?? null
      },
      allowed: {
        latitude: '-90 to 90',
        longitude: '-180 to 180',
        distance: '1 to 250 nautical miles'
      }
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

  const results = await Promise.allSettled(
    providers.map(getAircraft)
  );

  const successful = [];
  const errors = [];

  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      successful.push(result.value);
    } else {
      const reason = result.reason;

      const message =
        reason.name === 'AbortError'
          ? 'Timeout'
          : reason.message;

      errors.push({
        provider: providers[index].name,
        error: message
      });

      console.error(
        '[PROVIDER ERROR]',
        providers[index].name,
        message
      );
    }
  });

  if (!successful.length) {
    return res.status(502).json({
      ok: false,
      error: 'All aircraft providers failed',
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
    availableSources: successful.map(x => x.provider),
    failedSources: errors,
    now: Date.now()
  };

  cache = {
    key,
    expires: Date.now() + CACHE_TIME,
    data: output
  };

  console.log(
    '[AIRCRAFT COMPLETE]',
    best.provider,
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
    `Satellite Explorer Aircraft Proxy v5.0 running on ${PORT}`
  );
});
