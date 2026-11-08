
const map = L.map('map').setView([25, 15], 2);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© OpenStreetMap'
}).addTo(map);

const markers = L.layerGroup().addTo(map);
const markerMap = new Map();

let satellitesData = [];
let userMarker = null;
let selectedNorad = null;

// مدیریت تب‌ها
function showTab(tab) {
  document.getElementById('mapTab').hidden = tab !== 'map';
  document.getElementById('infoTab').hidden = tab !== 'info';
  document.getElementById('gpsTab').hidden = tab !== 'gps';

  if (tab === 'map') {
    setTimeout(() => map.invalidateSize(), 200);
  }
}

// دریافت اطلاعات TLE از Celestrak
async function loadSatellites() {
  const details = document.getElementById('details');

  details.innerText = 'در حال دریافت اطلاعات ماهواره‌ها...';

  try {
    const url =
      'https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=tle';

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error('HTTP ' + response.status);
    }

    const content = await response.text();

    const lines = content
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);

    const newSatellites = [];

    for (let i = 0; i < lines.length - 2; i++) {
      let name = lines[i];

      if (name.startsWith('0 ')) {
        name = name.substring(2);
      }

      const line1 = lines[i + 1];
      const line2 = lines[i + 2];

      if (!line1.startsWith('1 ') ||
          !line2.startsWith('2 ')) {
        continue;
      }

      try {
        const satrec =
          satellite.twoline2satrec(line1, line2);

        if (satrec.error) continue;

        newSatellites.push({
          name,
          norad: line1.substring(2, 7).trim(),
          satrec,
          lat: 0,
          lon: 0,
          altitude: 0,
          speed: 0
        });

        i += 2;

      } catch (error) {
        console.warn('خطای ماهواره:', name, error);
      }
    }

    if (newSatellites.length === 0) {
      throw new Error('هیچ ماهواره معتبری دریافت نشد');
    }

    satellitesData = newSatellites;

    updateSatellitePositions();
    renderSatelliteList();

    details.innerText =
      satellitesData.length +
      ' ماهواره با موفقیت دریافت شد';

  } catch (error) {
    console.error(error);

    details.innerText =
      'خطا در دریافت اطلاعات: ' + error.message;
  }
}

// محاسبه مختصات ماهواره‌ها
function updateSatellitePositions() {
  const now = new Date();

  satellitesData.forEach(sat => {
    try {
      const result =
        satellite.propagate(sat.satrec, now);

      const position = result.position;
      const velocity = result.velocity;

      if (!position || typeof position === 'boolean') {
        return;
      }

      const gmst = satellite.gstime(now);

      const geo =
        satellite.eciToGeodetic(position, gmst);

      sat.lat = satellite.degreesLat(geo.latitude);
      sat.lon = satellite.degreesLong(geo.longitude);
      sat.altitude = geo.height;

      if (velocity && typeof velocity !== 'boolean') {
        sat.speed = Math.sqrt(
          velocity.x * velocity.x +
          velocity.y * velocity.y +
          velocity.z * velocity.z
        );
      }

    } catch (error) {
      console.warn('محاسبه موقعیت ناموفق:', sat.name);
    }
  });

  updateMarkers();
  updateSelectedSatellite();
}

// نمایش نشانگرها روی نقشه
function updateMarkers() {
  satellitesData.forEach(sat => {
    if (!Number.isFinite(sat.lat) ||
        !Number.isFinite(sat.lon)) {
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
        NORAD: ${sat.norad}<br>
        ارتفاع: ${sat.altitude.toFixed(1)} کیلومتر
      </div>
    `);
  });

  // حذف نشانگرهای ماهواره‌های حذف‌شده
  for (const [id, marker] of markerMap) {
    if (!satellitesData.some(s => s.norad === id)) {
      markers.removeLayer(marker);
      markerMap.delete(id);
    }
  }
}

// جلوگیری از تزریق HTML
function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[c]);
}

// نمایش جزئیات ماهواره
function showSatelliteInfo(norad) {
  const sat = satellitesData.find(
    item => item.norad === String(norad)
  );

  if (!sat) return;

  selectedNorad = sat.norad;

  showTab('info');
  updateSelectedSatellite();
}

// به‌روزرسانی اطلاعات ماهواره انتخاب‌شده
function updateSelectedSatellite() {
  if (!selectedNorad) return;

  const sat = satellitesData.find(
    item => item.norad === selectedNorad
  );

  if (!sat) return;

  document.getElementById('details').innerHTML = `
    <div dir="rtl">
      <h3>${escapeHTML(sat.name)}</h3>
      <p>شناسه NORAD: ${sat.norad}</p>
      <p>عرض جغرافیایی: ${sat.lat.toFixed(5)} درجه</p>
      <p>طول جغرافیایی: ${sat.lon.toFixed(5)} درجه</p>
      <p>ارتفاع: ${sat.altitude.toFixed(2)} کیلومتر</p>
      <p>سرعت: ${sat.speed.toFixed(3)} کیلومتر بر ثانیه</p>
      <p>آخرین محاسبه: ${new Date().toLocaleTimeString('fa-IR')}</p>
    </div>
  `;
}

// فهرست ماهواره‌ها
function renderSatelliteList() {
  const list = document.getElementById('satelliteList');

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

// موقعیت GPS گوشی
function getLocation() {
  const output = document.getElementById('location');

  if (!navigator.geolocation) {
    output.innerText = 'GPS پشتیبانی نمی‌شود';
    return;
  }

  output.innerText = 'در حال دریافت موقعیت...';

  navigator.geolocation.getCurrentPosition(
    position => {
      const lat = position.coords.latitude;
      const lon = position.coords.longitude;

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

// اجرای اولیه
loadSatellites();

// حرکت زنده ماهواره‌ها
setInterval(updateSatellitePositions, 5000);

// دریافت مجدد اطلاعات مداری
setInterval(loadSatellites, 30 * 60 * 1000);
