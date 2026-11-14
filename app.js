
/* =====================================================
   🛰️ SATELLITE EXPLORER PRO
   COMPLETE INTEGRATED VERSION
   GPS + SATELLITES + ORBIT + PASS PREDICTION
   RADIO INFORMATION + LIVE AIRCRAFT
   AUTO MAP CENTER + AUTO REFRESH
   ===================================================== */

if (typeof L === 'undefined') {
  throw new Error('Leaflet بارگذاری نشده است.');
}

if (typeof satellite === 'undefined') {
  throw new Error('satellite.js بارگذاری نشده است.');
}

/* =====================================================
   MAP - ESRI SATELLITE / HIGH ZOOM
   ===================================================== */

const map = window.map = L.map('map', {
  zoomControl: false,
  scrollWheelZoom: true,
  doubleClickZoom: true,
  touchZoom: true,
  boxZoom: true,
  keyboard: true,
  zoomSnap: 0.25,
  zoomDelta: 0.5,
  minZoom: 2,
  maxZoom: 22,
  preferCanvas: true
}).setView([25, 15], 2);

// تصاویر ماهواره‌ای
const esriImagery = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  {
    attribution: 'Tiles © Esri',
    maxZoom: 22,
    maxNativeZoom: 19,
    tileSize: 256,
    crossOrigin: true,
    keepBuffer: 4
  }
).addTo(map);

// نقشه خیابانی جایگزین
const osmLayer = L.tileLayer(
  'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  {
    attribution: '© OpenStreetMap',
    maxZoom: 19,
    keepBuffer: 3
  }
);

// کنترل بزرگ‌نمایی
L.control.zoom({
  position: 'bottomright'
}).addTo(map);

// مقیاس متر و کیلومتر
L.control.scale({
  position: 'bottomleft',
  metric: true,
  imperial: false,
  maxWidth: 160
}).addTo(map);

// انتخاب نقشه
L.control.layers(
  {
    'تصویر ماهواره‌ای Esri': esriImagery,
    'نقشه خیابانی': osmLayer
  },
  {},
  {
    position: 'topright',
    collapsed: true
  }
).addTo(map);

// تنظیم مجدد اندازه نقشه
window.addEventListener('resize', () => {
  map.invalidateSize();
});

map.whenReady(() => {
  setTimeout(() => map.invalidateSize(), 150);
});

// گروه‌های ماهواره
const markers = L.layerGroup().addTo(map);
const pathLayer = L.layerGroup().addTo(map);
const markerMap = new Map();

// Shared application state
let satellitesData = [];
let selectedNorad = null;
let userLocation = null;
let userMarker = null;
let passSearchBusy = false;

// =====================================================
// 2. SATELLITE GROUPS
// =====================================================

const SATELLITE_GROUPS = [
  'stations', 'weather', 'noaa', 'goes',
  'resource', 'sarsat', 'cubesat',
  'education', 'amateur'
];

// =====================================================
// 3. RADIO DATABASE
// =====================================================

const RADIO_DATABASE = {
  "25544": {
    title: "ISS (ZARYA)",
    status: "اطلاعات رادیویی منتشرشده؛ وضعیت عملیاتی باید بررسی شود.",
    modes: [
      {
        name: "APRS / Packet",
        uplink: "145.825 MHz",
        downlink: "145.825 MHz",
        protocol: "AFSK / AX.25"
      },
      {
        name: "رله صوتی FM",
        uplink: "145.990 MHz",
        downlink: "437.800 MHz",
        protocol: "FM - CTCSS 67 Hz"
      }
    ],
    source: "https://www.amsat.org/amateur-radio-on-the-iss/"
  }
};

// =====================================================
// 4. GENERAL FUNCTIONS
// =====================================================

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[c]);
}

function activateTab(tab) {
  if (typeof window.showTab === 'function') {
    window.showTab(tab);
  } else if (tab === 'map') {
    setTimeout(() => map.invalidateSize(true), 200);
  }
}

// =====================================================
// 5. TLE PARSER
// =====================================================

function parseTLE(content, group) {
  const lines = content.split(/\r?\n/)
    .map(x => x.trim())
    .filter(Boolean);

  const result = [];

  for (let i = 0; i < lines.length - 2; i++) {
    const name = lines[i].replace(/^0\s+/, '');
    const line1 = lines[i + 1];
    const line2 = lines[i + 2];

    if (!line1.startsWith('1 ') ||
        !line2.startsWith('2 ')) {
      continue;
    }

    const norad = line1.substring(2, 7).trim();

    try {
      const satrec = satellite.twoline2satrec(line1, line2);

      if (satrec.error) continue;

      result.push({
        name,
        norad,
        group,
        satrec,
        lat: 0,
        lon: 0,
        altitude: 0,
        speed: 0
      });

      i += 2;

    } catch (error) {
      console.warn('TLE error:', name, error);
    }
  }

  return result;
}

// =====================================================
// 6. LOAD SATELLITES
// =====================================================

async function loadSatellites() {
  const details = document.getElementById('details');

  if (details && satellitesData.length === 0) {
    details.innerText = 'در حال دریافت اطلاعات ماهواره‌ها...';
  }

  try {
    const results = await Promise.allSettled(
      SATELLITE_GROUPS.map(async group => {
        const url =
          'https://celestrak.org/NORAD/elements/gp.php?GROUP=' +
          encodeURIComponent(group) + '&FORMAT=tle';

        const response = await fetch(url);

        if (!response.ok) {
          throw new Error('HTTP ' + response.status);
        }

        return parseTLE(await response.text(), group);
      })
    );

    const dataMap = new Map();
    let successfulGroups = 0;

    results.forEach(result => {
      if (result.status !== 'fulfilled') return;

      successfulGroups++;

      result.value.forEach(sat => {
        if (!dataMap.has(sat.norad)) {
          dataMap.set(sat.norad, sat);
        }
      });
    });

    const fresh = Array.from(dataMap.values());

    if (!fresh.length) {
      if (details && !selectedNorad) {
        details.innerText =
          'دریافت ناموفق؛ اطلاعات قبلی حفظ شد.';
      }
      return;
    }

    const oldSelection = selectedNorad;

    satellitesData = fresh;

    if (!satellitesData.some(s => s.norad === oldSelection)) {
      selectedNorad = null;
      pathLayer.clearLayers();
    }

    updateSatellitePositions();
    renderSatelliteList();

    if (details && !selectedNorad) {
      details.innerText =
        satellitesData.length +
        ' ماهواره از ' +
        successfulGroups +
        ' گروه دریافت شد.';
    }

  } catch (error) {
    console.error(error);

    if (details && !selectedNorad) {
      details.innerText = 'خطا در دریافت اطلاعات ماهواره‌ها.';
    }
  }
}

// =====================================================
// 7. SATELLITE POSITION
// =====================================================

function getSatellitePosition(sat, date) {
  const result = satellite.propagate(sat.satrec, date);

  if (!result || !result.position ||
      typeof result.position === 'boolean') {
    return null;
  }

  const gmst = satellite.gstime(date);

  const geo = satellite.eciToGeodetic(
    result.position,
    gmst
  );

  const lat = satellite.degreesLat(geo.latitude);
  const lon = satellite.degreesLong(geo.longitude);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }

  const v = result.velocity;

  const speed =
    v && typeof v !== 'boolean'
      ? Math.sqrt(v.x ** 2 + v.y ** 2 + v.z ** 2)
      : 0;

  return {
    lat,
    lon,
    altitude: geo.height,
    speed
  };
}

function updateSatellitePositions() {
  const now = new Date();

  satellitesData.forEach(sat => {
    try {
      const p = getSatellitePosition(sat, now);
      if (p) Object.assign(sat, p);
    } catch (e) {
      console.warn('Position error:', sat.name, e);
    }
  });

  updateMarkers();
  updateSelectedSatellite();
}

// =====================================================
// 8. SATELLITE MARKERS
// =====================================================

function updateMarkers() {
  satellitesData.forEach(sat => {
    if (!Number.isFinite(sat.lat) ||
        !Number.isFinite(sat.lon)) return;

    let marker = markerMap.get(sat.norad);

    if (!marker) {
      marker = L.circleMarker([sat.lat, sat.lon], {
        radius: 6,
        color: '#00e5ff',
        fillColor: '#008cff',
        fillOpacity: 0.95,
        weight: 2
      });

      marker.on('click', () => {
        showSatelliteInfo(sat.norad);
      });

      marker.addTo(markers);
      markerMap.set(sat.norad, marker);

    } else {
      marker.setLatLng([sat.lat, sat.lon]);
    }

    marker.bindPopup(`
      <div dir="rtl">
        <b>${escapeHTML(sat.name)}</b><br>
        NORAD: ${escapeHTML(sat.norad)}<br>
        ارتفاع: ${sat.altitude.toFixed(1)} کیلومتر
      </div>
    `);
  });

  for (const [id, marker] of markerMap) {
    if (!satellitesData.some(s => s.norad === id)) {
      markers.removeLayer(marker);
      markerMap.delete(id);
    }
  }
}

// =====================================================
// 9. ORBIT PATH
// =====================================================

function drawSatellitePath(norad) {
  pathLayer.clearLayers();

  const sat = satellitesData.find(
    s => s.norad === String(norad)
  );

  if (!sat) return;

  let segment = [];
  const segments = [];
  const now = Date.now();

  for (let t = 0; t <= 90 * 60000; t += 120000) {
    try {
      const p = getSatellitePosition(sat, new Date(now + t));
      if (!p) continue;

      if (segment.length &&
          Math.abs(p.lon - segment[segment.length - 1][1]) > 180) {
        if (segment.length > 1) segments.push(segment);
        segment = [];
      }

      segment.push([p.lat, p.lon]);

    } catch (e) {
      console.warn(e);
    }
  }

  if (segment.length > 1) segments.push(segment);

  segments.forEach(points => {
    L.polyline(points, {
      color: '#ffcc00',
      weight: 3,
      opacity: 0.9,
      dashArray: '8,7'
    }).addTo(pathLayer);
  });

  pathLayer.bringToFront();
}

// =====================================================
// 10. SELECT SATELLITE
// =====================================================

function showSatelliteInfo(norad) {
  const sat = satellitesData.find(
    s => s.norad === String(norad)
  );

  if (!sat) return;

  selectedNorad = sat.norad;
  drawSatellitePath(sat.norad);
  activateTab('info');
}

window.showSatelliteInfo = showSatelliteInfo;

// =====================================================
// 11. SATELLITE DETAILS
// =====================================================

function updateSelectedSatellite() {
  if (!selectedNorad) return;

  const sat = satellitesData.find(
    s => s.norad === selectedNorad
  );

  const details = document.getElementById('details');

  if (!sat || !details) return;

  details.innerHTML = `
    <div dir="rtl">
      <h3>🛰️ ${escapeHTML(sat.name)}</h3>
      <p>NORAD: ${escapeHTML(sat.norad)}</p>
      <p>گروه: ${escapeHTML(sat.group)}</p>
      <p>عرض جغرافیایی: ${sat.lat.toFixed(5)} درجه</p>
      <p>طول جغرافیایی: ${sat.lon.toFixed(5)} درجه</p>
      <p>ارتفاع: ${sat.altitude.toFixed(2)} کیلومتر</p>
      <p>سرعت: ${sat.speed.toFixed(3)} کیلومتر بر ثانیه</p>
      <p>آخرین محاسبه: ${new Date().toLocaleTimeString('fa-IR')}</p>

      <button type="button"
        onclick="predictSatellitePass('${escapeHTML(sat.norad)}')"
        style="width:100%;padding:14px;margin-top:12px;
        border:0;border-radius:10px;background:#087cf0;
        color:white;font-size:16px;font-weight:bold">
        🔭 پیش‌بینی زمان عبور ماهواره
      </button>
    </div>
  `;

  renderSatelliteCommunication();
}

// =====================================================
// 12. SATELLITE LIST
// =====================================================

function renderSatelliteList() {
  const list = document.getElementById('satelliteList');
  if (!list) return;

  list.innerHTML = '';

  satellitesData.forEach(sat => {
    const button = document.createElement('button');

    button.textContent =
      sat.name + ' | NORAD ' + sat.norad;

    button.style.cssText =
      'display:block;width:100%;margin:8px 0;padding:12px';

    button.onclick = () => {
      map.setView([sat.lat, sat.lon], 5);
      showSatelliteInfo(sat.norad);
    };

    list.appendChild(button);
  });
}

// =====================================================
// 13. GPS
// =====================================================

function getLocation() {
  const output = document.getElementById('location');

  if (!output) return;

  if (!navigator.geolocation) {
    output.innerText = 'GPS پشتیبانی نمی‌شود.';
    return;
  }

  output.innerText = 'در حال دریافت موقعیت GPS...';

  navigator.geolocation.getCurrentPosition(
    position => {
      const lat = position.coords.latitude;
      const lon = position.coords.longitude;

      userLocation = {
        lat,
        lon,
        altitude: position.coords.altitude || 0
      };
