
const map = L.map('map').setView([25, 15], 2);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© OpenStreetMap'
}).addTo(map);

const markers = L.layerGroup().addTo(map);
const satellitesData = [];
const satrecs = new Map();
let userMarker = null;

// نمایش تب‌ها
function showTab(tab) {
  document.getElementById('mapTab').hidden = tab !== 'map';
  document.getElementById('infoTab').hidden = tab !== 'info';
  document.getElementById('gpsTab').hidden = tab !== 'gps';

  if (tab === 'map') {
    setTimeout(() => map.invalidateSize(), 200);
  }
}

// دریافت ماهواره‌ها
async function loadSatellites() {
  const details = document.getElementById('details');
  details.innerText = 'در حال دریافت ماهواره‌ها...';

  try {
    const url =
      'https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=json';

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error('HTTP ' + response.status);
    }

    const satellites = await response.json();

    satellitesData.length = 0;
    satrecs.clear();

    satellites.forEach(sat => {
      const name = sat.OBJECT_NAME || sat.NAME;
      const line1 = sat.TLE_LINE1;
      const line2 = sat.TLE_LINE2;
      const norad = sat.NORAD_CAT_ID;

      if (!name || !line1 || !line2) return;

      try {
        const satrec = satellite.twoline2satrec(line1, line2);

        if (satrec.error) return;

        satellitesData.push({
          name,
          norad,
          satrec
        });

        satrecs.set(String(norad), satrec);
      } catch (e) {
        console.warn('Satellite error:', name, e);
      }
    });

    updateSatellitePositions();

    details.innerText =
      satellitesData.length + ' ماهواره فعال دریافت شد';

    renderSatelliteList();

  } catch (error) {
    console.error(error);
    details.innerText =
      'خطا در دریافت ماهواره‌ها؛ اتصال اینترنت را بررسی کنید';
  }
}

// محاسبه موقعیت مداری
function updateSatellitePositions() {
  const now = new Date();

  satellitesData.forEach(sat => {
    try {
      const positionAndVelocity =
        satellite.propagate(sat.satrec, now);

      const positionEci = positionAndVelocity.position;

      if (!positionEci || typeof positionEci === 'boolean') return;

      const gmst = satellite.gstime(now);

      const geo = satellite.eciToGeodetic(positionEci, gmst);

      const lat = satellite.degreesLat(geo.latitude);
      const lon = satellite.degreesLong(geo.longitude);
      const altitude = geo.height;

      sat.lat = lat;
      sat.lon = lon;
      sat.altitude = altitude;

      const velocity = positionAndVelocity.velocity;

      if (velocity && typeof velocity !== 'boolean') {
        sat.speed = Math.sqrt(
          velocity.x ** 2 +
          velocity.y ** 2 +
          velocity.z ** 2
        );
      }

    } catch (e) {
      console.warn('Position error:', sat.name);
    }
  });

  updateMarkers();
  updateSelectedSatellite();
}

// نشانگرهای نقشه
function updateMarkers() {
  markers.clearLayers();

  satellitesData.forEach(sat => {
    if (!Number.isFinite(sat.lat) || !Number.isFinite(sat.lon)) return;

    const marker = L.circleMarker([sat.lat, sat.lon], {
      radius: 5,
      color: '#00e5ff',
      fillColor: '#00bfff',
      fillOpacity: 0.9,
      weight: 1
    });

    marker.bindPopup(`
      <div dir="rtl">
        <b>${escapeHTML(sat.name)}</b><br>
        شناسه NORAD: ${sat.norad}<br>
        ارتفاع: ${sat.altitude.toFixed(1)} کیلومتر
      </div>
    `);

    marker.on('click', () => {
      showSatelliteInfo(sat);
    });

    marker.addTo(markers);
  });
}

// جلوگیری از تزریق HTML
function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

// نمایش اطلاعات ماهواره
function showSatelliteInfo(sat) {
  const details = document.getElementById('details');

  details.innerHTML = `
    <div dir="rtl">
      <h3>${escapeHTML(sat.name)}</h3>
      <p>شناسه NORAD: ${sat.norad}</p>
      <p>عرض جغرافیایی: ${sat.lat.toFixed(5)}</p>
      <p>طول جغرافیایی: ${sat.lon.toFixed(5)}</p>
      <p>ارتفاع: ${sat.altitude.toFixed(2)} کیلومتر</p>
      <p>سرعت: ${sat.speed ? sat.speed.toFixed(3) : '---'} کیلومتر بر ثانیه</p>
    </div>
  `;

  document.getElementById('infoTab').hidden = false;
  document.getElementById('mapTab').hidden = true;
  document.getElementById('gpsTab').hidden = true;
}

// فهرست ماهواره‌ها
function renderSatelliteList() {
  const list = document.getElementById('satelliteList');

  if (!list) return;

  list.innerHTML = '';

  satellitesData.forEach(sat => {
    const button = document.createElement('button');

    button.textContent = sat.name;
    button.style.display = 'block';
    button.style.margin = '6px';
    button.style.padding = '10px';

    button.onclick = () => {
      map.setView([sat.lat, sat.lon], 5);
      showSatelliteInfo(sat);
    };

    list.appendChild(button);
  });
}

// GPS گوشی
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

      map.setView([lat, lon], 7);

      if (userMarker) {
        map.removeLayer(userMarker);
      }

      userMarker = L.marker([lat, lon])
        .addTo(map)
        .bindPopup('موقعیت شما')
        .openPopup();
    },
    error => {
      output.innerText =
        error.code === 1
          ? 'اجازه GPS داده نشد'
          : 'موقعیت شما دریافت نشد';
    },
    {
      enableHighAccuracy: true,
      timeout: 15000,
      maximumAge: 0
    }
  );
}

// شروع
loadSatellites();

// به‌روزرسانی موقعیت مداری
setInterval(updateSatellitePositions, 5000);

// به‌روزرسانی اطلاعات TLE هر 30 دقیقه
setInterval(loadSatellites, 30 * 60 * 1000);
