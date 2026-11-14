/* =====================================================
   🛰️ SATELLITE EXPLORER PRO
   COMPLETE INTEGRATED VERSION

   GPS + SATELLITES + ORBIT
   PASS PREDICTION
   RADIO INFORMATION
   LIVE AIRCRAFT
   AUTO MAP CENTER
   AUTO REFRESH
   ===================================================== */

'use strict';

// =====================================================
// 1. CHECK REQUIRED LIBRARIES
// =====================================================

if (typeof L === 'undefined') {
    throw new Error('Leaflet بارگذاری نشده است.');
}

if (typeof satellite === 'undefined') {
    throw new Error('satellite.js بارگذاری نشده است.');
}

// =====================================================
// 2. MAP INITIALIZATION
// =====================================================

const map = window.map = L.map('map').setView([25, 15], 2);

L.tileLayer(
    'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    {
        attribution: '© OpenStreetMap'
    }
).addTo(map);

// =====================================================
// 3. MAP LAYERS
// =====================================================

const markers = L.layerGroup().addTo(map);

const pathLayer = L.layerGroup().addTo(map);

// =====================================================
// 4. RADIO DATABASE
// =====================================================

const RADIO_DATABASE = {
    ISS: {
        name: 'International Space Station',
        frequency: '145.800 MHz',
        mode: 'FM',
        description: 'ISS Amateur Radio'
    }
};

// =====================================================
// 5. HTML SECURITY
// =====================================================

function escapeHTML(value) {
    return String(value ?? '').replace(
        /[&<>"']/g,
        character => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        })[character]
    );
}

// =====================================================
// 6. TAB MANAGEMENT
// =====================================================

function showTab(tabId) {

    document.querySelectorAll('.tab-content').forEach(tab => {
        tab.style.display = 'none';
    });

    const selectedTab = document.getElementById(tabId);

    if (selectedTab) {
        selectedTab.style.display = 'block';
    }
}

// =====================================================
// 7. TLE PARSER
// =====================================================

function parseTLE(data) {

    const lines = data
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);

    const satellites = [];

    for (let i = 0; i < lines.length - 2; i++) {

        if (
            lines[i + 1].startsWith('1 ') &&
            lines[i + 2].startsWith('2 ')
        ) {

            satellites.push({
                name: lines[i],
                line1: lines[i + 1],
                line2: lines[i + 2]
            });

            i += 2;
        }
    }

    return satellites;
}

// =====================================================
// 8. SATELLITE DATA CONFIGURATION
// =====================================================

const SATELLITE_CONFIG = {
    tleUrl: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=tle',
    refreshInterval: 60000,
    maxSatellites: 500
};

let satelliteList = [];
let satelliteMarkers = new Map();
let satellitePositions = new Map();

// =====================================================
// 9. FETCH TLE DATA
// =====================================================

async function fetchTLEData() {

    try {

        const response = await fetch(
            SATELLITE_CONFIG.tleUrl,
            { cache: 'no-store' }
        );

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.text();

        if (!data.trim()) {
            throw new Error('داده TLE خالی است.');
        }

        return parseTLE(data);

    } catch (error) {

        console.error(
            'Satellite TLE Error:',
            error
        );

        return [];

    }
}

// =====================================================
// 10. LOAD SATELLITES
// =====================================================

async function loadSatellites() {

    const data = await fetchTLEData();

    if (!data.length) {
        console.warn('هیچ ماهواره‌ای دریافت نشد.');
        return false;
    }

    satelliteList = data.slice(
        0,
        SATELLITE_CONFIG.maxSatellites
    );

    satellitePositions.clear();

    console.log(
        `${satelliteList.length} satellites loaded`
    );

    return true;
}

// =====================================================
// 11. CREATE SATELLITE MARKER
// =====================================================

function createSatelliteMarker(name, lat, lon) {

    const marker = L.circleMarker(
        [lat, lon],
        {
            radius: 6,
            color: '#00e5ff',
            weight: 2,
            fillColor: '#00bcd4',
            fillOpacity: 0.9
        }
    );

    marker.bindPopup(
        `<b>${escapeHTML(name)}</b><br>
         Latitude: ${lat.toFixed(4)}<br>
         Longitude: ${lon.toFixed(4)}`
    );

    return marker;
}

// =====================================================
// 12. UPDATE SATELLITE MARKERS
// =====================================================

function updateSatelliteMarker(name, lat, lon) {

    if (
        !Number.isFinite(lat) ||
        !Number.isFinite(lon)
    ) {
        return;
    }

    let marker = satelliteMarkers.get(name);

    if (!marker) {

        marker = createSatelliteMarker(
            name,
            lat,
            lon
        );

        satelliteMarkers.set(name, marker);

        marker.addTo(markers);

    } else {

        marker.setLatLng([lat, lon]);

    }

    satellitePositions.set(name, {
        latitude: lat,
        longitude: lon,
        updatedAt: Date.now()
    });
}

// =====================================================
// 13. CLEAR SATELLITE MARKERS
// =====================================================

function clearSatelliteMarkers() {

    markers.clearLayers();

    satelliteMarkers.clear();

    satellitePositions.clear();

}

// =====================================================
// 14. SATELLITE INFORMATION
// =====================================================

function getSatelliteInfo(name) {

    const item = satelliteList.find(
        satelliteItem =>
            satelliteItem.name === name
    );

    if (!item) {
        return null;
    }

    return {
        name: item.name,
        tle1: item.line1,
        tle2: item.line2
    };
}
// =====================================================
// 15. SATELLITE PROPAGATION
// =====================================================

function calculateSatellitePosition(item, date = new Date()) {

    try {

        const satrec = satellite.twoline2satrec(
            item.line1,
            item.line2
        );

        const positionAndVelocity =
            satellite.propagate(satrec, date);

        if (
            !positionAndVelocity ||
            !positionAndVelocity.position ||
            !positionAndVelocity.velocity
        ) {
            return null;
        }

        const positionEci = positionAndVelocity.position;

        const velocity = positionAndVelocity.velocity;

        if (
            !Number.isFinite(positionEci.x) ||
            !Number.isFinite(positionEci.y) ||
            !Number.isFinite(positionEci.z)
        ) {
            return null;
        }

        const gmst = satellite.gstime(date);

        const positionGd =
            satellite.eciToGeodetic(
                positionEci,
                gmst
            );

        const latitude =
            satellite.degreesLat(positionGd.latitude);

        const longitude =
            satellite.degreesLong(positionGd.longitude);

        const altitude = positionGd.height;

        const speed = Math.sqrt(
            velocity.x ** 2 +
            velocity.y ** 2 +
            velocity.z ** 2
        );

        return {
            name: item.name,
            latitude,
            longitude,
            altitude,
            speed,
            timestamp: date.getTime()
        };

    } catch (error) {

        console.error(
            'Position calculation error:',
            item.name,
            error
        );

        return null;
    }
}

// =====================================================
// 16. UPDATE ALL SATELLITE POSITIONS
// =====================================================

function updateAllSatellitePositions() {

    const now = new Date();

    satelliteList.forEach(item => {

        const position =
            calculateSatellitePosition(item, now);

        if (!position) return;

        updateSatelliteMarker(
            position.name,
            position.latitude,
            position.longitude
        );

        satellitePositions.set(
            position.name,
            position
        );

    });
}

// =====================================================
// 17. GET SATELLITE POSITION
// =====================================================

function getSatellitePosition(name) {

    const item = satelliteList.find(
        sat => sat.name === name
    );

    if (!item) return null;

    return calculateSatellitePosition(item);
}

// =====================================================
// 18. FORMAT SATELLITE DATA
// =====================================================

function formatSatelliteData(position) {

    if (!position) {
        return 'اطلاعات موقعیت موجود نیست.';
    }

    return {
        name: position.name,

        latitude:
            position.latitude.toFixed(5),

        longitude:
            position.longitude.toFixed(5),

        altitude:
            position.altitude.toFixed(2) + ' km',

        speed:
            position.speed.toFixed(3) + ' km/s',

        updated:
            new Date(
                position.timestamp
            ).toLocaleTimeString()
    };
}

// =====================================================
// 19. SATELLITE SEARCH
// =====================================================

function searchSatellite(query) {

    const keyword = String(query || '')
        .trim()
        .toLowerCase();

    if (!keyword) return [];

    return satelliteList.filter(item =>
        item.name.toLowerCase().includes(keyword)
    );
}

// =====================================================
// 20. FOCUS ON SATELLITE
// =====================================================

function focusSatellite(name) {

    const position =
        getSatellitePosition(name);

    if (!position) return false;

    map.setView(
        [
            position.latitude,
            position.longitude
        ],
        6
    );

    const marker =
        satelliteMarkers.get(name);

    if (marker) {
        marker.openPopup();
    }

    return true;
           }
// =====================================================
// 21. GPS CONFIGURATION
// =====================================================

const GPS_CONFIG = {
    enableHighAccuracy: true,
    timeout: 15000,
    maximumAge: 3000
};

let userLocation = null;
let userMarker = null;
let userAccuracyCircle = null;
let gpsWatchId = null;

// =====================================================
// 22. GPS ERROR HANDLER
// =====================================================

function handleGPSError(error) {

    const messages = {
        1: 'دسترسی به موقعیت GPS رد شده است.',
        2: 'موقعیت جغرافیایی در دسترس نیست.',
        3: 'زمان دریافت GPS به پایان رسید.'
    };

    console.error(
        'GPS Error:',
        messages[error.code] || error.message
    );
}

// =====================================================
// 23. UPDATE USER LOCATION
// =====================================================

function updateUserLocation(position) {

    const latitude = position.coords.latitude;
    const longitude = position.coords.longitude;
    const accuracy = position.coords.accuracy;

    if (
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude)
    ) {
        return;
    }

    userLocation = {
        latitude,
        longitude,
        accuracy,
        altitude: position.coords.altitude,
        speed: position.coords.speed,
        heading: position.coords.heading,
        timestamp: position.timestamp
    };

    const coordinates = [
        latitude,
        longitude
    ];

    if (!userMarker) {

        userMarker = L.marker(coordinates)
            .addTo(map)
            .bindPopup('موقعیت فعلی شما');

    } else {

        userMarker.setLatLng(coordinates);

    }

    if (!userAccuracyCircle) {

        userAccuracyCircle = L.circle(
            coordinates,
            {
                radius: accuracy,
                color: '#2196f3',
                fillOpacity: 0.12
            }
        ).addTo(map);

    } else {

        userAccuracyCircle.setLatLng(coordinates);
        userAccuracyCircle.setRadius(accuracy);

    }

    const gpsOutput =
        document.getElementById('gps-status');

    if (gpsOutput) {

        gpsOutput.textContent =
            `GPS فعال | ${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;

    }

    document.dispatchEvent(
        new CustomEvent('satellite:gps-update', {
            detail: userLocation
        })
    );
}

// =====================================================
// 24. START GPS
// =====================================================

function startGPS() {

    if (!navigator.geolocation) {

        console.error(
            'مرورگر از GPS پشتیبانی نمی‌کند.'
        );

        return false;
    }

    if (gpsWatchId !== null) {
        navigator.geolocation.clearWatch(gpsWatchId);
    }

    gpsWatchId = navigator.geolocation.watchPosition(
        updateUserLocation,
        handleGPSError,
        GPS_CONFIG
    );

    return true;
}

// =====================================================
// 25. STOP GPS
// =====================================================

function stopGPS() {

    if (gpsWatchId !== null) {

        navigator.geolocation.clearWatch(
            gpsWatchId
        );

        gpsWatchId = null;
    }
}

// =====================================================
// 26. CENTER MAP ON USER
// =====================================================

function centerMapOnUser() {

    if (!userLocation) {
        console.warn('موقعیت GPS هنوز دریافت نشده است.');
        return false;
    }

    map.setView(
        [
            userLocation.latitude,
            userLocation.longitude
        ],
        10
    );

    if (userMarker) {
        userMarker.openPopup();
    }

    return true;
}

// =====================================================
// 27. DISTANCE CALCULATION
// =====================================================

function calculateDistance(
    lat1,
    lon1,
    lat2,
    lon2
) {

    const R = 6371;

    const toRadians = value =>
        value * Math.PI / 180;

    const dLat = toRadians(lat2 - lat1);
    const dLon = toRadians(lon2 - lon1);

    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRadians(lat1)) *
        Math.cos(toRadians(lat2)) *
        Math.sin(dLon / 2) ** 2;

    const c =
        2 * Math.atan2(
            Math.sqrt(a),
            Math.sqrt(1 - a)
        );

    return R * c;
}

// =====================================================
// 28. DISTANCE TO SATELLITE GROUND TRACK
// =====================================================

function getDistanceToSatellite(name) {

    if (!userLocation) return null;

    const position =
        getSatellitePosition(name);

    if (!position) return null;

    return calculateDistance(
        userLocation.latitude,
        userLocation.longitude,
        position.latitude,
        position.longitude
    );
}

/* =========================================================
   STAGE 5 OF 11
   SATELLITE EXPLORER PRO
   TLE PARSER MODULE
   ========================================================= */

function parseTLE(content, group = "active") {
    if (!content || typeof content !== "string") {
        throw new Error("Invalid TLE content");
    }

    const lines = content
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);

    const satellites = [];

    for (let i = 0; i < lines.length; i++) {
        let name = "UNKNOWN";

        if (!lines[i].startsWith("1 ")) {
            name = lines[i];
            i++;

            if (i + 1 >= lines.length) break;
        }

        const line1 = lines[i];
        const line2 = lines[i + 1];

        if (
            !line1 ||
            !line2 ||
            !line1.startsWith("1 ") ||
            !line2.startsWith("2 ")
        ) {
            continue;
        }

        const satellite = {
            name,
            group,
            line1,
            line2,
            catalogNumber: line1.substring(2, 7).trim(),
            inclination: Number(line2.substring(8, 16)),
            raan: Number(line2.substring(17, 25)),
            eccentricity: Number(
                "0." + line2.substring(26, 33).trim()
            ),
            argumentOfPerigee: Number(
                line2.substring(34, 42)
            ),
            meanAnomaly: Number(
                line2.substring(43, 51)
            ),
            meanMotion: Number(
                line2.substring(52, 63)
            )
        };

        if (
            Number.isFinite(satellite.inclination) &&
            Number.isFinite(satellite.meanMotion)
        ) {
            satellites.push(satellite);
        }

        i++;
    }

    return satellites;
}

/* =========================================================
   STAGE 6 OF 11
   SATELLITE POSITION CALCULATION
   ========================================================= */

const SatellitePosition = (() => {
    "use strict";

    const EARTH_RADIUS = 6371;

    function toRadians(degrees) {
        return degrees * Math.PI / 180;
    }

    function toDegrees(radians) {
        return radians * 180 / Math.PI;
    }

    function normalizeAngle(angle) {
        return ((angle % 360) + 360) % 360;
    }

    function calculateOrbitalRadius(meanMotion) {
        const MU = 398600.4418;
        const n = meanMotion * 2 * Math.PI / 86400;

        if (!Number.isFinite(n) || n <= 0) {
            throw new Error("Invalid mean motion");
        }

        return Math.cbrt(MU / (n * n));
    }

    function calculatePosition(tle, timestamp = Date.now()) {
        if (!tle || !tle.line1 || !tle.line2) {
            throw new Error("Invalid satellite TLE");
        }

        const inclination = toRadians(tle.inclination);
        const raan = toRadians(tle.raan);
        const eccentricity = tle.eccentricity;
        const argument = toRadians(tle.argumentOfPerigee);
        const meanAnomaly = toRadians(tle.meanAnomaly);

        const orbitalRadius =
            calculateOrbitalRadius(tle.meanMotion);

        const epochYear = Number(tle.line1.substring(18, 20));
        const epochDay = Number(tle.line1.substring(20, 32));

        const fullYear = epochYear < 57
            ? 2000 + epochYear
            : 1900 + epochYear;

        const epoch = Date.UTC(fullYear, 0, 1) +
            (epochDay - 1) * 86400000;

        const elapsedDays = (timestamp - epoch) / 86400000;

        const meanMotionRadians =
            tle.meanMotion * 2 * Math.PI;

        const M = normalizeAngle(
            toDegrees(meanAnomaly) +
            meanMotionRadians * elapsedDays
        );

        const mean = toRadians(M);
        let E = mean;

        for (let i = 0; i < 12; i++) {
            E -= (
                E - eccentricity * Math.sin(E) - mean
            ) / (
                1 - eccentricity * Math.cos(E)
            );
        }

        const trueAnomaly = 2 * Math.atan2(
            Math.sqrt(1 + eccentricity) * Math.sin(E / 2),
            Math.sqrt(1 - eccentricity) * Math.cos(E / 2)
        );

        const radius = orbitalRadius *
            (1 - eccentricity * Math.cos(E));

        const u = argument + trueAnomaly;

        const x = radius * (
            Math.cos(raan) * Math.cos(u) -
            Math.sin(raan) * Math.sin(u) * Math.cos(inclination)
        );

        const y = radius * (
            Math.sin(raan) * Math.cos(u) +
            Math.cos(raan) * Math.sin(u) * Math.cos(inclination)
        );

        const z = radius *
            Math.sin(u) * Math.sin(inclination);

        return {
            x,
            y,
            z,
            radius,
            altitude: radius - EARTH_RADIUS,
            latitude: toDegrees(Math.atan2(
                z,
                Math.sqrt(x * x + y * y)
            )),
            longitude: normalizeAngle(
                toDegrees(Math.atan2(y, x))
            )
        };
    }

    return {
        calculatePosition,
        calculateOrbitalRadius,
        normalizeAngle
    };
})();
/* =========================================================
   STAGE 7 / 11
   THERMAL ANALYSIS
   LANDSAT THERMAL DATA
   ========================================================= */

(() => {
  'use strict';

  window.loadThermalData = async function (bbox) {
    const panel = document.getElementById('thermalResults');

    if (!bbox || bbox.length !== 4) {
      throw new Error('محدوده جغرافیایی معتبر نیست.');
    }

    if (panel) {
      panel.textContent = 'در حال دریافت داده‌های حرارتی Landsat...';
    }

    try {
      const response = await fetch(
        'https://earth-search.aws.element84.com/v1/search',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            collections: ['landsat-c2-l2'],
            bbox: bbox,
            datetime:
              `${new Date(Date.now() - 365 * 86400000).toISOString()}/` +
              `${new Date().toISOString()}`,
            limit: 20,
            query: {
              'eo:cloud_cover': {
                lte: 30
              }
            }
          })
        }
      );

      if (!response.ok) {
        throw new Error(`خطای سرور: ${response.status}`);
      }

      const data = await response.json();

      if (!data.features || data.features.length === 0) {
        throw new Error('تصویر حرارتی مناسبی پیدا نشد.');
      }

      const results = data.features.map(feature => {
        const assets = feature.assets || {};

        const thermalAsset =
          assets.lwir11 ||
          assets.st_b10 ||
          assets.ST_B10 ||
          null;

        return {
          id: feature.id,
          date: feature.properties?.datetime || 'نامشخص',
          cloudCover:
            feature.properties?.['eo:cloud_cover'] ?? 'نامشخص',
          thermalAvailable: Boolean(thermalAsset),
          thermalAsset: thermalAsset?.href || null
        };
      });

      window.SatelliteThermalData = results;

      if (panel) {
        panel.innerHTML = '';

        results.forEach(item => {
          const card = document.createElement('div');
          card.className = 'thermal-result-card';

          const title = document.createElement('h4');
          title.textContent = item.id;

          const date = document.createElement('p');
          date.textContent = `تاریخ: ${item.date}`;

          const cloud = document.createElement('p');
          cloud.textContent = `پوشش ابر: ${item.cloudCover}%`;

          const status = document.createElement('p');
          status.textContent = item.thermalAvailable
            ? 'باند حرارتی موجود است'
            : 'باند حرارتی موجود نیست';

          card.append(title, date, cloud, status);
          panel.appendChild(card);
        });
      }

      return results;

    } catch (error) {
      console.error('Thermal Analysis Error:', error);

      if (panel) {
        panel.textContent = `خطا در تحلیل حرارتی: ${error.message}`;
      }

      throw error;
    }
  };

})();
