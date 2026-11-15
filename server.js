
'use strict';

/* =========================================================
   SATELLITE EXPLORER PRO
   AIRCRAFT SERVER VERSION 8.1.0
   2000 KM COVERAGE
   ADSB.LOL + ADSB.FI
   NODE.JS 18+
   RENDER READY
   ========================================================= */

const express = require('express');
const cors = require('cors');

const app = express();
const PORT = Number(process.env.PORT) || 10000;

app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ---------------------------------------------------------
// CONFIGURATION
// ---------------------------------------------------------

const VERSION = '8.1.0';

const MAX_RADIUS_KM = 2000;
const API_RADIUS_NM = 250;
const API_RADIUS_KM = API_RADIUS_NM * 1.852;

const GRID_SPACING_KM = 700;
const REQUEST_INTERVAL_MS = 1100;
const REQUEST_TIMEOUT_MS = 15000;
const CACHE_TTL_MS = 20000;

const PRIMARY_API = 'https://api.adsb.lol/v2';
const FALLBACK_API = 'https://opendata.adsb.fi/api/v3';

const sleep = ms =>
    new Promise(resolve => setTimeout(resolve, ms));

// ---------------------------------------------------------
// GLOBAL STATE
// ---------------------------------------------------------

const aircraftCaches = new Map();
const refreshJobs = new Map();

let requestQueue = Promise.resolve();
let lastRequestAt = 0;
let totalRequests = 0;
let successfulRequests = 0;

// ---------------------------------------------------------
// VALIDATION
// ---------------------------------------------------------

function validCoordinate(lat, lon) {
    return (
        Number.isFinite(lat) &&
        Number.isFinite(lon) &&
        lat >= -90 &&
        lat <= 90 &&
        lon >= -180 &&
        lon <= 180
    );
}

function normalizeRadius(value) {
    const n = Number(value);

    if (!Number.isFinite(n)) return MAX_RADIUS_KM;

    return Math.min(
        MAX_RADIUS_KM,
        Math.max(10, n)
    );
}

function cacheKey(lat, lon, radius) {
    return `${lat.toFixed(3)}:${lon.toFixed(3)}:${radius}`;
}

// ---------------------------------------------------------
// GEOGRAPHIC CALCULATIONS
// ---------------------------------------------------------

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

function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371;

    const toRad = n => n * Math.PI / 180;

    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);

    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) *
        Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) ** 2;

    return 2 * R * Math.asin(
        Math.sqrt(Math.min(1, a))
    );
}

// ---------------------------------------------------------
// HEXAGONAL COVERAGE GRID
// ---------------------------------------------------------

function createCoveragePoints(lat, lon, radiusKm) {
    const spacing = GRID_SPACING_KM;
    const vertical = spacing * Math.sqrt(3) / 2;

    // Include every grid center whose API circle
    // can intersect the requested coverage area.
    const reach = radiusKm + API_RADIUS_KM;

    const points = [];
    const seen = new Set();

    const minRow = Math.floor(-reach / vertical);
    const maxRow = Math.ceil(reach / vertical);

    for (let row = minRow; row <= maxRow; row++) {
        const y = row * vertical;
        const offset = Math.abs(row % 2) * spacing / 2;

        const minCol = Math.floor(
            (-reach - offset) / spacing
        );

        const maxCol = Math.ceil(
            (reach - offset) / spacing
        );

        for (let col = minCol; col <= maxCol; col++) {
            const x = col * spacing + offset;

            const distance = Math.hypot(x, y);

            if (distance > reach) continue;

            const bearing =
                (Math.atan2(x, y) * 180 / Math.PI + 360) % 360;

            const point = distance < 0.01
                ? { lat, lon }
                : destination(lat, lon, distance, bearing);

            const key =
                `${point.lat.toFixed(4)}:${point.lon.toFixed(4)}`;

            if (!seen.has(key)) {
                seen.add(key);
                points.push({
                    lat: point.lat,
                    lon: point.lon
                });
            }
        }
    }

    // Nearby points first.
    points.sort((a, b) =>
        haversine(lat, lon, a.lat, a.lon) -
        haversine(lat, lon, b.lat, b.lon)
    );

    return points;
}

// ---------------------------------------------------------
// GLOBAL REQUEST QUEUE
// ---------------------------------------------------------

function queuedFetch(url) {
    const task = requestQueue.then(async () => {
        const wait =
            REQUEST_INTERVAL_MS -
            (Date.now() - lastRequestAt);

        if (wait > 0) {
            await sleep(wait);
        }

        lastRequestAt = Date.now();
        totalRequests++;

        const response = await fetch(url, {
            method: 'GET',
            headers: {
                Accept: 'application/json',
                'User-Agent': 'Satellite-Explorer-Pro/8.1'
            },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });

        return response;
    });

    // A failed request must not break the queue.
    requestQueue = task.catch(() => undefined);

    return task;
}

// ---------------------------------------------------------
// NORMALIZE AIRCRAFT RESPONSE
// ---------------------------------------------------------

function normalizeAircraft(data) {
    if (Array.isArray(data.ac)) return data.ac;

    if (Array.isArray(data.aircraft)) {
        return data.aircraft;
    }

    return [];
}

// ---------------------------------------------------------
// PROVIDER REQUEST
// ---------------------------------------------------------

async function requestProvider(base, lat, lon) {
    const url =
        `${base}/lat/${lat.toFixed(4)}` +
        `/lon/${lon.toFixed(4)}` +
        `/dist/${API_RADIUS_NM}`;

    const response = await queuedFetch(url);

    if (!response.ok) {
        const error = new Error(
            `HTTP ${response.status}`
        );

        error.status = response.status;
        throw error;
    }

    const data = await response.json();

    successfulRequests++;

    return normalizeAircraft(data);
}

// ---------------------------------------------------------
// PROVIDER FAILOVER
// ---------------------------------------------------------

async function fetchAircraft(lat, lon) {
    let firstError;

    try {
        const aircraft = await requestProvider(
            PRIMARY_API,
            lat,
            lon
        );

        return {
            aircraft,
            provider: 'ADSB.LOL'
        };

    } catch (error) {
        firstError = error;

        console.error(
            'ADSB.LOL:',
            error.message
        );

        // Invalid parameters should not be repeated
        // against another provider.
        if (error.status === 400) {
            throw error;
        }
    }

    try {
        const aircraft = await requestProvider(
            FALLBACK_API,
            lat,
            lon
        );

        return {
            aircraft,
            provider: 'ADSB.FI'
        };

    } catch (error) {
        console.error(
            'ADSB.FI:',
            error.message
        );

        throw new Error(
            `All aircraft providers failed: ${
                error.message || firstError.message
            }`
        );
    }
}

// ---------------------------------------------------------
// AIRCRAFT MERGING
// ---------------------------------------------------------

function mergeAircraft(target, aircraft, centerLat, centerLon, radiusKm) {
    for (const plane of aircraft) {
        if (
            !plane ||
            !plane.hex ||
            !Number.isFinite(plane.lat) ||
            !Number.isFinite(plane.lon)
        ) {
            continue;
        }

        const distance = haversine(
            centerLat,
            centerLon,
            plane.lat,
            plane.lon
        );

        if (distance > radiusKm) continue;

        const hex = String(plane.hex).toLowerCase();

        const old = target.get(hex);

        const newSeen = Number(plane.seen_pos);
        const oldSeen = old ? Number(old.seen_pos) : Infinity;

        if (
            !old ||
            (Number.isFinite(newSeen) &&
             (!Number.isFinite(oldSeen) || newSeen < oldSeen))
        ) {
            target.set(hex, plane);
        }
    }
}

// ---------------------------------------------------------
// CACHE MANAGEMENT
// ---------------------------------------------------------

function saveCache(key, aircraft, radiusKm, updatedAt) {
    aircraftCaches.set(key, {
        aircraft,
        radiusKm,
        updatedAt
    });

    // Prevent unlimited cache growth.
    if (aircraftCaches.size > 30) {
        const oldestKey = aircraftCaches.keys().next().value;

        if (oldestKey !== key) {
            aircraftCaches.delete(oldestKey);
        }
    }
}

// ---------------------------------------------------------
// BACKGROUND REFRESH
// ---------------------------------------------------------

async function refreshAircraft(lat, lon, radiusKm, key) {
    if (refreshJobs.has(key)) return;

    const job = {
        startedAt: Date.now(),
        completed: 0,
        total: 0,
        errors: 0,
        providerCounts: {
            'ADSB.LOL': 0,
            'ADSB.FI': 0
        }
    };

    refreshJobs.set(key, job);

    const aircraftMap = new Map();

    try {
        const points = createCoveragePoints(
            lat,
            lon,
            radiusKm
        );

        job.total = points.length;

        console.log(
            `Starting coverage: ${radiusKm} km, ${points.length} points`
        );

        // Keep old cache visible until fresh results arrive.
        const oldCache = aircraftCaches.get(key);

        if (oldCache) {
            for (const plane of oldCache.aircraft) {
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
        }

        for (const point of points) {
            try {
                const result = await fetchAircraft(
                    point.lat,
                    point.lon
                );

                job.providerCounts[result.provider]++;

                mergeAircraft(
                    aircraftMap,
                    result.aircraft,
                    lat,
                    lon,
                    radiusKm
                );

            } catch (error) {
                job.errors++;

                console.error(
                    'Coverage point error:',
                    error.message
                );
            }

            job.completed++;

            // Publish partial results progressively.
            saveCache(
                key,
                Array.from(aircraftMap.values()),
                radiusKm,
                Date.now()
            );
        }

        console.log(
            `Coverage complete: ${aircraftMap.size} aircraft, ` +
            `${job.errors} errors, ${job.completed}/${job.total} points`
        );

    } catch (error) {
        console.error(
            'Refresh failed:',
            error.message
        );

    } finally {
        refreshJobs.delete(key);
    }
}

// ---------------------------------------------------------
// SERVER HOME
// ---------------------------------------------------------

app.get('/', (req, res) => {
    res.json({
        service: 'Satellite Explorer Pro',
        version: VERSION,
        status: 'online',
        coverage: '2000 km',
        maximumRadiusKm: MAX_RADIUS_KM,
        apiRadiusNM: API_RADIUS_NM,
        endpoints: {
            aircraft: '/api/aircraft?lat=51.5&lon=7.4&dist=2000',
            status: '/api/status',
            health: '/health'
        }
    });
});

// ---------------------------------------------------------
// AIRCRAFT ENDPOINT
// ---------------------------------------------------------

app.get('/api/aircraft', (req, res) => {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);

    const radiusKm = normalizeRadius(
        req.query.dist || MAX_RADIUS_KM
    );

    if (!validCoordinate(lat, lon)) {
        return res.status(400).json({
            error: 'Invalid coordinates',
            message: 'lat and lon must be valid numbers'
        });
    }

    const key = cacheKey(lat, lon, radiusKm);

    let cache = aircraftCaches.get(key);

    const cacheExpired =
        !cache ||
        Date.now() - cache.updatedAt > CACHE_TTL_MS;

    if (cacheExpired && !refreshJobs.has(key)) {
        refreshAircraft(
            lat,
            lon,
            radiusKm,
            key
        ).catch(error => {
            console.error('Background refresh:', error);
        });
    }

    cache = aircraftCaches.get(key);

    const job = refreshJobs.get(key);

    res.setHeader('Cache-Control', 'no-store');

    res.json({
        service: 'Satellite Explorer Pro',
        version: VERSION,
        status: 'online',
        total: cache ? cache.aircraft.length : 0,
        radiusKm,
        refreshing: Boolean(job),
        progress: job
            ? {
                completed: job.completed,
                total: job.total,
                errors: job.errors
            }
            : null,
        updatedAt: cache ? cache.updatedAt : 0,
        ac: cache ? cache.aircraft : []
    });
});

// ---------------------------------------------------------
// STATUS ENDPOINT
// ---------------------------------------------------------

app.get('/api/status', (req, res) => {
    const jobs = [];

    for (const [key, job] of refreshJobs.entries()) {
        jobs.push({
            key,
            completed: job.completed,
            total: job.total,
            errors: job.errors,
            elapsedMs: Date.now() - job.startedAt,
            providers: job.providerCounts
        });
    }

    res.json({
        online: true,
        version: VERSION,
        refreshing: refreshJobs.size > 0,
        activeJobs: refreshJobs.size,
        cacheEntries: aircraftCaches.size,
        totalRequests,
        successfulRequests,
        jobs
    });
});

// ---------------------------------------------------------
// HEALTH CHECK
// ---------------------------------------------------------

app.get('/health', (req, res) => {
    res.json({
        ok: true,
        service: 'Satellite Explorer Pro',
        version: VERSION,
        uptime: process.uptime()
    });
});

// ---------------------------------------------------------
// ERROR HANDLER
// ---------------------------------------------------------

app.use((err, req, res, next) => {
    console.error('Server error:', err);

    if (res.headersSent) return next(err);

    res.status(500).json({
        error: 'Internal Server Error',
        version: VERSION
    });
});

// ---------------------------------------------------------
// START SERVER
// ---------------------------------------------------------

app.listen(PORT, '0.0.0.0', () => {
    console.log('------------------------------------');
    console.log('SATELLITE EXPLORER PRO');
    console.log(`VERSION: ${VERSION}`);
    console.log(`PORT: ${PORT}`);
    console.log(`MAX COVERAGE: ${MAX_RADIUS_KM} KM`);
    console.log('PRIMARY: ADSB.LOL');
    console.log('FALLBACK: ADSB.FI');
    console.log('STATUS: ONLINE');
    console.log('------------------------------------');
});
