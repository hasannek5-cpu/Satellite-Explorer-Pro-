
/* =========================================================
   🛰️ کاوشگر ماهواره Pro
   نسخه کامل و بهینه‌شده
   GPS + نقشه + ماهواره‌ها + مسیر مداری + پیش‌بینی عبور
   اطلاعات رادیویی + ردیابی پروازهای منطقه
   ========================================================= */

(() => {
'use strict';

// =========================================================
// 1. بررسی کتابخانه‌ها
// =========================================================

if (typeof L === 'undefined') {
  throw new Error('Leaflet بارگذاری نشده است.');
}

if (typeof satellite === 'undefined') {
  throw new Error('satellite.js بارگذاری نشده است.');
}

if (!document.getElementById('map')) {
  throw new Error('عنصر نقشه با شناسه map پیدا نشد.');
}

// جلوگیری از اجرای چندباره
if (window.SatelliteExplorerPro?.destroy) {
  window.SatelliteExplorerPro.destroy();
}

// =========================================================
// 2. تنظیمات اصلی
// =========================================================

const CONFIG = {
  satelliteGroups: [
    'stations',
    'weather',
    'noaa',
    'goes',
    'resource',
    'sarsat',
    'cubesat',
    'education',
    'amateur'
  ],

  satelliteRefreshMs: 30 * 60 * 1000,
  positionRefreshMs: 5000,
  aircraftRefreshMs: 30 * 60 * 1000,

  aircraftRadiusKm: 2000,

  passSearchHours: 24,
  passStepMs: 30000,
  passBoundaryIterations: 18,

  pathMinutes: 90,
  pathStepMs: 120000
};

// =========================================================
// 3. اطلاعات رادیویی
// =========================================================

const RADIO_DATABASE = {
  '25544': {
    title: 'ISS (ZARYA)',

    status:
      'اطلاعات رادیویی منتشرشده؛ وضعیت عملیاتی باید بررسی شود.',

    modes: [
      {
        name: 'APRS / Packet',
        uplink: '145.825 MHz',
        downlink: '145.825 MHz',
        protocol: 'AFSK / AX.25'
      },
      {
        name: 'رله صوتی FM',
        uplink: '145.990 MHz',
        downlink: '437.800 MHz',
        protocol: 'FM - CTCSS 67 Hz'
      }
    ],

    source:
      'https://www.amsat.org/amateur-radio-on-the-iss/'
  }
};

// =========================================================
// 4. متغیرهای اصلی
// =========================================================

let map;
let markers;
let pathLayer;
let aircraftLayer;

let userMarker = null;
let userLocation = null;

let selectedNorad = null;

let satellitesData = [];

let markerMap = new Map();
let aircraftMarkers = new Map();

let aircraftFetchBusy = false;
let passSearchBusy = false;
let satelliteFetchBusy = false;

let destroyed = false;
let timers = [];

// =========================================================
// 5. ابزارهای عمومی
// =========================================================

function byId(id) {
  return document.getElementById(id);
}

function finite(value) {
  return typeof value === 'number' &&
    Number.isFinite(value);
}

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[c]);
}

function setText(id, value) {
  const el = byId(id);

  if (el) {
    el.textContent = value;
  }
}

function addTimer(fn, delay) {
  const id = setInterval(fn, delay);

  timers.push(id);

  return id;
}

function formatLocalTime(date, withDate = true) {
  return new Date(date).toLocaleString(
    'fa-IR',
    {
      ...(withDate ? {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      } : {}),

      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }
  );
}

// =========================================================
// 6. طراحی و زیباسازی داشبورد
// =========================================================

function installExplorerStyles() {
  if (byId('satelliteExplorerStyles')) return;

  const style = document.createElement('style');

  style.id = 'satelliteExplorerStyles';

  style.textContent = `

    #map {
      isolation: isolate;
    }

    .aircraft-icon {
      background: transparent !important;
      border: 0 !important;
    }

    .satellite-explorer-control {
      direction: rtl;
      color: #eef7ff;
      background: rgba(8,24,43,.94);
      border: 1px solid rgba(0,210,255,.48);
      border-radius: 14px;
      box-shadow: 0 8px 26px rgba(0,0,0,.28);
      backdrop-filter: blur(9px);
      font: 13px/1.9 Tahoma,Arial,sans-serif;
    }

    .satellite-explorer-control button {
      cursor: pointer;
      transition: filter .2s, transform .2s;
    }

    .satellite-explorer-control button:hover {
      filter: brightness(1.13);
    }

    .satellite-explorer-control button:active {
      transform: scale(.98);
    }

    .satellite-explorer-control button:disabled {
      opacity: .55;
      cursor: wait;
    }

    .satellite-info-card {
      margin-top: 12px;
      padding: 14px;
      border-radius: 13px;
      background: linear-gradient(145deg,#102a45,#0b1b30);
      border: 1px solid rgba(0,210,255,.3);
      color: #edf7ff;
      line-height: 2;
      overflow-wrap: anywhere;
    }

    .satellite-info-card h3,
    .satellite-info-card h4 {
      color: #62ddff;
    }

    .satellite-list-button {
      display: block;
      width: 100%;
      margin: 7px 0;
      padding: 11px 12px;
      border: 1px solid #294967;
      border-radius: 10px;
      color: #eaf6ff;
      background: #102b46;
      text-align: right;
    }

    .satellite-list-button:hover {
      background: #17436a;
    }

    .satellite-popup {
      direction: rtl;
      line-height: 1.9;
    }

    .aircraft-popup {
      direction: rtl;
      line-height: 1.9;
      min-width: 190px;
    }

    .leaflet-control-attribution {
      font-size: 10px;
    }

    @media(max-width:600px) {

      .satellite-explorer-control {
        max-width: min(48vw,190px);
        font-size: 11px;
      }

      .satellite-explorer-control button {
        font-size: 12px !important;
      }

    }
  `;

  document.head.appendChild(style);
}

// =========================================================
// 7. راه‌اندازی نقشه
// =========================================================

function initializeMap() {

  map = L.map('map', {
    zoomControl: true,
    preferCanvas: true,
    worldCopyJump: true
  }).setView([25, 15], 2);

  L.tileLayer(
    'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    {
      attribution: '© OpenStreetMap contributors',
      maxZoom: 19
    }
  ).addTo(map);

  markers = L.layerGroup().addTo(map);

  pathLayer = L.layerGroup().addTo(map);

  aircraftLayer = L.layerGroup().addTo(map);
}

// =========================================================
// 8. مدیریت تب‌ها
// =========================================================

function showTab(tab) {

  const tabs = {
    map: byId('mapTab'),
    info: byId('infoTab'),
    gps: byId('gpsTab')
  };

  Object.entries(tabs).forEach(([name, el]) => {

    if (el) {
      el.hidden = name !== tab;
    }

  });

  if (tab === 'map' && map) {

    setTimeout(() => {
      map.invalidateSize(true);
    }, 180);

  }
}

window.showTab = showTab;

// =========================================================
// 9. پردازش اطلاعات TLE
// =========================================================

function parseTLE(content, group) {

  const lines = String(content)
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  const result = [];

  for (let i = 0; i < lines.length - 2; i++) {

    const name = lines[i].replace(/^0\s+/, '').trim();

    const line1 = lines[i + 1];
    const line2 = lines[i + 2];

    if (
      !line1.startsWith('1 ') ||
      !line2.startsWith('2 ')
    ) {
      continue;
    }

    const norad = line1.substring(2, 7).trim();

    if (
      !norad ||
      line2.substring(2, 7).trim() !== norad
    ) {
      i += 2;
      continue;
    }

    try {

      const satrec = satellite.twoline2satrec(
        line1,
        line2
      );

      if (!satrec || satrec.error) {
        i += 2;
        continue;
      }

      result.push({
        name: name || `ماهواره ${norad}`,
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

      console.warn(
        'TLE parse error:',
        name,
        error
      );

      i += 2;
    }
  }

  return result;
}

// =========================================================
// 10. دریافت ماهواره‌ها
// =========================================================

async function loadSatellites() {

  if (satelliteFetchBusy || destroyed) return;

  satelliteFetchBusy = true;

  const details = byId('details');

  if (
    details &&
    satellitesData.length === 0 &&
    !selectedNorad
  ) {
    details.textContent =
      'در حال دریافت اطلاعات ماهواره‌ها...';
  }

  try {

    const results = await Promise.allSettled(

      CONFIG.satelliteGroups.map(async group => {

        const url =
          'https://celestrak.org/NORAD/elements/gp.php?GROUP=' +
          encodeURIComponent(group) +
          '&FORMAT=tle';

        const response = await fetch(url, {
          method: 'GET',
          cache: 'no-store',
          headers: {
            Accept: 'text/plain'
          }
        });

        if (!response.ok) {
          throw new Error(
            `${group}: HTTP ${response.status}`
          );
        }

        return parseTLE(
          await response.text(),
          group
        );

      })

    );

    const dataMap = new Map();

    let successfulGroups = 0;

    results.forEach(result => {

      if (result.status !== 'fulfilled') {

        console.warn(
          'Satellite group failed:',
          result.reason
        );

        return;
      }

      successfulGroups++;

      result.value.forEach(sat => {

        if (!dataMap.has(sat.norad)) {
          dataMap.set(sat.norad, sat);
        }

      });

    });

    const fresh = [...dataMap.values()];

    if (!fresh.length) {

      if (details && !selectedNorad) {

        details.textContent =
          satellitesData.length
            ? 'دریافت جدید ناموفق بود؛ اطلاعات قبلی حفظ شده است.'
            : 'دریافت اطلاعات ماهواره‌ها ناموفق بود؛ اتصال اینترنت را بررسی کنید.';

      }

      return;
    }

    const previousSelection = selectedNorad;

    satellitesData = fresh;

    if (
      !satellitesData.some(
        s => s.norad === previousSelection
      )
    ) {

      selectedNorad = null;

      pathLayer.clearLayers();
    }

    updateSatellitePositions();

    renderSatelliteList();

    if (details && !selectedNorad) {

      details.textContent =
        `${satellitesData.length.toLocaleString('fa-IR')} ماهواره از ` +
        `${successfulGroups.toLocaleString('fa-IR')} گروه دریافت شد.`;

    }

  } catch (error) {

    console.error(
      'Satellite loading error:',
      error
    );

    if (details && !selectedNorad) {

      details.textContent =
        'خطا در دریافت اطلاعات ماهواره‌ها: ' +
        error.message;

    }

  } finally {

    satelliteFetchBusy = false;

  }
}

// =========================================================
// 11. محاسبه موقعیت ماهواره
// =========================================================

function getSatellitePosition(sat, date) {

  const result = satellite.propagate(
    sat.satrec,
    date
  );

  if (
    !result ||
    !result.position ||
    typeof result.position === 'boolean'
  ) {
    return null;
  }

  const gmst = satellite.gstime(date);

  const geo = satellite.eciToGeodetic(
    result.position,
    gmst
  );

  const lat = satellite.degreesLat(
    geo.latitude
  );

  const lon = satellite.degreesLong(
    geo.longitude
  );

  if (
    !finite(lat) ||
    !finite(lon) ||
    !finite(geo.height)
  ) {
    return null;
  }

  const v = result.velocity;

  const speed =
    v && typeof v !== 'boolean'
      ? Math.sqrt(
          v.x ** 2 +
          v.y ** 2 +
          v.z ** 2
        )
      : 0;

  return {
    lat,
    lon,
    altitude: geo.height,
    speed
  };
}

// =========================================================
// 12. به‌روزرسانی موقعیت ماهواره‌ها
// =========================================================

function updateSatellitePositions() {

  if (!satellitesData.length || destroyed) return;

  const now = new Date();

  satellitesData.forEach(sat => {

    try {

      const position = getSatellitePosition(
        sat,
        now
      );

      if (position) {
        Object.assign(sat, position);
      }

    } catch (error) {

      console.warn(
        'Position calculation error:',
        sat.name,
        error
      );

    }

  });

  updateMarkers();

  updateSelectedSatellite();
}

// =========================================================
// 13. نشانگرهای ماهواره
// =========================================================

function updateMarkers() {

  satellitesData.forEach(sat => {

    if (
      !finite(sat.lat) ||
      !finite(sat.lon)
    ) {
      return;
    }

    let marker = markerMap.get(sat.norad);

    if (!marker) {

      marker = L.circleMarker(
        [sat.lat, sat.lon],
        {
          radius: 5.5,
          color: '#b8f6ff',
          fillColor: '#00a9ff',
          fillOpacity: 0.94,
          weight: 1.7
        }
      );

      marker.on('click', () => {
        showSatelliteInfo(sat.norad);
      });

      marker.addTo(markers);

      markerMap.set(
        sat.norad,
        marker
      );

    } else {

      marker.setLatLng([
        sat.lat,
        sat.lon
      ]);

    }

    marker.bindPopup(`
      <div class="satellite-popup">
        <b>${escapeHTML(sat.name)}</b><br>
        NORAD: ${escapeHTML(sat.norad)}<br>
        ارتفاع: ${sat.altitude.toFixed(1)} کیلومتر
      </div>
    `);

  });

  for (const [id, marker] of markerMap) {

    if (
      !satellitesData.some(
        s => s.norad === id
      )
    ) {

      markers.removeLayer(marker);

      markerMap.delete(id);
    }

  }
}

// =========================================================
// 14. رسم مسیر مداری
// =========================================================

function drawSatellitePath(norad) {

  pathLayer.clearLayers();

  const sat = satellitesData.find(
    s => s.norad === String(norad)
  );

  if (!sat) return;

  let segment = [];

  const segments = [];

  const start = Date.now();

  for (
    let t = 0;
    t <= CONFIG.pathMinutes * 60000;
    t += CONFIG.pathStepMs
  ) {

    try {

      const p = getSatellitePosition(
        sat,
        new Date(start + t)
      );

      if (!p) continue;

      if (
        segment.length &&
        Math.abs(
          p.lon -
          segment[segment.length - 1][1]
        ) > 180
      ) {

        if (segment.length > 1) {
          segments.push(segment);
        }

        segment = [];
      }

      segment.push([
        p.lat,
        p.lon
      ]);

    } catch (error) {

      console.warn(
        'Orbit path error:',
        error
      );

    }

  }

  if (segment.length > 1) {
    segments.push(segment);
  }

  segments.forEach(points => {

    L.polyline(
      points,
      {
        color: '#ffd34e',
        weight: 3,
        opacity: 0.9,
        dashArray: '8,7',
        lineCap: 'round'
      }
    ).addTo(pathLayer);

  });

  pathLayer.bringToFront();
}

// =========================================================
// 15. انتخاب ماهواره
// =========================================================

function showSatelliteInfo(norad) {

  const sat = satellitesData.find(
    s => s.norad === String(norad)
  );

  if (!sat) return;

  selectedNorad = sat.norad;

  drawSatellitePath(sat.norad);

  showTab('info');

  updateSelectedSatellite();
}

window.showSatelliteInfo = showSatelliteInfo;

// =========================================================
// 16. نمایش اطلاعات ماهواره
// =========================================================

function updateSelectedSatellite() {

  if (!selectedNorad) return;

  const sat = satellitesData.find(
    s => s.norad === selectedNorad
  );

  const details = byId('details');

  if (!sat || !details) return;

  details.innerHTML = `
    <div class="satellite-info-card" dir="rtl">

      <h3>🛰️ ${escapeHTML(sat.name)}</h3>

      <p>شناسه NORAD: ${escapeHTML(sat.norad)}</p>

      <p>گروه: ${escapeHTML(sat.group)}</p>

      <p>
        عرض جغرافیایی:
        ${sat.lat.toFixed(5)} درجه
      </p>

      <p>
        طول جغرافیایی:
        ${sat.lon.toFixed(5)} درجه
      </p>

      <p>
        ارتفاع:
        ${sat.altitude.toFixed(2)} کیلومتر
      </p>

      <p>
        سرعت:
        ${sat.speed.toFixed(3)} کیلومتر بر ثانیه
      </p>

      <p>
        آخرین محاسبه:
        ${formatLocalTime(new Date(), false)}
      </p>

      <button
        type="button"
        onclick="predictSatellitePass('${escapeHTML(sat.norad)}')"
        style="
          width:100%;
          padding:13px;
          margin-top:10px;
          border:0;
          border-radius:10px;
          background:linear-gradient(90deg,#087cf0,#00a9c7);
          color:white;
          font-size:15px;
          font-weight:bold
        ">
        🔭 پیش‌بینی زمان عبور ماهواره
      </button>

    </div>
  `;

  renderSatelliteCommunication();
}

// =========================================================
// 17. فهرست ماهواره‌ها
// =========================================================

function renderSatelliteList() {

  const list = byId('satelliteList');

  if (!list) return;

  const fragment = document.createDocumentFragment();

  list.replaceChildren();

  satellitesData.forEach(sat => {

    const button = document.createElement('button');

    button.type = 'button';

    button.className = 'satellite-list-button';

    button.textContent =
      `${sat.name} | NORAD ${sat.norad}`;

    button.addEventListener('click', () => {

      if (
        finite(sat.lat) &&
        finite(sat.lon)
      ) {

        map.setView(
          [sat.lat, sat.lon],
          5
        );

      }

      showSatelliteInfo(sat.norad);

    });

    fragment.appendChild(button);

  });

  list.appendChild(fragment);
}

// =========================================================
// 18. دریافت موقعیت GPS
// =========================================================

function getLocation() {

  const output = byId('location');

  if (!output) return;

  if (!navigator.geolocation) {

    output.textContent =
      'GPS در این مرورگر پشتیبانی نمی‌شود.';

    return;
  }

  output.textContent =
    'در حال دریافت موقعیت GPS...';

  navigator.geolocation.getCurrentPosition(

    position => {

      const lat = position.coords.latitude;
      const lon = position.coords.longitude;

      userLocation = {
        lat,
        lon,
        altitude: finite(position.coords.altitude)
          ? position.coords.altitude
          : 0
      };

      output.innerHTML =
        `عرض جغرافیایی: ${lat.toFixed(5)}<br>` +
        `طول جغرافیایی: ${lon.toFixed(5)}`;

      if (userMarker) {
        map.removeLayer(userMarker);
      }

      userMarker = L.marker([
        lat,
        lon
      ])
        .addTo(map)
        .bindPopup('موقعیت فعلی شما')
        .openPopup();

      map.setView(
        [lat, lon],
        7
      );

      showTab('map');

      fetchAircraft();

    },

    error => {

      output.textContent =
        error.code === 1
          ? 'اجازه دسترسی به GPS داده نشد.'
          : error.code === 3
            ? 'زمان دریافت GPS تمام شد؛ دوباره تلاش کنید.'
            : 'دریافت موقعیت ناموفق بود.';

    },

    {
      enableHighAccuracy: true,
      timeout: 25000,
      maximumAge: 0
    }

  );
}

window.getLocation = getLocation;

// =========================================================
// 19. پنل پیش‌بینی عبور
// =========================================================

function getPassPanel() {

  let panel = byId('passDetails');

  if (!panel) {

    panel = document.createElement('section');

    panel.id = 'passDetails';

    panel.dir = 'rtl';

    panel.className = 'satellite-info-card';

    const infoTab = byId('infoTab');

    (infoTab || document.body).appendChild(panel);
  }

  return panel;
}

// =========================================================
// 20. محاسبه زاویه دید ماهواره
// =========================================================

function calculateLook(sat, timestamp) {

  if (!userLocation) return null;

  const date = new Date(timestamp);

  const result = satellite.propagate(
    sat.satrec,
    date
  );

  if (
    !result ||
    !result.position ||
    typeof result.position === 'boolean'
  ) {
    return null;
  }

  const observer = {

    longitude:
      userLocation.lon * Math.PI / 180,

    latitude:
      userLocation.lat * Math.PI / 180,

    height:
      (userLocation.altitude || 0) / 1000

  };

  const gmst = satellite.gstime(date);

  const ecf = satellite.eciToEcf(
    result.position,
    gmst
  );

  const look = satellite.ecfToLookAngles(
    observer,
    ecf
  );

  const elevation =
    look.elevation * 180 / Math.PI;

  const azimuth =
    (look.azimuth * 180 / Math.PI + 360) % 360;

  const range = look.rangeSat;

  if (
    ![
      elevation,
      azimuth,
      range
    ].every(Number.isFinite)
  ) {
    return null;
  }

  return {
    elevation,
    azimuth,
    range
  };
}

// =========================================================
// 21. دقیق‌سازی مرز عبور
// =========================================================

function refinePassBoundary(sat, left, right) {

  let low = left;
  let high = right;

  const first = calculateLook(sat, low);

  if (!first) {
    return new Date(high);
  }

  const initiallyVisible =
    first.elevation >= 0;

  for (
    let i = 0;
    i < CONFIG.passBoundaryIterations;
    i++
  ) {

    const mid = (low + high) / 2;

    const look = calculateLook(
      sat,
      mid
    );

    if (!look) break;

    if (
      (look.elevation >= 0) === initiallyVisible
    ) {
      low = mid;
    } else {
      high = mid;
    }

  }

  return new Date((low + high) / 2);
}

// =========================================================
// 22. پیش‌بینی عبور در ۲۴ ساعت آینده
// =========================================================

function predictSatellitePass(norad) {

  const panel = getPassPanel();

  if (!userLocation) {

    panel.textContent =
      'ابتدا موقعیت GPS گوشی را دریافت کنید.';

    return;
  }

  if (passSearchBusy) return;

  const sat = satellitesData.find(
    s => s.norad === String(norad)
  );

  if (!sat || !sat.satrec) {

    panel.textContent =
      'اطلاعات مداری ماهواره یافت نشد.';

    return;
  }

  passSearchBusy = true;

  panel.textContent =
    'در حال محاسبه عبورهای ۲۴ ساعت آینده...';

  setTimeout(() => {

    try {

      const now = Date.now();

      const duration =
        CONFIG.passSearchHours * 60 * 60 * 1000;

      const step = CONFIG.passStepMs;

      const passes = [];

      let previousTime = now;

      let previousLook = calculateLook(
        sat,
        now
      );

      let currentPass = null;

      // ثبت عبوری که هنگام شروع محاسبه در جریان است
      if (
        previousLook &&
        previousLook.elevation >= 0
      ) {

        currentPass = {

          start: null,

          ongoingAtStart: true,

          peak: previousLook.elevation,

          peakTime: new Date(now),

          maxAzimuth: previousLook.azimuth,

          minRange: previousLook.range,

          end: null

        };
      }

      for (
        let t = step;
        t <= duration;
        t += step
      ) {

        const timestamp = now + t;

        const look = calculateLook(
          sat,
          timestamp
        );

        if (!look) {

          previousTime = timestamp;
          previousLook = null;

          continue;
        }

        const visible =
          look.elevation >= 0;

        const wasVisible =
          previousLook !== null &&
          previousLook.elevation >= 0;

        if (
          visible &&
          !wasVisible &&
          !currentPass
        ) {

          currentPass = {

            start: previousLook
              ? refinePassBoundary(
                  sat,
                  previousTime,
                  timestamp
                )
              : new Date(timestamp),

            ongoingAtStart: false,

            peak: look.elevation,

            peakTime: new Date(timestamp),

            maxAzimuth: look.azimuth,

            minRange: look.range,

            end: null

          };
        }

        if (visible && currentPass) {

          if (look.elevation > currentPass.peak) {

            currentPass.peak =
              look.elevation;

            currentPass.peakTime =
              new Date(timestamp);

            currentPass.maxAzimuth =
              look.azimuth;
          }

          currentPass.minRange = Math.min(
            currentPass.minRange,
            look.range
          );
        }

        if (
          !visible &&
          wasVisible &&
          currentPass
        ) {

          currentPass.end =
            refinePassBoundary(
              sat,
              previousTime,
              timestamp
            );

          passes.push(currentPass);

          currentPass = null;
        }

        previousTime = timestamp;

        previousLook = look;
      }

      if (currentPass) {
        passes.push(currentPass);
      }

      const durationText = pass => {

        if (!pass.start || !pass.end) {

          return pass.ongoingAtStart
            ? 'عبور از ابتدای محاسبه در جریان بوده است'
            : 'ادامه عبور پس از پایان بازه بررسی';
        }

        const seconds = Math.max(
          0,
          Math.round(
            (pass.end - pass.start) / 1000
          )
        );

        return (
          Math.floor(seconds / 60) +
          ' دقیقه و ' +
          (seconds % 60) +
          ' ثانیه'
        );
      };

      if (!passes.length) {

        panel.innerHTML = `
          <h3>🛰️ نتیجه پیش‌بینی</h3>

          <p>ماهواره: ${escapeHTML(sat.name)}</p>

          <p>
            در ۲۴ ساعت آینده عبور قابل مشاهده‌ای
            پیش‌بینی نشد.
          </p>
        `;

        return;
      }

      panel.innerHTML = `

        <h3>🛰️ پیش‌بینی عبور ماهواره</h3>

        <p>نام: ${escapeHTML(sat.name)}</p>

        <p>NORAD: ${escapeHTML(sat.norad)}</p>

        <p>
          تعداد عبورها:
          ${passes.length.toLocaleString('fa-IR')}
        </p>

        <hr>

        ${passes.map((p, i) => `

          <div style="
            background:#153653;
            padding:13px;
            margin:12px 0;
            border-radius:11px;
            border:1px solid #285477
          ">

            <h4>عبور شماره ${i + 1}</h4>

            <p>
              🟢 شروع:
              ${p.start
                ? formatLocalTime(p.start)
                : 'قبل از شروع محاسبه'}
            </p>

            <p>
              ⭐ اوج ارتفاع:
              ${p.peak.toFixed(2)} درجه
            </p>

            <p>
              🕒 زمان اوج:
              ${formatLocalTime(p.peakTime)}
            </p>

            <p>
              🧭 جهت در اوج:
              ${p.maxAzimuth.toFixed(1)} درجه
            </p>

            <p>
              📏 نزدیک‌ترین فاصله:
              ${p.minRange.toFixed(1)} کیلومتر
            </p>

            <p>
              🔴 پایان:
              ${p.end
                ? formatLocalTime(p.end)
                : 'ادامه‌دار / خارج از بازه'}
            </p>

            <p>
              ⏱️ مدت:
              ${durationText(p)}
            </p>

          </div>

        `).join('')}

        <hr>

        <p style="color:#55dfff">
          زمان‌ها بر اساس ساعت محلی گوشی نمایش داده شده‌اند.
        </p>

        <p style="color:#ffd166;font-size:12px">
          پیش‌بینی به دقت و تازگی داده‌های TLE وابسته است
          و تضمین‌کننده مشاهده واقعی نیست.
        </p>

      `;

    } catch (error) {

      console.error(
        'Pass prediction error:',
        error
      );

      panel.textContent =
        'خطای پیش‌بینی: ' + error.message;

    } finally {

      passSearchBusy = false;

    }

  }, 40);
}

window.predictSatellitePass =
  predictSatellitePass;

// =========================================================
// 23. اطلاعات ارتباط ماهواره‌ای
// =========================================================

function renderSatelliteCommunication() {

  const details = byId('details');

  if (!details || !selectedNorad) return;

  const sat = satellitesData.find(
    s => s.norad === selectedNorad
  );

  if (!sat) return;

  byId('radioPanel')?.remove();

  const data = RADIO_DATABASE[sat.norad];

  const panel = document.createElement('section');

  panel.id = 'radioPanel';

  panel.dir = 'rtl';

  panel.className = 'satellite-info-card';

  const heading = document.createElement('h3');

  heading.textContent =
    '📡 اطلاعات ارتباط ماهواره‌ای';

  panel.appendChild(heading);

  const identity = document.createElement('p');

  identity.textContent =
    `ماهواره: ${sat.name} | شناسه NORAD: ${sat.norad}`;

  panel.appendChild(identity);

  if (!data) {

    const message = document.createElement('p');

    message.textContent =
      'اطلاعات فرکانسی تأییدشده برای این ماهواره در پایگاه فعلی موجود نیست.';

    panel.appendChild(message);

  } else {

    const status = document.createElement('p');

    status.textContent =
      'وضعیت اطلاعات: ' + data.status;

    panel.appendChild(status);

    data.modes.forEach(mode => {

      const box = document.createElement('div');

      box.style.cssText =
        'margin-top:12px;padding:12px;border-radius:10px;background:#183652';

      const title = document.createElement('h4');

      title.textContent = mode.name;

      const up = document.createElement('p');

      up.textContent =
        'فرکانس ارسال: ' + mode.uplink;

      const down = document.createElement('p');

      down.textContent =
        'فرکانس دریافت: ' + mode.downlink;

      const protocol = document.createElement('p');

      protocol.textContent =
        'پروتکل: ' + mode.protocol;

      box.append(
        title,
        up,
        down,
        protocol
      );

      panel.appendChild(box);
    });

    const source = document.createElement('a');

    source.href = data.source;

    source.target = '_blank';

    source.rel = 'noopener noreferrer';

    source.textContent =
      'مشاهده منبع اطلاعات';

    source.style.cssText =
      'display:block;margin-top:12px;color:#55dfff';

    panel.appendChild(source);
  }

  const warning = document.createElement('p');

  warning.style.color = '#ffd166';

  warning.textContent =
    'نمایش فرکانس به معنی برقراری ارتباط واقعی نیست. ارسال رادیویی به تجهیزات و مجوز معتبر نیاز دارد.';

  panel.appendChild(warning);

  details.appendChild(panel);
}

// =========================================================
// 24. محاسبه فاصله هواپیما
// =========================================================

function aircraftDistanceKm(
  lat1,
  lon1,
  lat2,
  lon2
) {

  const R = 6371;

  const rad = x => x * Math.PI / 180;

  const dLat = rad(lat2 - lat1);

  const dLon = rad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) *
    Math.cos(rad(lat2)) *
    Math.sin(dLon / 2) ** 2;

  return 2 * R * Math.atan2(
    Math.sqrt(a),
    Math.sqrt(1 - a)
  );
}

// =========================================================
// 25. کنترل پرواز روی نقشه
// =========================================================

const aircraftControl = L.control({
  position: 'topright'
});

aircraftControl.onAdd = function () {

  const box = L.DomUtil.create(
    'div',
    'satellite-explorer-control'
  );

  box.style.cssText +=
    'padding:11px;min-width:175px;max-width:210px';

  box.innerHTML = `

    <div style="
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:8px
    ">

      <b>✈️ پروازهای منطقه</b>

      <button
        id="aircraftCollapse"
        type="button"
        aria-label="جمع کردن پنل"
        style="
          border:0;
          border-radius:7px;
          background:#214766;
          color:white;
          padding:2px 8px
        "
      >−</button>

    </div>

    <div id="aircraftControlBody">

      <div
        id="aircraftStatus"
        style="color:#bfeeff"
      >
        منتظر دریافت GPS
      </div>

      <div
        id="aircraftCount"
        style="color:#dceeff"
      ></div>

      <button
        id="aircraftRefreshButton"
        type="button"
        style="
          width:100%;
          padding:9px;
          margin-top:7px;
          border:0;
          border-radius:8px;
          background:#087cf0;
          color:white;
          font-weight:bold
        "
      >
        دریافت پروازها
      </button>

    </div>
  `;

  L.DomEvent.disableClickPropagation(box);

  L.DomEvent.disableScrollPropagation(box);

  L.DomEvent.on(
    box.querySelector('#aircraftRefreshButton'),
    'click',
    fetchAircraft
  );

  L.DomEvent.on(
    box.querySelector('#aircraftCollapse'),
    'click',
    () => {

      const body = box.querySelector(
        '#aircraftControlBody'
      );

      const button = box.querySelector(
        '#aircraftCollapse'
      );

      body.hidden = !body.hidden;

      button.textContent =
        body.hidden ? '+' : '−';

    }
  );

  return box;
};

// =========================================================
// 26. وضعیت پرواز
// =========================================================

function setAircraftStatus(message) {

  setText(
    'aircraftStatus',
    message
  );
}

// =========================================================
// 27. آیکون هواپیما
// =========================================================

function createAircraftIcon(heading) {

  const direction = finite(heading)
    ? heading
    : 0;

  return L.divIcon({

    className: 'aircraft-icon',

    html: `
      <div style="
        font-size:25px;
        width:32px;
        height:32px;
        display:flex;
        align-items:center;
        justify-content:center;
        transform:rotate(${direction}deg);
        filter:drop-shadow(1px 2px 2px #000)
      ">✈️</div>
    `,

    iconSize: [32, 32],

    iconAnchor: [16, 16]

  });
}

// =========================================================
// 28. اطلاعات پنجره هواپیما
// =========================================================

function aircraftPopup(plane) {

  const altitude =
    plane.altitude === null
      ? 'نامشخص'
      : (plane.altitude / 1000).toFixed(2) +
        ' کیلومتر';

  const speed =
    plane.speed === null
      ? 'نامشخص'
      : (plane.speed * 3.6).toFixed(1) +
        ' کیلومتر بر ساعت';

  const heading =
    plane.heading === null
      ? 'نامشخص'
      : plane.heading.toFixed(1) +
        ' درجه';

  return `

    <div class="aircraft-popup">

      <h3>✈️ اطلاعات پرواز</h3>

      <p>
        شناسه هواپیما:
        ${escapeHTML(plane.icao)}
      </p>

      <p>
        شماره پرواز:
        ${escapeHTML(plane.callsign || 'نامشخص')}
      </p>

      <p>
        کشور:
        ${escapeHTML(plane.country || 'نامشخص')}
      </p>

      <p>ارتفاع: ${altitude}</p>

      <p>سرعت: ${speed}</p>

      <p>جهت حرکت: ${heading}</p>

      <p>
        فاصله از GPS:
        ${plane.distance.toFixed(1)} کیلومتر
      </p>

      <p>
        مبدأ و مقصد:
        در داده فعلی موجود نیست
      </p>

    </div>

  `;
}

// =========================================================
// 29. دریافت مستقیم اطلاعات هواپیما
// =========================================================

async function fetchAircraft() {

  if (aircraftFetchBusy) return;

  if (!userLocation) {

    setAircraftStatus(
      'ابتدا GPS گوشی را دریافت کنید.'
    );

    return;
  }

  aircraftFetchBusy = true;

  setAircraftStatus(
    'در حال دریافت اطلاعات پروازها...'
  );

  const button = byId(
    'aircraftRefreshButton'
  );

  if (button) {
    button.disabled = true;
  }

  try {

    const response = await fetch(
      'https://opensky-network.org/api/states/all',
      {
        method: 'GET',
        cache: 'no-store',
        headers: {
          Accept: 'application/json'
        }
      }
    );

    if (response.status === 429) {

      throw new Error(
        'محدودیت تعداد درخواست؛ کمی بعد دوباره تلاش کنید.'
      );
    }

    if (
      response.status === 401 ||
      response.status === 403
    ) {

      throw new Error(
        'دسترسی به اطلاعات پرواز از طرف سرویس محدود شده است.'
      );
    }

    if (!response.ok) {

      throw new Error(
        'خطای API: HTTP ' + response.status
      );
    }

    const result = await response.json();

    if (!Array.isArray(result.states)) {

      throw new Error(
        'اطلاعات پرواز معتبر نیست یا سرویس داده‌ای برنگرداند.'
      );
    }

    const found = new Map();

    result.states.forEach(state => {

      if (
        !Array.isArray(state) ||
        state.length < 11
      ) {
        return;
      }

      const icao = state[0];

      const callsign =
        (state[1] || '').trim();

      const country = state[2] || '';

      const lon = state[5];

      const lat = state[6];

      const baroAltitude = state[7];

      const onGround = state[8];

      const speed = state[9];

      const heading = state[10];

      const geoAltitude = state[13];

      if (
        !icao ||
        !finite(lat) ||
        !finite(lon)
      ) {
        return;
      }

      // حذف هواپیماهای روی زمین
      if (onGround === true) return;

      const distance = aircraftDistanceKm(
        userLocation.lat,
        userLocation.lon,
        lat,
        lon
      );

      if (
        distance > CONFIG.aircraftRadiusKm
      ) {
        return;
      }

      const altitude = finite(geoAltitude)
        ? geoAltitude
        : finite(baroAltitude)
          ? baroAltitude
          : null;

      found.set(icao, {

        icao,
        callsign,
        country,
        lat,
        lon,
        altitude,

        speed: finite(speed)
          ? speed
          : null,

        heading: finite(heading)
          ? heading
          : null,

        distance

      });

    });

    // به‌روزرسانی هواپیماها
    found.forEach(plane => {

      let marker = aircraftMarkers.get(
        plane.icao
      );

      if (!marker) {

        marker = L.marker(
          [plane.lat, plane.lon],
          {
            icon: createAircraftIcon(
              plane.heading
            )
          }
        );

        aircraftMarkers.set(
          plane.icao,
          marker
        );

        marker.addTo(aircraftLayer);

      } else {

        marker.setLatLng([
          plane.lat,
          plane.lon
        ]);

        marker.setIcon(
          createAircraftIcon(
            plane.heading
          )
        );

      }

      marker.bindPopup(
        aircraftPopup(plane)
      );

    });

    // حذف هواپیماهای قدیمی
    for (const [icao, marker] of aircraftMarkers) {

      if (!found.has(icao)) {

        aircraftLayer.removeLayer(marker);

        aircraftMarkers.delete(icao);
      }

    }

    setText(
      'aircraftCount',
      'تعداد هواپیماهای شناسایی‌شده: ' +
      found.size.toLocaleString('fa-IR')
    );

    setAircraftStatus(
      'آخرین دریافت: ' +
      formatLocalTime(new Date(), false)
    );

  } catch (error) {

    console.error(
      'Aircraft API error:',
      error
    );

    setAircraftStatus(
      'خطا در دریافت: ' + error.message
    );

  } finally {

    aircraftFetchBusy = false;

    if (button) {
      button.disabled = false;
    }

  }
}

window.fetchAircraft = fetchAircraft;

// =========================================================
// 30. پاک‌سازی و مدیریت برنامه
// =========================================================

function destroy() {

  destroyed = true;

  timers.forEach(clearInterval);

  timers = [];

  if (map) {
    map.remove();
  }
}

window.SatelliteExplorerPro = {

  destroy,

  loadSatellites,

  updateSatellitePositions,

  showSatelliteInfo,

  getLocation,

  predictSatellitePass,

  fetchAircraft

};

// =========================================================
// 31. شروع برنامه
// =========================================================

installExplorerStyles();

initializeMap();

aircraftControl.addTo(map);

// دریافت ماهواره‌ها
loadSatellites();

// به‌روزرسانی موقعیت ماهواره‌ها هر ۵ ثانیه
addTimer(
  updateSatellitePositions,
  CONFIG.positionRefreshMs
);

// دریافت TLE جدید هر ۳۰ دقیقه
addTimer(
  loadSatellites,
  CONFIG.satelliteRefreshMs
);

// دریافت خودکار پروازها هر ۳۰ دقیقه
addTimer(() => {

  if (userLocation) {
    fetchAircraft();
  }

}, CONFIG.aircraftRefreshMs);

console.log(
  '🛰️ Satellite Explorer Pro Loaded Successfully'
);

console.log(
  '✈️ Aircraft Tracking Loaded Successfully'
);

})();
