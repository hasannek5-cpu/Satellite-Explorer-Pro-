
/* =====================================================
   🛰️ کاوشگر ماهواره - نسخه کامل اصلاح شده
   GPS + نقشه + مسیر مداری + پیش‌بینی عبور
   اطلاعات رادیویی + ✈️ پروازهای منطقه
   ===================================================== */

if (typeof L === 'undefined') {
  throw new Error('Leaflet بارگذاری نشده است.');
}

if (typeof satellite === 'undefined') {
  throw new Error('satellite.js بارگذاری نشده است.');
}

// =====================================================
// 1. نقشه
// =====================================================

const map = L.map('map').setView([25, 15], 2);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© OpenStreetMap'
}).addTo(map);

const markers = L.layerGroup().addTo(map);
const pathLayer = L.layerGroup().addTo(map);
const markerMap = new Map();

let satellitesData = [];
let userMarker = null;
let selectedNorad = null;
let userLocation = null;
let passSearchBusy = false;

// =====================================================
// 2. گروه‌های ماهواره‌ای
// =====================================================

const SATELLITE_GROUPS = [
  'stations',
  'weather',
  'noaa',
  'goes',
  'resource',
  'sarsat',
  'cubesat',
  'education',
  'amateur'
];

// =====================================================
// 3. اطلاعات رادیویی
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
// 4. ابزارهای عمومی
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

function showTab(tab) {
  const tabs = {
    map: document.getElementById('mapTab'),
    info: document.getElementById('infoTab'),
    gps: document.getElementById('gpsTab')
  };

  Object.entries(tabs).forEach(([name, el]) => {
    if (el) el.hidden = name !== tab;
  });

  if (tab === 'map') {
    setTimeout(() => map.invalidateSize(), 200);
  }
}

window.showTab = showTab;

// =====================================================
// 5. پردازش TLE
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
      const satrec = satellite.twoline2satrec(
        line1,
        line2
      );

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
// 6. دریافت ماهواره‌ها
// =====================================================

async function loadSatellites() {
  const details = document.getElementById('details');

  if (details && satellitesData.length === 0) {
    details.innerText =
      'در حال دریافت اطلاعات ماهواره‌ها...';
  }

  try {
    const results = await Promise.allSettled(
      SATELLITE_GROUPS.map(async group => {
        const url =
          'https://celestrak.org/NORAD/elements/gp.php?GROUP=' +
          encodeURIComponent(group) +
          '&FORMAT=tle';

        const response = await fetch(url);

        if (!response.ok) {
          throw new Error('HTTP ' + response.status);
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

    if (!satellitesData.some(
      s => s.norad === oldSelection
    )) {
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
      details.innerText =
        'خطا در دریافت اطلاعات ماهواره‌ها.';
    }
  }
}

// =====================================================
// 7. محاسبه موقعیت ماهواره
// =====================================================

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

  const lat = satellite.degreesLat(geo.latitude);
  const lon = satellite.degreesLong(geo.longitude);

  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon)
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

function updateSatellitePositions() {
  const now = new Date();

  satellitesData.forEach(sat => {
    try {
      const p = getSatellitePosition(sat, now);

      if (!p) return;

      Object.assign(sat, p);

    } catch (e) {
      console.warn('Position error:', sat.name, e);
    }
  });

  updateMarkers();
  updateSelectedSatellite();
}

// =====================================================
// 8. نشانگرهای ماهواره
// =====================================================

function updateMarkers() {
  satellitesData.forEach(sat => {
    if (
      !Number.isFinite(sat.lat) ||
      !Number.isFinite(sat.lon)
    ) {
      return;
    }

    let marker = markerMap.get(sat.norad);

    if (!marker) {
      marker = L.circleMarker(
        [sat.lat, sat.lon],
        {
          radius: 6,
          color: '#00e5ff',
          fillColor: '#008cff',
          fillOpacity: 0.95,
          weight: 2
        }
      );

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
// 9. رسم مسیر مداری
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

  for (
    let t = 0;
    t <= 90 * 60000;
    t += 120000
  ) {
    try {
      const p = getSatellitePosition(
        sat,
        new Date(now + t)
      );

      if (!p) continue;

      if (
        segment.length &&
        Math.abs(
          p.lon - segment[segment.length - 1][1]
        ) > 180
      ) {
        if (segment.length > 1) {
          segments.push(segment);
        }

        segment = [];
      }

      segment.push([p.lat, p.lon]);

    } catch (e) {
      console.warn(e);
    }
  }

  if (segment.length > 1) {
    segments.push(segment);
  }

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
// 10. انتخاب ماهواره
// =====================================================

function showSatelliteInfo(norad) {
  const sat = satellitesData.find(
    s => s.norad === String(norad)
  );

  if (!sat) return;

  selectedNorad = sat.norad;

  drawSatellitePath(sat.norad);

  showTab('info');

 earth: document.getElementById('earthTab')  
  updateSelectedSatellite();
}

window.showSatelliteInfo = showSatelliteInfo;

// =====================================================
// 11. نمایش اطلاعات ماهواره
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
        ${new Date().toLocaleTimeString('fa-IR')}
      </p>

      <button
        type="button"
        onclick="predictSatellitePass('${escapeHTML(sat.norad)}')"
        style="
          width:100%;
          padding:14px;
          margin-top:12px;
          border:0;
          border-radius:10px;
          background:#087cf0;
          color:white;
          font-size:16px;
          font-weight:bold
        ">
        🔭 پیش‌بینی زمان عبور ماهواره
      </button>
    </div>
  `;

  renderSatelliteCommunication();
}

// =====================================================
// 12. فهرست ماهواره‌ها
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
// 13. تنظیمات و دریافت GPS
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

      output.innerHTML =
        'عرض جغرافیایی: ' +
        lat.toFixed(5) +
        '<br>طول جغرافیایی: ' +
        lon.toFixed(5);

      if (userMarker) {
        map.removeLayer(userMarker);
      }

      userMarker = L.marker([lat, lon])
        .addTo(map)
        .bindPopup('موقعیت فعلی شما')
        .openPopup();

      map.setView([lat, lon], 7);

      showTab('map');

      // دریافت پروازها فقط بعد از موفقیت GPS
      if (typeof fetchAircraft === 'function') {
        fetchAircraft();
      }
    },

    error => {
      output.innerText =
        error.code === 1
          ? 'اجازه دسترسی به GPS داده نشد.'
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

// =====================================================
// 14. پنل پیش‌بینی
// =====================================================

function getPassPanel() {
  let panel = document.getElementById('passDetails');

  if (!panel) {
    panel = document.createElement('div');

    panel.id = 'passDetails';
    panel.dir = 'rtl';

    panel.style.cssText =
      'margin:12px 0;padding:15px;' +
      'border:1px solid #00bcd4;' +
      'border-radius:12px;' +
      'background:#101d30;color:white;line-height:2';

    const infoTab = document.getElementById('infoTab');

    (infoTab || document.body).appendChild(panel);
  }

  return panel;
}

// =====================================================
// 15. محاسبه زاویه دید ماهواره
// =====================================================

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
    longitude: userLocation.lon * Math.PI / 180,
    latitude: userLocation.lat * Math.PI / 180,
    height: (userLocation.altitude || 0) / 1000
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
    !Number.isFinite(elevation) ||
    !Number.isFinite(azimuth) ||
    !Number.isFinite(range)
  ) {
    return null;
  }

  return {
    elevation,
    azimuth,
    range
  };
}

// =====================================================
// 16. اصلاح دقیق زمان مرز عبور
// =====================================================

function refinePassBoundary(sat, left, right) {
  let low = left;
  let high = right;

  const first = calculateLook(sat, low);

  if (!first) {
    return new Date(high);
  }

  const initiallyVisible =
    first.elevation >= 0;

  for (let i = 0; i < 16; i++) {
    const mid = (low + high) / 2;

    const look = calculateLook(sat, mid);

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

// =====================================================
// 17. پیش‌بینی عبور در ۲۴ ساعت
// =====================================================

function predictSatellitePass(norad) {
  const panel = getPassPanel();

  if (!userLocation) {
    panel.innerText =
      'ابتدا GPS گوشی را دریافت کنید.';
    return;
  }

  if (passSearchBusy) return;

  const sat = satellitesData.find(
    s => s.norad === String(norad)
  );

  if (!sat || !sat.satrec) {
    panel.innerText =
      'اطلاعات مداری ماهواره یافت نشد.';
    return;
  }

  passSearchBusy = true;

  panel.innerText =
    'در حال محاسبه عبورهای ۲۴ ساعت آینده...';

  setTimeout(() => {
    try {
      const now = Date.now();

      const duration = 24 * 60 * 60 * 1000;
      const step = 30000;

      const passes = [];

      let currentPass = null;

      let previousTime = now;
      let previousLook = calculateLook(sat, now);

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

        const visible = look.elevation >= 0;

        const wasVisible =
          previousLook !== null &&
          previousLook.elevation >= 0;

        if (visible && !wasVisible) {
          currentPass = {
            start: previousLook
              ? refinePassBoundary(
                  sat,
                  previousTime,
                  timestamp
                )
              : new Date(timestamp),

            peak: look.elevation,
            peakTime: new Date(timestamp),
            maxAzimuth: look.azimuth,
            minRange: look.range,
            end: null
          };
        }

        if (visible && currentPass) {
          if (look.elevation > currentPass.peak) {
            currentPass.peak = look.elevation;
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
          currentPass.end = refinePassBoundary(
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

      const formatTime = date =>
        new Date(date).toLocaleString(
          'fa-IR',
          {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
          }
        );

      const durationText = (start, end) => {
        if (!end) {
          return 'ادامه عبور پس از پایان بازه بررسی';
        }

        const seconds = Math.round(
          (end - start) / 1000
        );

        return Math.floor(seconds / 60) +
          ' دقیقه و ' +
          (seconds % 60) +
          ' ثانیه';
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

        <p>تعداد عبورها: ${passes.length}</p>

        <hr>

        ${passes.map((p, i) => `
          <div style="
            background:#183652;
            padding:12px;
            margin:12px 0;
            border-radius:10px
          ">
            <h4>عبور شماره ${i + 1}</h4>

            <p>🟢 شروع: ${formatTime(p.start)}</p>

            <p>
              ⭐ اوج ارتفاع:
              ${p.peak.toFixed(2)} درجه
            </p>

            <p>
              🕒 زمان اوج:
              ${formatTime(p.peakTime)}
            </p>

            <p>
              🧭 جهت اوج:
              ${p.maxAzimuth.toFixed(1)} درجه
            </p>

            <p>
              📏 نزدیک‌ترین فاصله:
              ${p.minRange.toFixed(1)} کیلومتر
            </p>

            <p>
              🔴 پایان:
              ${p.end ? formatTime(p.end) : 'ادامه‌دار'}
            </p>

            <p>
              ⏱️ مدت:
              ${durationText(p.start, p.end)}
            </p>
          </div>
        `).join('')}

        <hr>

        <p style="color:#55dfff">
          زمان‌ها بر اساس ساعت محلی گوشی نمایش داده شده‌اند.
        </p>

        <p style="color:#ffd166;font-size:12px">
          پیش‌بینی به داده‌های TLE وابسته است و
          تضمین‌کننده مشاهده واقعی نیست.
        </p>
      `;

    } catch (error) {
      console.error(
        'Pass prediction error:',
        error
      );

      panel.innerText =
        'خطای پیش‌بینی: ' + error.message;

    } finally {
      passSearchBusy = false;
    }
  }, 50);
}

window.predictSatellitePass = predictSatellitePass;

// =====================================================
// 18. اطلاعات ارتباط ماهواره‌ای
// =====================================================

function renderSatelliteCommunication() {
  const details = document.getElementById('details');

  if (!details || !selectedNorad) return;

  const sat = satellitesData.find(
    s => s.norad === selectedNorad
  );

  if (!sat) return;

  const old = document.getElementById('radioPanel');

  if (old) old.remove();

  const data = RADIO_DATABASE[sat.norad];

  const panel = document.createElement('section');

  panel.id = 'radioPanel';
  panel.dir = 'rtl';

  panel.style.cssText =
    'margin-top:18px;padding:15px;' +
    'border:1px solid #00bcd4;' +
    'border-radius:12px;' +
    'background:#10243a;color:white;line-height:2';

  const heading = document.createElement('h3');

  heading.textContent =
    '📡 اطلاعات ارتباط ماهواره‌ای';

  panel.appendChild(heading);

  const name = document.createElement('p');

  name.textContent = 'ماهواره: ' + sat.name;

  panel.appendChild(name);

  const norad = document.createElement('p');

  norad.textContent =
    'شناسه NORAD: ' + sat.norad;

  panel.appendChild(norad);

  if (!data) {
    const message = document.createElement('p');

    message.textContent =
      'اطلاعات فرکانسی تأییدشده برای این ماهواره ' +
      'در پایگاه فعلی موجود نیست.';

    panel.appendChild(message);

  } else {
    const status = document.createElement('p');

    status.textContent =
      'وضعیت اطلاعات: ' + data.status;

    panel.appendChild(status);

    data.modes.forEach(mode => {
      const box = document.createElement('div');

      box.style.cssText =
        'margin-top:12px;padding:10px;' +
        'border-radius:9px;background:#183652';

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
    'نمایش فرکانس به معنی برقراری ارتباط واقعی نیست. ' +
    'ارسال رادیویی به تجهیزات و مجوز معتبر نیاز دارد.';

  panel.appendChild(warning);

  details.appendChild(panel);
}

// =====================================================
// 19. بخش پروازهای هواپیما
// =====================================================

const AIRCRAFT_RADIUS_KM = 20000;

const AIRCRAFT_REFRESH_MS =
  30 * 60 * 1000;

const aircraftLayer =
  L.layerGroup().addTo(map);

const aircraftMarkers = new Map();

let aircraftFetchBusy = false;

// فاصله بین دو نقطه جغرافیایی
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

// پنل پرواز روی نقشه
const aircraftControl = L.control({
  position: 'topright'
});

aircraftControl.onAdd = function () {
  const box = L.DomUtil.create('div');

  box.dir = 'rtl';

  box.style.cssText =
    'background:#10243a;color:white;' +
    'padding:12px;border:1px solid #00bcd4;' +
    'border-radius:12px;min-width:175px;' +
    'line-height:2;font-size:13px;' +
    'box-shadow:0 2px 8px #0006';

  box.innerHTML = `
    <b>✈️ پروازهای منطقه</b>

    <div id="aircraftStatus">
      منتظر دریافت GPS
    </div>

    <div id="aircraftCount"></div>

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
        font-weight:bold;
      ">
      دریافت پروازها
    </button>
  `;

  L.DomEvent.disableClickPropagation(box);
  L.DomEvent.disableScrollPropagation(box);

  const button = box.querySelector(
    '#aircraftRefreshButton'
  );

  L.DomEvent.on(
    button,
    'click',
    fetchAircraft
  );

  return box;
};

aircraftControl.addTo(map);

// وضعیت دریافت پرواز
function setAircraftStatus(message) {
  const el = document.getElementById(
    'aircraftStatus'
  );

  if (el) {
    el.textContent = message;
  }
}

// آیکون مستقل هواپیما
function createAircraftIcon(heading) {
  const direction =
    Number.isFinite(heading) ? heading : 0;

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
        filter:drop-shadow(1px 2px 2px #000);
      ">✈️</div>
    `,

    iconSize: [32, 32],
    iconAnchor: [16, 16]
  });
}

// اطلاعات پنجره هواپیما
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
    <div dir="rtl" style="line-height:2">
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

// دریافت مستقیم اطلاعات هواپیما
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

  const button = document.getElementById(
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
        'محدودیت تعداد درخواست؛ بعداً تلاش کنید.'
      );
    }

    if (response.status === 401 ||
        response.status === 403) {
      throw new Error(
        'دسترسی به اطلاعات پرواز از طرف API محدود شده است.'
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
        'اطلاعات پرواز معتبر نیست.'
      );
    }

    const found = new Map();

    result.states.forEach(state => {
      if (!Array.isArray(state) ||
          state.length < 11) {
        return;
      }

      const icao = state[0];
      const callsign = (state[1] || '').trim();
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
        !Number.isFinite(lat) ||
        !Number.isFinite(lon)
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

      if (distance > AIRCRAFT_RADIUS_KM) {
        return;
      }

      const altitude =
        Number.isFinite(geoAltitude)
          ? geoAltitude
          : Number.isFinite(baroAltitude)
            ? baroAltitude
            : null;

      found.set(icao, {
        icao,
        callsign,
        country,
        lat,
        lon,
        altitude,
        speed: Number.isFinite(speed)
          ? speed
          : null,
        heading: Number.isFinite(heading)
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
          createAircraftIcon(plane.heading)
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

    const count = document.getElementById(
      'aircraftCount'
    );

    if (count) {
      count.textContent =
        'تعداد هواپیماهای شناسایی‌شده: ' +
        found.size;
    }

    setAircraftStatus(
      'آخرین دریافت: ' +
      new Date().toLocaleTimeString('fa-IR')
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

// =====================================================
// 20. شروع برنامه
// =====================================================

loadSatellites();

// به‌روزرسانی موقعیت ماهواره‌ها هر ۵ ثانیه
setInterval(
  updateSatellitePositions,
  5000
);

// دریافت TLE جدید هر ۳۰ دقیقه
setInterval(
  loadSatellites,
  30 * 60 * 1000
);

// دریافت خودکار پروازها هر ۳۰ دقیقه
setInterval(() => {
  if (userLocation) {
    fetchAircraft();
  }
}, AIRCRAFT_REFRESH_MS);

console.log(
  '🛰️ Satellite Explorer Pro Loaded Successfully'
);

console.log(
  '✈️ Aircraft Tracking Loaded Successfully'
);
