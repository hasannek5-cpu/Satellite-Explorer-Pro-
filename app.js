
/* ==========================================
   🛰️ کاوشگر ماهواره
   نسخه اصلاح دریافت اطلاعات ماهواره‌ها
   GPS + نقشه + موقعیت مداری + پیش‌بینی عبور
   ========================================== */

(() => {
  "use strict";

  if (typeof L === "undefined") {
    console.error("Leaflet بارگذاری نشده است.");
    return;
  }

  if (typeof satellite === "undefined") {
    console.error("satellite.js بارگذاری نشده است.");
    return;
  }

  const mapElement = document.getElementById("map");
  if (!mapElement) {
    console.error("عنصر نقشه پیدا نشد.");
    return;
  }

  // -------------------------------
  // نقشه
  // -------------------------------
  const map = L.map("map").setView([35.6892, 51.3890], 6);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap",
    maxZoom: 19
  }).addTo(map);

  const satelliteLayer = L.layerGroup().addTo(map);

  let userMarker = null;
  let satelliteData = [];
  let loading = false;

  // -------------------------------
  // موقعیت GPS
  // -------------------------------
  function getMyLocation() {
    if (!navigator.geolocation) {
      alert("GPS در دستگاه شما پشتیبانی نمی‌شود.");
      return;
    }

    navigator.geolocation.getCurrentPosition(
      position => {
        const lat = position.coords.latitude;
        const lon = position.coords.longitude;

        map.setView([lat, lon], 10);

        if (userMarker) map.removeLayer(userMarker);

        userMarker = L.marker([lat, lon])
          .addTo(map)
          .bindPopup("📍 موقعیت فعلی شما")
          .openPopup();
      },
      error => {
        alert("دریافت موقعیت GPS ناموفق بود.");
        console.error(error);
      },
      {
        enableHighAccuracy: true,
        timeout: 15000
      }
    );
  }

  // -------------------------------
  // دریافت TLE از CelesTrak
  // -------------------------------
  async function fetchSatelliteData() {
    if (loading) return;

    loading = true;
    showMessage("در حال دریافت اطلاعات ماهواره‌ها...");

    const tleUrl =
      "https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=tle";

    const proxyUrl =
      "https://api.allorigins.win/raw?url=" +
      encodeURIComponent(tleUrl);

    try {
      const response = await fetch(proxyUrl, {
        method: "GET",
        cache: "no-store"
      });

      if (!response.ok) {
        throw new Error("HTTP " + response.status);
      }

      const text = await response.text();

      if (!text || text.length < 100) {
        throw new Error("اطلاعات TLE دریافت نشد.");
      }

      satelliteData = parseTLE(text);

      if (!satelliteData.length) {
        throw new Error("ماهواره‌ای پیدا نشد.");
      }

      drawSatellites();

      showMessage(
        "✅ " + satelliteData.length +
        " ماهواره دریافت شد."
      );

      predictPasses();

    } catch (error) {
      console.error("Satellite Fetch Error:", error);

      showMessage(
        "❌ خطا در دریافت اطلاعات: " +
        error.message
      );
    } finally {
      loading = false;
    }
  }

  // -------------------------------
  // تجزیه TLE
  // -------------------------------
  function parseTLE(text) {
    const lines = text.trim().split(/\r?\n/);
    const result = [];

    for (let i = 0; i < lines.length - 2; i++) {
      const name = lines[i].trim();
      const line1 = lines[i + 1].trim();
      const line2 = lines[i + 2].trim();

      if (
        line1.startsWith("1 ") &&
        line2.startsWith("2 ")
      ) {
        try {
          const satrec = satellite.twoline2satrec(
            line1,
            line2
          );

          result.push({
            name,
            satrec
          });

          i += 2;
        } catch (e) {
          console.warn("TLE نامعتبر:", name);
        }
      }
    }

    return result;
  }

  // -------------------------------
  // موقعیت ماهواره
  // -------------------------------
  function getSatellitePosition(satrec, date) {
    const time = satellite.jday(
      date.getUTCFullYear(),
      date.getUTCMonth() + 1,
      date.getUTCDate(),
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds()
    );

    const position = satellite.propagate(
      satrec,
      date
    );

    if (!position.position) return null;

    const gmst = satellite.gstime(time);

    const geo = satellite.eciToGeodetic(
      position.position,
      gmst
    );

    return {
      lat: satellite.degreesLat(geo.latitude),
      lon: satellite.degreesLong(geo.longitude),
      altitude: geo.height
    };
  }

  // -------------------------------
  // نمایش ماهواره‌ها
  // -------------------------------
  function drawSatellites() {
    satelliteLayer.clearLayers();

    const now = new Date();

    satelliteData.forEach(item => {
      const pos = getSatellitePosition(
        item.satrec,
        now
      );

      if (!pos) return;

      if (
        !Number.isFinite(pos.lat) ||
        !Number.isFinite(pos.lon)
      ) return;

      L.circleMarker(
        [pos.lat, pos.lon],
        {
          radius: 4,
          color: "#00d9ff",
          fillColor: "#00aaff",
          fillOpacity: 0.85
        }
      )
      .bindPopup(
        "<b>🛰️ " + item.name + "</b><br>" +
        "عرض: " + pos.lat.toFixed(2) + "°<br>" +
        "طول: " + pos.lon.toFixed(2) + "°<br>" +
        "ارتفاع: " + pos.altitude.toFixed(0) + " km"
      )
      .addTo(satelliteLayer);
    });
  }

  // -------------------------------
  // پیش‌بینی عبور ماهواره
  // -------------------------------
  function predictPasses() {
    const output = document.getElementById("passes");

    if (!output) {
      console.warn("عنصر passes در HTML پیدا نشد.");
      return;
    }

    if (!navigator.geolocation) {
      output.innerHTML = "GPS در دسترس نیست.";
      return;
    }

    navigator.geolocation.getCurrentPosition(
      position => {
        const lat = position.coords.latitude;
        const lon = position.coords.longitude;

        const passes = [];

        satelliteData.forEach(item => {
          let previousElevation = -90;

          for (let minute = 0; minute < 24 * 60; minute += 1) {
            const date = new Date(
              Date.now() + minute * 60000
            );

            const pos = getSatellitePosition(
              item.satrec,
              date
            );

            if (!pos) continue;

            const elevation = calculateElevation(
              lat,
              lon,
              pos.lat,
              pos.lon,
              pos.altitude
            );

            if (
              elevation >= 10 &&
              previousElevation < 10
            ) {
              passes.push({
                name: item.name,
                time: date,
                elevation
              });
            }

            previousElevation = elevation;
          }
        });

        passes.sort((a, b) => a.time - b.time);

        output.innerHTML = passes.length
          ? passes.slice(0, 15).map(p =>
              "<div class='pass-item'>" +
              "🛰️ " + p.name + "<br>" +
              "🕒 " + p.time.toLocaleString("fa-IR") +
              "</div>"
            ).join("")
          : "در ۲۴ ساعت آینده عبوری پیدا نشد.";
      },
      () => {
        output.innerHTML = "برای پیش‌بینی عبور GPS را فعال کنید.";
      }
    );
  }

  // -------------------------------
  // محاسبه ارتفاع زاویه‌ای
  // -------------------------------
  function calculateElevation(
    observerLat,
    observerLon,
    satLat,
    satLon,
    altitude
  ) {
    const rad = Math.PI / 180;

    const lat1 = observerLat * rad;
    const lat2 = satLat * rad;

    const deltaLon =
      (satLon - observerLon) * rad;

    const cosAngle =
      Math.sin(lat1) * Math.sin(lat2) +
      Math.cos(lat1) * Math.cos(lat2) *
      Math.cos(deltaLon);

    const centralAngle = Math.acos(
      Math.max(-1, Math.min(1, cosAngle))
    );

    const earthRadius = 6371;
    const distance = Math.sqrt(
      earthRadius ** 2 +
      (earthRadius + altitude) ** 2 -
      2 * earthRadius *
      (earthRadius + altitude) *
      Math.cos(centralAngle)
    );

    const elevation = Math.asin(
      (
        (earthRadius + altitude) *
        Math.cos(centralAngle) -
        earthRadius
      ) / distance
    );

    return elevation / rad;
  }

  // -------------------------------
  // پیام وضعیت
  // -------------------------------
  function showMessage(message) {
    const box = document.getElementById("status");

    if (box) {
      box.textContent = message;
    }

    console.log(message);
  }

  // -------------------------------
  // اتصال دکمه‌ها
  // -------------------------------
  document.getElementById("locationBtn")
    ?.addEventListener("click", getMyLocation);

  document.getElementById("satelliteBtn")
    ?.addEventListener("click", fetchSatelliteData);

  document.getElementById("passBtn")
    ?.addEventListener("click", predictPasses);

  // بارگذاری اولیه
  fetchSatelliteData();

  // بروزرسانی موقعیت ماهواره‌ها
  setInterval(drawSatellites, 30000);

  window.satelliteMap = map;
  window.getMyLocation = getMyLocation;
  window.fetchSatelliteData = fetchSatelliteData;
  window.predictPasses = predictPasses;

})();
