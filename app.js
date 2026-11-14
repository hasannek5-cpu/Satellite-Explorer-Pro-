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
