
'use strict';

const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json({ limit: '1mb' }));

const NM_PER_KM = 0.5399568;
const MAX_API_RADIUS_NM = 250;
const API_DELAY_MS = 1200;
const CACHE_TTL_MS = 15000;

let aircraftCache = [];
let cacheUpdatedAt = 0;
let refreshRunning = false;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function validCoordinate(lat, lon) {
  return Number.isFinite(lat) &&
         Number.isFinite(lon) &&
         lat >= -90 && lat <= 90 &&
         lon >= -180 && lon <= 180;
}

// محاسبه نقطه جدید بر اساس فاصله و جهت
function destination(lat, lon, distanceKm, bearing) {
  const R = 6371;
  const d = distanceKm / R;
  const br = bearing * Math.PI / 180;
  const lat1 = lat * Math.PI / 180;
  const lon1 = lon * Math.PI / 180;

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) +
    Math.cos(lat1) * Math.sin(d) * Math.cos(br)
  );

  const lon2 = lon1 + Math.atan2(
    Math.sin(br) * Math.sin(d) * Math.cos(lat1),
    Math.cos(d) - Math.sin(lat1) * Math.sin(lat2)
  );

  return {
    lat: lat2 * 180 / Math.PI,
    lon: ((lon2 * 180 / Math.PI + 540) % 360) - 180
  };
}

// ایجاد نقاط پوشش منطقه
function createCoveragePoints(lat, lon, radiusKm) {
  const spacing = 650;
  const points = [{ lat, lon }];

  for (let distance = spacing; distance <= radiusKm; distance += spacing) {
    const count = Math.max(
      8,
      Math.ceil(2 * Math.PI * distance / spacing)
    );

    for (let i = 0; i < count; i++) {
      const point = destination(
        lat,
        lon,
        distance,
        i * 360 / count
      );

      points.push(point);
    }
  }

  return points;
}

async function fetchAircraft(lat, lon) {
  const url =
    `https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/${MAX_API_RADIUS_NM}`;

  const response = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'Satellite-Explorer-Pro/8.0'
    },
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    throw new Error(`ADSB HTTP ${response.status}`);
  }

  const data = await response.json();

  return Array.isArray(data.ac) ? data.ac : [];
}

async function refreshAircraft(lat, lon, radiusKm) {
  if (refreshRunning) return;

  refreshRunning = true;

  try {
    const points = createCoveragePoints(lat, lon, radiusKm);
    const aircraftMap = new Map();

    for (const point of points) {
      try {
        const aircraft = await fetchAircraft(
          point.lat.toFixed(4),
          point.lon.toFixed(4)
        );

        for (const plane of aircraft) {
          if (
            plane.hex &&
            Number.isFinite(plane.lat) &&
            Number.isFinite(plane.lon)
          ) {
            aircraftMap.set(
              String(plane.hex).toLowerCase(),
              plane
            );
          }
        }
      } catch (error) {
        console.error('Aircraft fetch:', error.message);
      }

      await sleep(API_DELAY_MS);
    }

    aircraftCache = Array.from(aircraftMap.values());
    cacheUpdatedAt = Date.now();

    console.log(
      `Aircraft updated: ${aircraftCache.length} / ${points.length} points`
    );
  } finally {
    refreshRunning = false;
  }
}

// وضعیت سرور
app.get('/', (req, res) => {
  res.json({
    service: 'Satellite Explorer Pro',
    version: '8.0.0',
    status: 'online',
    aircraftEndpoint: '/api/aircraft',
    maximumRadiusKm: 2000
  });
});

// اطلاعات پروازها
app.get('/api/aircraft', async (req, res) => {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);

  const requestedKm = Number(req.query.dist || 2000);
  const radiusKm = Math.min(
    2000,
    Math.max(10, requestedKm)
  );

  if (!validCoordinate(lat, lon)) {
    return res.status(400).json({
      error: 'Invalid coordinates',
      message: 'lat and lon must be valid numbers'
    });
  }

  if (
    !cacheUpdatedAt ||
    Date.now() - cacheUpdatedAt > CACHE_TTL_MS
  ) {
    refreshAircraft(lat, lon, radiusKm).catch(console.error);
  }

  res.setHeader('Cache-Control', 'no-store');

  res.json({
    service: 'Satellite Explorer Pro',
    version: '8.0.0',
    total: aircraftCache.length,
    radiusKm,
    refreshing: refreshRunning,
    updatedAt: cacheUpdatedAt,
    ac: aircraftCache
  });
});

// وضعیت دریافت اطلاعات
app.get('/api/status', (req, res) => {
  res.json({
    online: true,
    refreshing: refreshRunning,
    aircraft: aircraftCache.length,
    updatedAt: cacheUpdatedAt
  });
});

// خطاهای عمومی
app.use((err, req, res, next) => {
  console.error(err);

  res.status(500).json({
    error: 'Internal Server Error'
  });
});

app.listen(PORT, () => {
  console.log(`Satellite Explorer Pro running on ${PORT}`);
});
