
/* =====================================================
   🛰️ کاوشگر ماهواره - نسخه یکپارچه اصلاح‌شده
   GPS + نقشه + ماهواره‌ها + مسیر مداری زرد
   دریافت TLE + پیش‌بینی عبور + محاسبه زاویه ارتفاع
   ===================================================== */

(() => {
  "use strict";

  // جلوگیری از اجرای تکراری
  if (window.__satelliteExplorerStarted) {
    console.warn("کاوشگر ماهواره قبلاً اجرا شده است.");
    return;
  }

  if (typeof L === "undefined") {
    console.error("Leaflet بارگذاری نشده است.");
    return;
  }

  if (
    typeof satellite === "undefined" ||
    typeof satellite.twoline2satrec !== "function"
  ) {
    console.error("کتابخانه satellite.js بارگذاری نشده است.");
    return;
  }

  const mapElement = document.getElementById("map");

  if (!mapElement) {
    console.error("عنصر map در HTML پیدا نشد.");
    return;
  }

  window.__satelliteExplorerStarted = true;

  // =====================================================
  // تنظیمات
  // =====================================================

  const CONFIG = {
    tleUrl:
      "https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=tle",

    refreshInterval: 30000,

    orbitDuration: 90,

    orbitStep: 120,

    predictionHours: 24,

    predictionStep: 30,

    minimumElevation: 10,

    maximumPasses: 15
  };

  // =====================================================
  // متغیرهای اصلی
  // =====================================================

  let map;
  let satelliteLayer;
  let orbitLayer;

  let userMarker = null;
  let accuracyCircle = null;

  let satelliteData = [];

  let observerLocation = null;

  let loading = false;
  let predicting = false;

  // =====================================================
  // ایجاد نقشه
  // =====================================================

  try {
    map = L.map(mapElement).setView(
      [35.6892, 51.3890],
      5
    );

    L.tileLayer(
      "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      {
        attribution: "© OpenStreetMap",
        maxZoom: 19
      }
    ).addTo(map);

    satelliteLayer = L.layerGroup().addTo(map);

    orbitLayer = L.layerGroup().addTo(map);

    setTimeout(() => {
      map.invalidateSize();
    }, 500);

  } catch (error) {
    console.error("خطای ساخت نقشه:", error);
    showMessage("خطا در راه‌اندازی نقشه.");
    window.__satelliteExplorerStarted = false;
    return;
  }

  // =====================================================
  // پیام وضعیت
  // =====================================================

  function showMessage(message) {
    const box = document.getElementById("status");

    if (box) {
      box.textContent = message;
    }

    console.log("[Satellite Explorer]", message);
  }

  // =====================================================
  // ابزارهای محاسباتی
  // =====================================================

  function degreesToRadians(value) {
    return value * Math.PI / 180;
  }

  function radiansToDegrees(value) {
    return value * 180 / Math.PI;
  }

  function escapeHTML(value) {
    return String(value).replace(
      /[&<>"']/g,
      character => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;"
      })[character]
    );
  }

  // =====================================================
  // دریافت اطلاعات TLE
  // =====================================================

  async function fetchText(url, timeout = 15000) {
    const controller = new AbortController();

    const timer = setTimeout(
      () => controller.abort(),
      timeout
    );

    try {
      const response = await fetch(url, {
        method: "GET",
        cache: "no-store",
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error("HTTP " + response.status);
      }

      return await response.text();

    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchSatelliteData() {
    if (loading) return;

    loading = true;

    showMessage("در حال دریافت اطلاعات ماهواره‌ها...");

    const encodedUrl = encodeURIComponent(CONFIG.tleUrl);

    const sources = [
      CONFIG.tleUrl,

      "https://api.allorigins.win/raw?url=" +
      encodedUrl,

      "https://corsproxy.io/?url=" +
      encodedUrl
    ];

    let tleText = "";
    let lastError = null;

    try {
      for (const source of sources) {
        try {
          const result = await fetchText(source);

          if (
            result &&
            result.includes("1 ") &&
            result.includes("2 ")
          ) {
            tleText = result;
            break;
          }

        } catch (error) {
          lastError = error;
          console.warn("منبع دریافت ناموفق:", source, error);
        }
      }

      if (!tleText) {
        throw lastError || new Error(
          "هیچ منبعی اطلاعات TLE را برنگرداند."
        );
      }

      const parsed = parseTLE(tleText);

      if (!parsed.length) {
        throw new Error("اطلاعات ماهواره معتبر نیست.");
      }

      satelliteData = parsed;

      drawSatellites();

      showMessage(
        "✅ اطلاعات " +
        satelliteData.length +
        " ماهواره دریافت شد."
      );

      // پیش‌بینی فقط در صورت داشتن موقعیت GPS
      if (observerLocation) {
        predictPasses();
      }

    } catch (error) {
      console.error("Satellite Fetch Error:", error);

      showMessage(
        "❌ خطا در دریافت اطلاعات ماهواره: " +
        error.message
      );

    } finally {
      loading = false;
    }
  }

  // =====================================================
  // تجزیه استاندارد TLE
  // =====================================================

  function parseTLE(text) {
    const lines = text
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);

    const result = [];

    let name = "Unknown";

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith("1 ")) {
        const line1 = line;
        const line2 = lines[i + 1];

        if (!line2 || !line2.startsWith("2 ")) {
          continue;
        }

        try {
          const satrec = satellite.twoline2satrec(
            line1,
            line2
          );

          if (satrec.error && satrec.error !== 0) {
            i++;
            continue;
          }

          result.push({
            name: name,
            satrec: satrec
          });

          i++;

        } catch (error) {
          console.warn("TLE نامعتبر:", name, error);
        }

      } else if (!line.startsWith("2 ")) {
        name = line.replace(/^0\s*/, "").trim();
      }
    }

    return result;
  }

  // =====================================================
  // محاسبه موقعیت ماهواره
  // =====================================================

  function getSatelliteState(satrec, date) {
    try {
      const positionAndVelocity = satellite.propagate(
        satrec,
        date
      );

      if (
        !positionAndVelocity ||
        !positionAndVelocity.position
      ) {
        return null;
      }

      const position = positionAndVelocity.position;

      if (
        !Number.isFinite(position.x) ||
        !Number.isFinite(position.y) ||
        !Number.isFinite(position.z)
      ) {
        return null;
      }

      const jd = satellite.jday(
        date.getUTCFullYear(),
        date.getUTCMonth() + 1,
        date.getUTCDate(),
        date.getUTCHours(),
        date.getUTCMinutes(),
        date.getUTCSeconds(),
        date.getUTCMilliseconds()
      );

      const gmst = satellite.gstime(jd);

      const geo = satellite.eciToGeodetic(
        position,
        gmst
      );

      const lat = satellite.degreesLat(geo.latitude);
      const lon = satellite.degreesLong(geo.longitude);

      if (
        !Number.isFinite(lat) ||
        !Number.isFinite(lon) ||
        !Number.isFinite(geo.height)
      ) {
        return null;
      }

      return {
        lat,
        lon,
        altitude: geo.height,
        position,
        gmst
      };

    } catch (error) {
      console.warn("خطای محاسبه موقعیت:", error);
      return null;
    }
  }

  // =====================================================
  // محاسبه زاویه دید واقعی نسبت به ناظر
  // =====================================================

  function calculateLookAngles(
    satrec,
    date,
    observer
  ) {
    try {
      const state = getSatelliteState(satrec, date);

      if (!state) return null;

      const positionEcf = satellite.eciToEcf(
        state.position,
        state.gmst
      );

      const observerGd = {
        longitude: degreesToRadians(observer.lon),
        latitude: degreesToRadians(observer.lat),
        height: observer.height || 0
      };

      const look = satellite.ecfToLookAngles(
        observerGd,
        positionEcf
      );

      if (
        !look ||
        !Number.isFinite(look.elevation) ||
        !Number.isFinite(look.azimuth)
      ) {
        return null;
      }

      return {
        elevation: radiansToDegrees(look.elevation),
        azimuth: (
          radiansToDegrees(look.azimuth) + 360
        ) % 360,
        range: look.rangeSat
      };

    } catch (error) {
      console.warn("خطای محاسبه زاویه دید:", error);
      return null;
    }
  }

  // =====================================================
  // رسم مسیر مداری زرد
  // =====================================================

  function drawOrbit(item, now) {
    const segments = [];

    let currentSegment = [];
    let previousLon = null;

    for (
      let seconds = 0;
      seconds <= CONFIG.orbitDuration * 60;
      seconds += CONFIG.orbitStep
    ) {
      const date = new Date(
        now.getTime() + seconds * 1000
      );

      const pos = getSatelliteState(
        item.satrec,
        date
      );

      if (!pos) continue;

      // جلوگیری از اتصال اشتباه خطوط در نصف‌النهار ۱۸۰
      if (
        previousLon !== null &&
        Math.abs(pos.lon - previousLon) > 180
      ) {
        if (currentSegment.length > 1) {
          segments.push(currentSegment);
        }

        currentSegment = [];
      }

      currentSegment.push([
        pos.lat,
        pos.lon
      ]);

      previousLon = pos.lon;
    }

    if (currentSegment.length > 1) {
      segments.push(currentSegment);
    }

    if (segments.length) {
      L.polyline(segments, {
        color: "#ffd400",
        weight: 2,
        opacity: 0.8,
        smoothFactor: 1
      }).addTo(orbitLayer);
    }
  }

  // =====================================================
  // نمایش ماهواره‌ها روی نقشه
  // =====================================================

  function drawSatellites() {
    if (!map || !satelliteData.length) return;

    satelliteLayer.clearLayers();
    orbitLayer.clearLayers();

    const now = new Date();

    satelliteData.forEach(item => {
      try {
        const pos = getSatelliteState(
          item.satrec,
          now
        );

        if (!pos) return;

        const marker = L.circleMarker(
          [pos.lat, pos.lon],
          {
            radius: 5,
            color: "#00d9ff",
            fillColor: "#008cff",
            fillOpacity: 0.9,
            weight: 1
          }
        );

        marker.bindPopup(
          "<b>🛰️ " +
          escapeHTML(item.name) +
          "</b><br>" +
          "عرض جغرافیایی: " +
          pos.lat.toFixed(3) +
          "°<br>" +
          "طول جغرافیایی: " +
          pos.lon.toFixed(3) +
          "°<br>" +
          "ارتفاع: " +
          pos.altitude.toFixed(1) +
          " کیلومتر"
        );

        marker.addTo(satelliteLayer);

        drawOrbit(item, now);

      } catch (error) {
        console.warn(
          "خطای نمایش ماهواره:",
          item.name,
          error
        );
      }
    });

    showMessage(
      "🛰️ نمایش " +
      satelliteLayer.getLayers().length +
      " ماهواره روی نقشه."
    );
  }

  // =====================================================
  // دریافت GPS
  // =====================================================

  function getMyLocation() {
    if (!navigator.geolocation) {
      showMessage("GPS در دستگاه پشتیبانی نمی‌شود.");
      return;
    }

    showMessage("در حال دریافت موقعیت GPS...");

    navigator.geolocation.getCurrentPosition(
      position => {
        const lat = position.coords.latitude;
        const lon = position.coords.longitude;

        const accuracy = position.coords.accuracy;

        observerLocation = {
          lat,
          lon,
          height: Math.max(
            0,
            (position.coords.altitude || 0) / 1000
          )
        };

        if (userMarker) {
          map.removeLayer(userMarker);
        }

        if (accuracyCircle) {
          map.removeLayer(accuracyCircle);
        }

        userMarker = L.marker([lat, lon])
          .addTo(map)
          .bindPopup("📍 موقعیت فعلی شما");

        accuracyCircle = L.circle(
          [lat, lon],
          {
            radius: accuracy,
            color: "#1685ff",
            fillColor: "#1685ff",
            fillOpacity: 0.08,
            weight: 1
          }
        ).addTo(map);

        map.setView([lat, lon], 9);

        userMarker.openPopup();

        showMessage(
          "✅ موقعیت GPS دریافت شد."
        );

        if (satelliteData.length) {
          predictPasses();
        }
      },

      error => {
        console.error("GPS Error:", error);

        const messages = {
          1: "اجازه دسترسی به موقعیت داده نشده است.",
          2: "موقعیت فعلی قابل تشخیص نیست.",
          3: "زمان دریافت GPS تمام شد."
        };

        showMessage(
          messages[error.code] ||
          "خطا در دریافت GPS."
        );
      },

      {
        enableHighAccuracy: true,
        timeout: 20000,
        maximumAge: 10000
      }
    );
  }

  // =====================================================
  // محاسبه و پیش‌بینی عبور ماهواره‌ها
  // =====================================================

  function predictPasses() {
    const output = document.getElementById("passes");

    if (!output) {
      console.warn("عنصر passes در HTML وجود ندارد.");
      return;
    }

    if (predicting) return;

    if (!satelliteData.length) {
      output.textContent =
        "ابتدا اطلاعات ماهواره‌ها را دریافت کنید.";
      return;
    }

    if (!navigator.geolocation) {
      output.textContent =
        "GPS در دستگاه پشتیبانی نمی‌شود.";
      return;
    }

    if (observerLocation) {
      startPassPrediction(observerLocation);
      return;
    }

    output.textContent =
      "در حال دریافت موقعیت برای پیش‌بینی عبور...";

    navigator.geolocation.getCurrentPosition(
      position => {
        observerLocation = {
          lat: position.coords.latitude,
          lon: position.coords.longitude,
          height: Math.max(
            0,
            (position.coords.altitude || 0) / 1000
          )
        };

        startPassPrediction(observerLocation);
      },

      () => {
        output.textContent =
          "برای پیش‌بینی عبور، دسترسی GPS را فعال کنید.";
      },

      {
        enableHighAccuracy: true,
        timeout: 20000,
        maximumAge: 10000
      }
    );
  }

  // =====================================================
  // پردازش عبورها
  // =====================================================

  function startPassPrediction(observer) {
    if (predicting) return;

    predicting = true;

    const output = document.getElementById("passes");

    if (output) {
      output.textContent =
        "⏳ در حال محاسبه عبورهای ۲۴ ساعت آینده...";
    }

    // اجازه نمایش پیام قبل از شروع محاسبات
    setTimeout(() => {
      try {
        const passes = calculatePasses(observer);

        displayPasses(passes);

      } catch (error) {
        console.error("Prediction Error:", error);

        if (output) {
          output.textContent =
            "خطا در محاسبه پیش‌بینی عبور.";
        }

      } finally {
        predicting = false;
      }
    }, 100);
  }

  // =====================================================
  // الگوریتم عبور با زاویه واقعی
  // =====================================================

  function calculatePasses(observer) {
    const passes = [];

    const startTime = Date.now();

    const endTime =
      startTime +
      CONFIG.predictionHours * 60 * 60 * 1000;

    const step =
      CONFIG.predictionStep * 1000;

    satelliteData.forEach(item => {
      let activePass = null;

      let previousElevation = null;

      for (
        let timestamp = startTime;
        timestamp <= endTime;
        timestamp += step
      ) {
        const date = new Date(timestamp);

        const look = calculateLookAngles(
          item.satrec,
          date,
          observer
        );

        if (!look) {
          continue;
        }

        const elevation = look.elevation;

        if (
          elevation >= CONFIG.minimumElevation &&
          previousElevation !== null &&
          previousElevation < CONFIG.minimumElevation
        ) {
          activePass = {
            name: item.name,
            start: date,
            end: null,
            maxElevation: elevation,
            azimuth: look.azimuth
          };
        }

        if (
          elevation >= CONFIG.minimumElevation &&
          !activePass
        ) {
          activePass = {
            name: item.name,
            start: date,
            end: null,
            maxElevation: elevation,
            azimuth: look.azimuth
          };
        }

        if (activePass) {
          if (
            elevation > activePass.maxElevation
          ) {
            activePass.maxElevation = elevation;
            activePass.azimuth = look.azimuth;
          }

          if (
            elevation < CONFIG.minimumElevation &&
            previousElevation !== null &&
            previousElevation >= CONFIG.minimumElevation
          ) {
            activePass.end = date;

            activePass.duration = Math.round(
              (activePass.end - activePass.start) / 60000
            );

            passes.push(activePass);

            activePass = null;
          }
        }

        previousElevation = elevation;
      }

      // عبوری که تا پایان بازه هنوز ادامه دارد
      if (activePass) {
        activePass.end = new Date(endTime);

        activePass.duration = Math.round(
          (activePass.end - activePass.start) / 60000
        );

        passes.push(activePass);
      }
    });

    passes.sort(
      (a, b) => a.start - b.start
    );

    return passes;
  }

  // =====================================================
  // نمایش نتایج پیش‌بینی
  // =====================================================

  function displayPasses(passes) {
    const output = document.getElementById("passes");

    if (!output) return;

    output.innerHTML = "";

    if (!passes.length) {
      output.textContent =
        "در ۲۴ ساعت آینده عبوری با ارتفاع بیش از ۱۰ درجه پیدا نشد.";

      return;
    }

    const title = document.createElement("div");

    title.className = "pass-heading";

    title.textContent =
      "🛰️ " + passes.length +
      " عبور پیش‌بینی‌شده در ۲۴ ساعت آینده";

    output.appendChild(title);

    passes.slice(0, CONFIG.maximumPasses).forEach(
      pass => {
        const item = document.createElement("div");

        item.className = "pass-item";

        const start = pass.start.toLocaleString(
          "fa-IR"
        );

        const end = pass.end.toLocaleString(
          "fa-IR"
        );

        item.innerHTML =
          "<b>🛰️ " +
          escapeHTML(pass.name) +
          "</b><br>" +

          "🕒 شروع: " +
          escapeHTML(start) +
          "<br>" +

          "🕒 پایان: " +
          escapeHTML(end) +
          "<br>" +

          "📐 بیشترین ارتفاع: " +
          pass.maxElevation.toFixed(1) +
          " درجه<br>" +

          "🧭 زاویه سمت: " +
          pass.azimuth.toFixed(1) +
          " درجه<br>" +

          "⏱️ مدت عبور: " +
          pass.duration +
          " دقیقه";

        output.appendChild(item);
      }
    );
  }

  // =====================================================
  // اتصال دکمه‌ها
  // =====================================================

  const locationButton =
    document.getElementById("locationBtn");

  const satelliteButton =
    document.getElementById("satelliteBtn");

  const passButton =
    document.getElementById("passBtn");

  if (locationButton) {
    locationButton.addEventListener(
      "click",
      getMyLocation
    );
  }

  if (satelliteButton) {
    satelliteButton.addEventListener(
      "click",
      fetchSatelliteData
    );
  }

  if (passButton) {
    passButton.addEventListener(
      "click",
      predictPasses
    );
  }

  // =====================================================
  // دسترسی عمومی توابع
  // =====================================================

  window.satelliteMap = map;

  window.getMyLocation = getMyLocation;

  window.fetchSatelliteData = fetchSatelliteData;

  window.predictPasses = predictPasses;

  window.drawSatellites = drawSatellites;

  window.satelliteData = satelliteData;

  // =====================================================
  // شروع برنامه
  // =====================================================

  showMessage("🛰️ کاوشگر ماهواره آماده اجرا است.");

  fetchSatelliteData();

  // بروزرسانی موقعیت و مسیر ماهواره‌ها
  setInterval(() => {
    if (satelliteData.length) {
      drawSatellites();
    }
  }, CONFIG.refreshInterval);

  // اصلاح اندازه نقشه در نمایشگر موبایل
  window.addEventListener("resize", () => {
    map.invalidateSize();
  });

})();
