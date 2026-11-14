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
