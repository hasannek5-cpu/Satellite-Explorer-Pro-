
/* =========================================================
   🛰️ SATELLITE EXPLORER PRO
   Earth Analysis Module - نسخه اصلاح شده
   انتخاب نقطه روی نقشه + تحلیل حرارتی + تحلیل معدنی
   ========================================================= */

(() => {
  'use strict';

  const $ = id => document.getElementById(id);

  let selectedPoint = null;
  let pointMarker = null;

  // =========================================================
  // 1. دریافت نقشه اصلی
  // =========================================================

  function getMap() {
    return window.map || null;
  }

  // =========================================================
  // 2. نمایش نتیجه
  // =========================================================

  function setResult(id, text) {
    const element = $(id);

    if (element) {
      element.textContent = text;
    }
  }

  // =========================================================
  // 3. فرمت مختصات
  // =========================================================

  function formatCoord(value) {
    return Number(value).toFixed(6);
  }

  // =========================================================
  // 4. انتخاب نقطه تحلیل روی نقشه
  // =========================================================

  function selectEarthPoint(latlng) {

    selectedPoint = {
      lat: Number(latlng.lat),
      lon: Number(latlng.lng)
    };

    const coordinates = $('selectedCoordinates');

    if (coordinates) {
      coordinates.textContent =
        `عرض جغرافیایی: ${formatCoord(selectedPoint.lat)}° | ` +
        `طول جغرافیایی: ${formatCoord(selectedPoint.lon)}°`;
    }

    const map = getMap();

    if (map && window.L) {

      if (pointMarker) {
        map.removeLayer(pointMarker);
      }

      pointMarker = L.circleMarker(
        [selectedPoint.lat, selectedPoint.lon],
        {
          radius: 8,
          color: '#ffe066',
          fillColor: '#ffcc00',
          fillOpacity: 0.95,
          weight: 2
        }
      )
      .addTo(map)
      .bindPopup(
        `<b>نقطه تحلیل زمین</b><br>` +
        `Lat: ${formatCoord(selectedPoint.lat)}<br>` +
        `Lon: ${formatCoord(selectedPoint.lon)}`
      )
      .openPopup();
    }

    setResult(
      'thermalResult',
      'نقطه انتخاب شد. برای تحلیل حرارتی، داده ماهواره‌ای لازم است.'
    );

    setResult(
      'mineralResult',
      'نقطه انتخاب شد. برای تحلیل معدنی، تصاویر چندباندی لازم است.'
    );
  }

  // =========================================================
  // 5. اتصال کلیک به نقشه
  // =========================================================

  function attachMapClick() {

    const map = getMap();

    if (!map || map._earthAnalysisAttached) {
      return;
    }

    map._earthAnalysisAttached = true;

    map.on('click', function (event) {
      selectEarthPoint(event.latlng);
    });
  }

  // =========================================================
  // 6. تحلیل حرارتی زمین
  // =========================================================

  window.loadThermalData = function () {

    if (!selectedPoint) {

      setResult(
        'thermalResult',
        'ابتدا روی نقشه یک نقطه انتخاب کنید.'
      );

      return;
    }

    setResult(
      'thermalResult',
      `مختصات انتخاب شده:\n` +
      `Latitude: ${formatCoord(selectedPoint.lat)}\n` +
      `Longitude: ${formatCoord(selectedPoint.lon)}\n\n` +
      `وضعیت: نقطه ثبت شد.\n` +
      `داده واقعی دمای سطح زمین (LST) هنوز به سرویس ماهواره‌ای متصل نشده است.`
    );
  };

  // =========================================================
  // 7. تحلیل معدنی و طیفی
  // =========================================================

  window.loadMineralData = function () {

    if (!selectedPoint) {

      setResult(
        'mineralResult',
        'ابتدا روی نقشه یک نقطه انتخاب کنید.'
      );

      return;
    }

    setResult(
      'mineralResult',
      `مختصات انتخاب شده:\n` +
      `Latitude: ${formatCoord(selectedPoint.lat)}\n` +
      `Longitude: ${formatCoord(selectedPoint.lon)}\n\n` +
      `وضعیت: نقطه ثبت شد.\n` +
      `برای تحلیل واقعی خاک و شاخص‌های طیفی باید تصاویر Sentinel-2 یا Landsat دریافت شوند.`
    );
  };

  // =========================================================
  // 8. انتخاب نقطه از طریق GPS یا کد
  // =========================================================

  window.setEarthAnalysisPoint = function (lat, lon) {

    lat = Number(lat);
    lon = Number(lon);

    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      lat < -90 ||
      lat > 90 ||
      lon < -180 ||
      lon > 180
    ) {
      return;
    }

    selectEarthPoint({
      lat: lat,
      lng: lon
    });
  };

  // =========================================================
  // 9. راه‌اندازی خودکار
  // =========================================================

  function initialize() {

    attachMapClick();

  }

  if (document.readyState === 'loading') {

    document.addEventListener(
      'DOMContentLoaded',
      initialize,
      { once: true }
    );

  } else {

    initialize();

  }

  // =========================================================
  // 10. اتصال مجدد در صورت آماده شدن نقشه
  // =========================================================

  window.EarthAnalysis = {
    attachMapClick: attachMapClick,
    selectEarthPoint: selectEarthPoint,
    getSelectedPoint: () => selectedPoint
  };

})();

