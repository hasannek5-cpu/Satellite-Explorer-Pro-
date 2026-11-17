
'use strict';

/* =========================================================
   SATELLITE EXPLORER PRO
   AIRCRAFT SERVER VERSION 8.2.0
   2000 KM COVERAGE
   ADSB.FI + ADSB.LOL
   SMART FAILOVER
   RATE LIMIT PROTECTION
   PERSISTENT CACHE
   NODE.JS 18+
   RENDER READY
   ========================================================= */

const express = require('express');
const cors = require('cors');

const app = express();
const PORT = Number(process.env.PORT) || 10000;

// ---------------------------------------------------------
// CONFIGURATION
// ---------------------------------------------------------

const VERSION = '8.2.0';

const MAX_RADIUS_KM = 2000;

const API_RADIUS_NM = 250;
const API_RADIUS_KM = API_RADIUS_NM * 1.852;

const GRID_SPACING_KM = 700;

// Respect public API rate limits.
const REQUEST_INTERVAL_MS = 2500;
const REQUEST_TIMEOUT_MS = 15000;

// Cache settings.
const CACHE_TTL_MS = 45000;
const RETAIN_OLD_DATA_MS = 120000;

// Provider cooldown.
const RATE_LIMIT_COOLDOWN_MS = 180000;
const SERVER_ERROR_COOLDOWN_MS = 60000;
const ACCESS_ERROR_COOLDOWN_MS = 600000;

// Prevent too many simultaneous coverage jobs.
const MAX_ACTIVE_JOBS = 2;

// ADSB.FI first, ADSB.LOL fallback.
const PROVIDERS = [
    {
        name: 'ADSB.FI',
        base: 'https://opendata.adsb.fi/api/v3'
    },
    {
        name: 'ADSB.LOL',
        base: 'https://api.adsb.lol/v2'
    }
];

app.use(cors());
app.use(express.json({ limit: '1mb' }));

const sleep = ms =>
    new Promise(resolve => setTimeout(resolve, ms));

// ---------------------------------------------------------
// GLOBAL STATE
// ---------------------------------------------------------

const aircraftCaches = new Map();
const refreshJobs = new Map();

const providerStates = {
    'ADSB.FI': {
        cooldownUntil: 0,
        failures: 0,
        lastError: null,
        lastSuccess: 0
    },

    'ADSB.LOL': {
        cooldownUntil: 0,
        failures: 0,
        lastError: null,
        lastSuccess: 0
    }
};

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

    if (!Number.isFinite(n)) {
        return MAX_RADIUS_KM;
    }

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
// COVERAGE GRID
// ---------------------------------------------------------

function createCoveragePoints(lat, lon, radiusKm) {
    const spacing = GRID_SPACING_KM;
    const vertical = spacing * Math.sqrt(3) / 2;

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
                points.push(point);
            }
        }
    }

    points.sort((a, b) =>
        haversine(lat, lon, a.lat, a.lon) -
        haversine(lat, lon, b.lat, b.lon)
    );

    return points;
}

// ---------------------------------------------------------
// PROVIDER COOLDOWN
// ---------------------------------------------------------

function isProviderAvailable(name) {
    const state = providerStates[name];

    return state && Date.now() >= state.cooldownUntil;
}

function applyProviderCooldown(name, error, response) {
    const state = providerStates[name];

    if (!state) return;

    state.failures++;
    state.lastError = error.message;

    let cooldown = 0;

    if (error.status === 429) {
        cooldown = RATE_LIMIT_COOLDOWN_MS;

        const retryAfter = response
            ? response.headers.get('retry-after')
            : null;

        if (retryAfter) {
            const seconds = Number(retryAfter);

            if (Number.isFinite(seconds)) {
                cooldown = Math.max(
                    cooldown,
                    seconds * 1000
                );
            } else {
                const date = Date.parse(retryAfter);

                if (Number.isFinite(date)) {
                    cooldown = Math.max(
                        cooldown,
                        date - Date.now()
                    );
                }
            }
        }
    } else if (
        error.status === 403 ||
        error.status === 401
    ) {
        cooldown = ACCESS_ERROR_COOLDOWN_MS;
    } else if (
        error.status >= 500 ||
        !error.status
    ) {
        cooldown = SERVER_ERROR_COOLDOWN_MS;
    } else {
        cooldown = ACCESS_ERROR_COOLDOWN_MS;
    }

    state.cooldownUntil = Date.now() + cooldown;

    console.warn(
        `${name}: cooldown ${Math.ceil(cooldown / 1000)} seconds`
    );
}

// ---------------------------------------------------------
// GLOBAL REQUEST QUEUE
// ---------------------------------------------------------

function queuedFetch(url, providerName) {
    const task = requestQueue.then(async () => {

        const wait =
            REQUEST_INTERVAL_MS -
            (Date.now() - lastRequestAt);

        if (wait > 0) {
            await sleep(wait);
        }

        // Another job may have triggered a cooldown.
        if (!isProviderAvailable(providerName)) {
            const error = new Error(
                `${providerName} temporarily unavailable`
            );

            error.skipProvider = true;
            throw error;
        }

        lastRequestAt = Date.now();
        totalRequests++;

        return fetch(url, {
            method: 'GET',

            headers: {
                Accept: 'application/json',
                'User-Agent': 'Satellite-Explorer-Pro/8.2.0'
            },

            signal: AbortSignal.timeout(
                REQUEST_TIMEOUT_MS
            )
        });
    });

    requestQueue = task.catch(() => undefined);

    return task;
}

// ---------------------------------------------------------
// RESPONSE NORMALIZATION
// ---------------------------------------------------------

function normalizeAircraft(data) {
    if (!data || typeof data !== 'object') {
        throw new Error('Invalid API response');
    }

    if (Array.isArray(data.ac)) {
        return data.ac;
    }

    if (Array.isArray(data.aircraft)) {
        return data.aircraft;
    }

    throw new Error('Aircraft data missing');
}

// ---------------------------------------------------------
// PROVIDER REQUEST
// ---------------------------------------------------------

async function requestProvider(provider, lat, lon) {

    if (!isProviderAvailable(provider.name)) {
        const error = new Error(
            `${provider.name} is cooling down`
        );

        error.skipProvider = true;
        throw error;
    }

    const url =
        `${provider.base}/lat/${lat.toFixed(4)}` +
        `/lon/${lon.toFixed(4)}` +
        `/dist/${API_RADIUS_NM}`;

    let response;

    try {
        response = await queuedFetch(
            url,
            provider.name
        );

        if (!response.ok) {
            const error = new Error(
                `HTTP ${response.status}`
            );

            error.status = response.status;

            applyProviderCooldown(
                provider.name,
                error,
                response
            );

            throw error;
        }

        const data = await response.json();

        const aircraft = normalizeAircraft(data);

        successfulRequests++;

        const state = providerStates[provider.name];

        state.failures = 0;
        state.lastError = null;
        state.lastSuccess = Date.now();

        return aircraft;

    } catch (error) {

        if (!error.skipProvider && !error.status) {
            applyProviderCooldown(
                provider.name,
                error,
                response
            );
        }

        throw error;
    }
}

// ---------------------------------------------------------
// SMART PROVIDER FAILOVER
// ---------------------------------------------------------

async function fetchAircraft(lat, lon) {

    let lastError = null;

    for (const provider of PROVIDERS) {

        if (!isProviderAvailable(provider.name)) {
            continue;
        }

        try {
            const aircraft = await requestProvider(
                provider,
                lat,
                lon
            );

            return {
                aircraft,
                provider: provider.name
            };

        } catch (error) {

            lastError = error;

            if (!error.skipProvider) {
                console.error(
                    `${provider.name}:`,
                    error.message
                );
            }
        }
    }

    throw new Error(
        lastError
            ? `All providers unavailable: ${lastError.message}`
            : 'All providers are cooling down'
    );
}

// ---------------------------------------------------------
// VALID AIRCRAFT
// ---------------------------------------------------------

function validAircraft(plane) {
    return Boolean(
        plane &&
        plane.hex &&
        Number.isFinite(Number(plane.lat)) &&
        Number.isFinite(Number(plane.lon)) &&
        validCoordinate(
            Number(plane.lat),
            Number(plane.lon)
        )
    );
}

function hasUsableAircraft(
    aircraft,
    centerLat,
    centerLon,
    radiusKm
) {
    return aircraft.some(plane => {

        if (!validAircraft(plane)) return false;

        return haversine(
            centerLat,
            centerLon,
            Number(plane.lat),
            Number(plane.lon)
        ) <= radiusKm;
    });
}

// ---------------------------------------------------------
// AIRCRAFT MERGING
// ---------------------------------------------------------

function mergeAircraft(
    target,
    aircraft,
    centerLat,
    centerLon,
    radiusKm
) {

    for (const plane of aircraft) {

        if (!validAircraft(plane)) continue;

        const distance = haversine(
            centerLat,
            centerLon,
            Number(plane.lat),
            Number(plane.lon)
        );

        if (distance > radiusKm) continue;

        const hex = String(
            plane.hex
        ).toLowerCase();

        const old = target.get(hex);

        const newSeen = Number(plane.seen_pos);

        const oldSeen = old
            ? Number(old.seen_pos)
            : Infinity;

        if (
            !old ||
            (
                Number.isFinite(newSeen) &&
                (
                    !Number.isFinite(oldSeen) ||
                    newSeen < oldSeen
                )
            )
        ) {
            target.set(hex, plane);
        }
    }
}

// ---------------------------------------------------------
// CACHE MANAGEMENT
// ---------------------------------------------------------

function saveCache(
    key,
    aircraft,
    radiusKm,
    updatedAt,
    lastNonEmptyAt
) {

    aircraftCaches.set(key, {
        aircraft,
        radiusKm,
        updatedAt,
        lastNonEmptyAt
    });

    if (aircraftCaches.size > 40) {

        const oldestKey =
            aircraftCaches.keys().next().value;

        if (oldestKey !== key) {
            aircraftCaches.delete(oldestKey);
        }
    }
}

// ---------------------------------------------------------
// BACKGROUND REFRESH
// ---------------------------------------------------------

async function refreshAircraft(
    lat,
    lon,
    radiusKm,
    key
) {

    if (refreshJobs.has(key)) return;

    if (refreshJobs.size >= MAX_ACTIVE_JOBS) {
        return;
    }

    const job = {
        startedAt: Date.now(),
        completed: 0,
        total: 0,
        errors: 0,

        providerCounts: {
            'ADSB.FI': 0,
            'ADSB.LOL': 0
        }
    };

    refreshJobs.set(key, job);

    const aircraftMap = new Map();

    const oldCache = aircraftCaches.get(key);

    let freshDataFound = false;

    let lastNonEmptyAt = oldCache
        ? oldCache.lastNonEmptyAt || 0
        : 0;

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

        // Preserve recently valid aircraft.
        if (
            oldCache &&
            lastNonEmptyAt > 0 &&
            Date.now() - lastNonEmptyAt <= RETAIN_OLD_DATA_MS
        ) {

            mergeAircraft(
                aircraftMap,
                oldCache.aircraft,
                lat,
                lon,
                radiusKm
            );
        }

        for (const point of points) {

            try {

                const result = await fetchAircraft(
                    point.lat,
                    point.lon
                );

                job.providerCounts[
                    result.provider
                ]++;

                if (
                    hasUsableAircraft(
                        result.aircraft,
                        lat,
                        lon,
                        radiusKm
                    )
                ) {
                    freshDataFound = true;
                    lastNonEmptyAt = Date.now();
                }

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

            // Do not erase recent valid data on empty responses.
            if (
                !freshDataFound &&
                lastNonEmptyAt > 0 &&
                Date.now() - lastNonEmptyAt > RETAIN_OLD_DATA_MS
            ) {
                aircraftMap.clear();
            }

            saveCache(
                key,
                Array.from(aircraftMap.values()),
                radiusKm,
                Date.now(),
                lastNonEmptyAt
            );
        }

        console.log(
            `Coverage complete: ${aircraftMap.size} aircraft, ` +
            `${job.errors} errors, ` +
            `${job.completed}/${job.total} points`
        );

        console.log(
            `Providers: ADSB.FI=${job.providerCounts['ADSB.FI']}, ` +
            `ADSB.LOL=${job.providerCounts['ADSB.LOL']}`
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

        primary: 'ADSB.FI',
        fallback: 'ADSB.LOL',

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

    const key = cacheKey(
        lat,
        lon,
        radiusKm
    );

    let cache = aircraftCaches.get(key);

    const cacheExpired =
        !cache ||
        Date.now() - cache.updatedAt > CACHE_TTL_MS;

    if (
        cacheExpired &&
        !refreshJobs.has(key) &&
        refreshJobs.size < MAX_ACTIVE_JOBS
    ) {

        refreshAircraft(
            lat,
            lon,
            radiusKm,
            key
        ).catch(error => {
            console.error(
                'Background refresh:',
                error
            );
        });
    }

    cache = aircraftCaches.get(key);

    const job = refreshJobs.get(key);

    res.setHeader(
        'Cache-Control',
        'no-store'
    );

    res.json({

        service: 'Satellite Explorer Pro',
        version: VERSION,
        status: 'online',

        total: cache
            ? cache.aircraft.length
            : 0,

        radiusKm,

        refreshing: Boolean(job),

        progress: job
            ? {
                completed: job.completed,
                total: job.total,
                errors: job.errors
            }
            : null,

        updatedAt: cache
            ? cache.updatedAt
            : 0,

        ac: cache
            ? cache.aircraft
            : [],

        providers: {
            primary: 'ADSB.FI',
            fallback: 'ADSB.LOL'
        },

        attribution: {
            source: 'ADSB.FI',
            url: 'https://adsb.fi/'
        }
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

            elapsedMs:
                Date.now() - job.startedAt,

            providers: job.providerCounts
        });
    }

    const providers = {};

    for (const [name, state] of Object.entries(providerStates)) {

        providers[name] = {
            available: isProviderAvailable(name),

            coolingDown:
                Date.now() < state.cooldownUntil,

            cooldownRemainingMs: Math.max(
                0,
                state.cooldownUntil - Date.now()
            ),

            failures: state.failures,

            lastError: state.lastError,

            lastSuccess: state.lastSuccess
        };
    }

    res.json({

        online: true,
        version: VERSION,

        refreshing:
            refreshJobs.size > 0,

        activeJobs:
            refreshJobs.size,

        cacheEntries:
            aircraftCaches.size,

        totalRequests,

        successfulRequests,

        providers,

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

    console.error(
        'Server error:',
        err
    );

    if (res.headersSent) {
        return next(err);
    }

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

    console.log('PRIMARY: ADSB.FI');

    console.log('FALLBACK: ADSB.LOL');

    console.log(`REQUEST INTERVAL: ${REQUEST_INTERVAL_MS} MS`);

    console.log('SMART FAILOVER: ENABLED');

    console.log('RATE LIMIT PROTECTION: ENABLED');

    console.log('AIRCRAFT CACHE: ENABLED');

    console.log('STATUS: ONLINE');

    console.log('------------------------------------');
});
