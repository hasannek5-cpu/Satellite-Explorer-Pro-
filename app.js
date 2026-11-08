

const map = L.map('map').setView([25, 15], 2);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© OpenStreetMap'
}).addTo(map);

const markers = L.layerGroup().addTo(map);

function showTab(tab) {
  document.getElementById('mapTab').hidden = tab !== 'map';
  document.getElementById('infoTab').hidden = tab !== 'info';
  document.getElementById('gpsTab').hidden = tab !== 'gps';

  if (tab === 'map') {
    setTimeout(() => map.invalidateSize(), 200);
  }
}

// دریافت ماهواره‌های عمومی
async function loadSatellites() {
  markers.clearLayers();

  const url =
    'https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=json';

  try {
    const response = await fetch(url);
    const satellites = await response.json();

    satellites.forEach(sat => {
      if (!sat.NAME || !sat.TLE_LINE1 || !sat.TLE_LINE2) return;

      const marker = L.marker([0, 0]);

      marker.bindPopup(
        '<b>' + sat.NAME + '</b><br>' +
        'شناسه NORAD: ' + sat.NORAD_CAT_ID
      );

      marker.addTo(markers);
    });

    document.getElementById('details').innerText =
      satellites.length + ' ماهواره دریافت شد';

  } catch (error) {
    document.getElementById('details').innerText =
      'خطا در دریافت اطلاعات ماهواره';
  }
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
      L.marker([lat, lon]).addTo(map)
        .bindPopup('موقعیت شما').openPopup();
    },
    () => output.innerText = 'اجازه GPS داده نشد'
  );
}

loadSatellites();
