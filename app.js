
// ==========================================
// کاوشگر ماهواره - نسخه کامل اصلاح شده
// پیش‌بینی عبور ماهواره + GPS + مسیر مداری
// ==========================================

// بررسی بارگذاری کتابخانه‌ها
if (typeof L === 'undefined') {
  throw new Error('کتابخانه Leaflet بارگذاری نشده است.');
}

if (typeof satellite === 'undefined') {
  throw new Error('کتابخانه satellite.js بارگذاری نشده است.');
}

// ==========================================
// ایجاد نقشه
// ==========================================

const map = L.map('map').setView([25, 15], 2);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© OpenStreetMap'
}).addTo(map);

// لایه‌های نقشه
const markers = L.layerGroup().addTo(map);
const pathLayer = L.layerGroup().addTo(map);
const markerMap = new Map();

// متغیرهای اصلی
let satellitesData = [];
let userMarker = null;
let selectedNorad = null;
let userLocation = null;
let passSearchBusy = false;

// گروه‌های ماهواره‌های غیرنظامی
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

// ==========================================
// مدیریت تب‌ها
// ==========================================

function showTab(tab) {
  const mapTab = document.getElementById('mapTab');
  const infoTab = document.getElementById('infoTab');
  const gpsTab = document.getElementById('gpsTab');

  if (mapTab) mapTab.hidden = tab !== 'map';
  if (infoTab) infoTab.hidden = tab !== 'info';
  if (gpsTab) gpsTab.hidden = tab !== 'gps';

  if (tab === 'map') {
    setTimeout(() => map.invalidateSize(), 200);
  }
}

// ==========================================
// جلوگیری از تزریق HTML
// ==========================================

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[c]);
}

// ==========================================
// تبدیل اطلاعات TLE به ماهواره
// ==========================================

function parseTLE(content, group) {
  const lines = content
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  const result = [];

  for (let i = 0; i < lines.length - 2; i++) {
    let name = lines[i];

    if (name.startsWith('0 ')) {
      name = name.substring(2);
    }

    const line1 = lines[i + 1];
    const line2 = lines[i + 2];

    if (
      !line1.startsWith('1 ') ||
      !line2.startsWith('2 ')
    ) {
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
      console.warn('خطای TLE:', name, error);
    }
  }

  return result;
}

// ==========================================
// دریافت اطلاعات ماهواره‌ها
// ==========================================

async function loadSatellites() {
  const details = document.getElementById('details');

  if (details && satellitesData.length === 0) {
    details.innerText =
      'در حال دریافت اطلاعات ماهواره‌های غیرنظامی...';
  }

  try {
    const results = await Promise.allSettled(
      SATELLITE_GROUPS.map(async group => {
        const url =
          'https://celestrak.org/NORAD/elements/gp.php' +
          '?GROUP=' + encodeURIComponent(group) +
          '&FORMAT=tle';

        const response = await fetch(url);

        if (!response.ok) {
          throw new Error(
            group + ': HTTP ' + response.status
          );
        }

        const content = await response.text();

        return parseTLE(content, group);
      })
    );

    const satelliteMap = new Map();
    let successfulGroups = 0;

    results.forEach((result, index) => {
      if (result.status !== 'fulfilled') {
        console.warn(
          'دریافت گروه ناموفق:',
          SATELLITE_GROUPS[index],
          result.reason
        );
        return;
      }

      successfulGroups++;

      result.value.forEach(sat => {
        if (!satelliteMap.has(sat.norad)) {
          satelliteMap.set(sat.norad, sat);
        }
      });
    });

    const newSatellites = Array.from(
      satelliteMap.values()
    );

    if (newSatellites.length === 0) {
      if (details) {
        details.innerText =
          'دریافت اطلاعات ناموفق بود. اطلاعات قبلی حفظ شد.';
      }
      return;
    }

    satellitesData = newSatellites;

    updateSatellitePositions();
    renderSatelliteList();

    if (details && !selectedNorad) {
      details.innerText =
        satellitesData.length +
        ' ماهواره دریافت شد از ' +
        successfulGroups +
        ' گروه اطلاعاتی';
    }

  } catch (error) {
    console.error('خطای دریافت ماهواره‌ها:', error);

    if (details && !selectedNorad) {
      details.innerText =
        'خطا در دریافت اطلاعات ماهواره‌ها';
    }
  }
}

// ==========================================
// محاسبه موقعیت ماهواره‌ها
// ==========================================

function updateSatellitePositions() {
  const now = new Date();

  satellitesData.forEach(sat => {
    try {
      const result = satellite.propagate(
        sat.satrec,
        now
      );

      const position = result.position;
      const velocity = result.velocity;

      if (
        !position ||
        typeof position === 'boolean'
      ) {
        return;
      }

      const gmst = satellite.gstime(now);

      const geo = satellite.eciToGeodetic(
        position,
        gmst
      );

      const lat = satellite.degreesLat(
        geo.latitude
      );

      const lon = satellite.degreesLong(
        geo.longitude
      );

      if (
        !Number.isFinite(lat) ||
        !Number.isFinite(lon)
      ) {
        return;
      }

      sat.lat = lat;
      sat.lon = lon;
      sat.altitude = geo.height;

      if (
        velocity &&
        typeof velocity !== 'boolean'
      ) {
        sat.speed = Math.sqrt(
          velocity.x ** 2 +
          velocity.y ** 2 +
          velocity.z ** 2
        );
      }

    } catch (error) {
      console.warn(
        'محاسبه موقعیت ناموفق:',
        sat.name,
        error
      );
    }
  });

  updateMarkers();
  updateSelectedSatellite();
}

// ==========================================
// نمایش نقاط آبی ماهواره‌ها
// ==========================================

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
      marker.setLatLng([
        sat.lat,
        sat.lon
      ]);
    }

    marker.bindPopup(`
      <div dir="rtl">
        <b>${escapeHTML(sat.name)}</b><br>
        NORAD: ${sat.norad}<br>
        گروه: ${escapeHTML(sat.group)}<br>
        ارتفاع: ${sat.altitude.toFixed(1)} کیلومتر
      </div>
    `);
  });

  // حذف نقاط ماهواره‌های حذف‌شده
  for (const [id, marker] of markerMap) {
    if (!satellitesData.some(s => s.norad === id)) {
      markers.removeLayer(marker);
      markerMap.delete(id);
    }
  }
}

// ==========================================
// رسم مسیر حرکت ماهواره
// ==========================================

function drawSatellitePath(norad) {
  pathLayer.clearLayers();

  const sat = satellitesData.find(
    item => item.norad === String(norad)
  );

  if (!sat) return;

  const segments = [];
  let segment = [];

  const now = Date.now();
  const duration = 90 * 60 * 1000;
  const step = 2 * 60 * 1000;

  for (let t = 0; t <= duration; t += step) {
    const date = new Date(now + t);

    try {
      const result = satellite.propagate(
        sat.satrec,
        date
      );

      if (
        !result.position ||
        typeof result.position === 'boolean'
      ) {
        continue;
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
        !Number.isFinite(lat) ||
        !Number.isFinite(lon)
      ) {
        continue;
      }

      // جلوگیری از اتصال اشتباه در مرز نقشه
      if (
        segment.length &&
        Math.abs(
          lon - segment[segment.length - 1][1]
        ) > 180
      ) {
        if (segment.length > 1) {
          segments.push(segment);
        }

        segment = [];
      }

      segment.push([lat, lon]);

    } catch (error) {
      console.warn('خطای محاسبه مسیر:', error);
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
      dashArray: '8, 7'
    }).addTo(pathLayer);
  });

  pathLayer.bringToFront();
}

// ==========================================
// نمایش اطلاعات ماهواره انتخاب‌شده
// ==========================================

function showSatelliteInfo(norad) {
  const sat = satellitesData.find(
    item => item.norad === String(norad)
  );

  if (!sat) return;

  selectedNorad = sat.norad;

  drawSatellitePath(sat.norad);

  showTab('info');

  updateSelectedSatellite();
}

// ==========================================
// مرحله ۱: اطلاعات + دکمه پیش‌بینی عبور
// ==========================================

function updateSelectedSatellite() {
  if (!selectedNorad) return;

  const sat = satellitesData.find(
    item => item.norad === selectedNorad
  );

  if (!sat) return;

  const details = document.getElementById('details');

  if (!details) return;

  details.innerHTML = `
    <div dir="rtl">

      <h3>🛰️ ${escapeHTML(sat.name)}</h3>

      <p>شناسه NORAD: ${sat.norad}</p>

      <p>
        گروه ماهواره:
        ${escapeHTML(sat.group)}
      </p>

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
        onclick="predictSatellitePass('${sat.norad}')"
        style="
          width:100%;
          padding:14px;
          margin-top:12px;
          border:0;
          border-radius:10px;
          background:#087cf0;
          color:white;
          font-size:16px;
          font-weight:bold;
          cursor:pointer;
        ">
        🔭 پیش‌بینی زمان عبور ماهواره
      </button>

    </div>
  `;
}

// ==========================================
// نمایش فهرست ماهواره‌ها
// ==========================================

function renderSatelliteList() {
  const list = document.getElementById('satelliteList');

  if (!list) return;

  list.innerHTML = '';

  satellitesData.forEach(sat => {
    const button = document.createElement('button');

    button.textContent =
      sat.name + ' | NORAD ' + sat.norad;

    button.style.display = 'block';
    button.style.width = '100%';
    button.style.margin = '8px 0';
    button.style.padding = '12px';

    button.onclick = () => {
      map.setView([sat.lat, sat.lon], 5);
      showSatelliteInfo(sat.norad);
    };

    list.appendChild(button);
  });
}

// ==========================================
// دریافت موقعیت GPS گوشی
// ==========================================

function getLocation() {
  const output = document.getElementById('location');

  if (!output) return;

  if (!navigator.geolocation) {
    output.innerText = 'GPS پشتیبانی نمی‌شود';
    return;
  }

  output.innerText = 'در حال دریافت موقعیت...';

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
        'عرض جغرافیایی: ' + lat.toFixed(5) +
        '<br>طول جغرافیایی: ' + lon.toFixed(5);

      if (userMarker) {
        map.removeLayer(userMarker);
      }

      userMarker = L.marker([lat, lon])
        .addTo(map)
        .bindPopup('موقعیت فعلی شما')
        .openPopup();

      map.setView([lat, lon], 7);

      showTab('map');
    },

    error => {
      output.innerText =
        error.code === 1
          ? 'اجازه دسترسی به GPS داده نشد'
          : 'دریافت موقعیت ناموفق بود';
    },

    {
      enableHighAccuracy: true,
      timeout: 20000,
      maximumAge: 0
    }
  );
}

// ==========================================
// مرحله ۲: ساخت پنل پیش‌بینی عبور
// ==========================================

function getPassPanel() {
  let panel = document.getElementById('passDetails');

  if (!panel) {
    panel = document.createElement('div');

    panel.id = 'passDetails';
    panel.dir = 'rtl';

    panel.style.cssText = `
      margin:12px 0;
      padding:15px;
      border:1px solid #00bcd4;
      border-radius:12px;
      background:#101d30;
      color:white;
      line-height:2;
    `;

    const infoTab = document.getElementById('infoTab');

    if (infoTab) {
      infoTab.appendChild(panel);
    } else {
      document.body.appendChild(panel);
    }
  }

  return panel;
}

// ==========================================
// پیش‌بینی عبور ماهواره در ۲۴ ساعت آینده
// ==========================================

function predictSatellitePass(norad) {
  const panel = getPassPanel();

  if (!userLocation) {
    panel.innerText =
      'ابتدا موقعیت GPS گوشی را دریافت کنید.';
    return;
  }

  if (passSearchBusy) return;

  const sat = satellitesData.find(
    item => item.norad === String(norad)
  );

  if (!sat || !sat.satrec) {
    panel.innerText =
      'اطلاعات مداری ماهواره یافت نشد.';
    return;
  }

  passSearchBusy = true;

  panel.innerText =
    'در حال محاسبه عبور ماهواره در ۲۴ ساعت آینده...';

  try {
    const observer = {
      longitude: userLocation.lon * Math.PI / 180,
      latitude: userLocation.lat * Math.PI / 180,
      height: (userLocation.altitude || 0) / 1000
    };

    const now = Date.now();
    const duration = 24 * 60 * 60 * 1000;
    const step = 30 * 1000;

    const passes = [];
    let currentPass = null;

    for (let t = 0; t <= duration; t += step) {
      const date = new Date(now + t);

      let result;

      try {
        result = satellite.propagate(
          sat.satrec,
          date
        );
      } catch (error) {
        continue;
      }

      if (
        !result.position ||
        typeof result.position === 'boolean'
      ) {
        continue;
      }

      const gmst = satellite.gstime(date);

      const positionEcf = satellite.eciToEcf(
        result.position,
        gmst
      );

      const look = satellite.ecfToLookAngles(
        observer,
        positionEcf
      );

      const elevation =
        look.elevation * 180 / Math.PI;

      const range = look.rangeSat;

      if (
        !Number.isFinite(elevation) ||
        !Number.isFinite(range)
      ) {
        continue;
      }

      if (elevation >= 0) {
        if (!currentPass) {
          currentPass = {
            start: date,
            peak: elevation,
            peakTime: date,
            minRange: range,
            end: null
          };
        }

        if (elevation > currentPass.peak) {
          currentPass.peak = elevation;
          currentPass.peakTime = date;
        }

        currentPass.minRange = Math.min(
          currentPass.minRange,
          range
        );

      } else if (currentPass) {
        currentPass.end = date;
        passes.push(currentPass);
        currentPass = null;
      }
    }

    if (currentPass) {
      passes.push(currentPass);
    }

    if (passes.length === 0) {
      panel.innerText =
        'در ۲۴ ساعت آینده عبوری برای این ماهواره پیش‌بینی نشد.';
      return;
    }

    const formatTime = date =>
      date.toLocaleString('fa-IR');

    const first = passes[0];

    panel.innerHTML = `
      <h3>🛰️ پیش‌بینی عبور ماهواره</h3>

      <p>
        نام ماهواره:
        ${escapeHTML(sat.name)}
      </p>

      <p>NORAD: ${sat.norad}</p>

      <hr>

      <p>
        شروع عبور:
        ${formatTime(first.start)}
      </p>

      <p>
        اوج ارتفاع:
        ${first.peak.toFixed(2)} درجه
      </p>

      <p>
        زمان اوج:
        ${formatTime(first.peakTime)}
      </p>

      <p>
        نزدیک‌ترین فاصله:
        ${first.minRange.toFixed(1)} کیلومتر
      </p>

      <p>
        پایان عبور:
        ${
          first.end
            ? formatTime(first.end)
            : 'در حال عبور'
        }
      </p>

      <p>
        مدت عبور:
        ${
          first.end
            ? Math.round(
                (first.end - first.start) / 60000
              ) + ' دقیقه'
            : 'در حال عبور'
        }
      </p>

      <hr>

      <h4>عبورهای بعدی</h4>

      ${
        passes.slice(1, 4).map((p, i) => `
          <p>
            ${i + 2}. ${formatTime(p.start)}
            <br>
            اوج ارتفاع:
            ${p.peak.toFixed(1)} درجه
          </p>
        `).join('')
      }
    `;

  } catch (error) {
    console.error(
      'خطای پیش‌بینی عبور:',
      error
    );

    panel.innerText =
      'خطای محاسبه عبور: ' + error.message;

  } finally {
    passSearchBusy = false;
  }
}

// ==========================================
// اجرای اولیه برنامه
// ==========================================

loadSatellites();

// به‌روزرسانی موقعیت ماهواره‌ها هر ۵ ثانیه
setInterval(
  updateSatellitePositions,
  5000
);

// دریافت مجدد اطلاعات مداری هر ۳۰ دقیقه
setInterval(
  loadSatellites,
  30 * 60 * 1000
);
