
/* =========================================================
   🛰️ SATELLITE EXPLORER PRO
   EARTH ANALYSIS PRO
   Landsat 8/9 LST + Sentinel-2 Spectral Analysis
   Map Selection + GPS + Real Satellite Data
   ========================================================= */

(() => {
  'use strict';

  const CONFIG = {
    API: 'https://earth-search.aws.element84.com/v1',
    CLOUD_MAX: 30,
    SEARCH_DAYS: 365,
    REQUEST_TIMEOUT: 30000,
    LANDSAT_COLLECTION: 'landsat-c2-l2',
    SENTINEL_COLLECTION: 'sentinel-2-l2a'
  };

  let selectedPoint = null;
  let pointMarker = null;
  let requestController = null;

  const $ = id => document.getElementById(id);

  // =====================================================
  // 1. MAP
  // =====================================================

  function getMap() {
    return window.map || null;
  }

  function setResult(id, message) {
    const element = $(id);
    if (element) element.textContent = message;
  }

  function formatCoord(value) {
    return Number(value).toFixed(6);
  }

  function formatDate(value) {
    if (!value) return 'نامشخص';

    return new Date(value).toLocaleDateString('fa-IR');
  }

  function validatePoint(lat, lon) {
    return Number.isFinite(lat) &&
      Number.isFinite(lon) &&
      lat >= -90 &&
      lat <= 90 &&
      lon >= -180 &&
      lon <= 180;
  }

  // =====================================================
  // 2. POINT SELECTION
  // =====================================================

  function selectEarthPoint(latlng) {
    const lat = Number(latlng.lat);
    const lon = Number(latlng.lng);

    if (!validatePoint(lat, lon)) return;

    selectedPoint = { lat, lon };

    const coordinates = $('selectedCoordinates');

    if (coordinates) {
      coordinates.textContent =
        `عرض: ${formatCoord(lat)}° | طول: ${formatCoord(lon)}°`;
    }

    const map = getMap();

    if (map && window.L) {
      if (pointMarker) {
        map.removeLayer(pointMarker);
      }

      pointMarker = L.circleMarker(
        [lat, lon],
        {
          radius: 9,
          color: '#ffe066',
          fillColor: '#ffcc00',
          fillOpacity: 0.95,
          weight: 2
        }
      )
        .addTo(map)
        .bindPopup(
          `نقطه تحلیل زمین<br>` +
          `Latitude: ${formatCoord(lat)}<br>` +
          `Longitude: ${formatCoord(lon)}`
        )
        .openPopup();
    }

    setResult(
      'thermalResult',
      'نقطه انتخاب شد. برای دریافت تصویر ماهواره‌ای دکمه تحلیل حرارتی را بزنید.'
    );

    setResult(
      'mineralResult',
      'نقطه انتخاب شد. برای تحلیل طیفی دکمه تحلیل معدنی را بزنید.'
    );
  }

  // =====================================================
  // 3. MAP CLICK
  // =====================================================

  function attachMapClick() {
    const map = getMap();

    if (!map || map._earthAnalysisAttached) return;

    map._earthAnalysisAttached = true;

    map.on('click', event => {
      selectEarthPoint(event.latlng);
    });
  }

  // =====================================================
  // 4. HTTP REQUEST
  // =====================================================

  async function requestJSON(url, options = {}) {
    const controller = new AbortController();

    const timeout = setTimeout(
      () => controller.abort(),
      CONFIG.REQUEST_TIMEOUT
    );

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(options.headers || {})
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      return await response.json();

    } finally {
      clearTimeout(timeout);
    }
  }

  // =====================================================
  // 5. STAC SEARCH
  // =====================================================

  async function searchSatellite(collection, days) {
    if (!selectedPoint) {
      throw new Error('ابتدا یک نقطه روی نقشه انتخاب کنید.');
    }

    const end = new Date();
    const start = new Date(
      end.getTime() - days * 86400000
    );

    const payload = {
      collections: [collection],

      intersects: {
        type: 'Point',
        coordinates: [
          selectedPoint.lon,
          selectedPoint.lat
        ]
      },

      datetime:
        start.toISOString() + '/' + end.toISOString(),

      limit: 30,

      sortby: [
        {
          field: 'properties.datetime',
          direction: 'desc'
        }
      ]
    };

    const data = await requestJSON(
      CONFIG.API + '/search',
      {
        method: 'POST',
        body: JSON.stringify(payload)
      }
    );

    return data.features || [];
  }

  // =====================================================
  // 6. BAND EXTRACTION
  // =====================================================

  function getAsset(feature, names) {
    if (!feature || !feature.assets) return null;

    for (const name of names) {
      if (feature.assets[name]) {
        return feature.assets[name];
      }
    }

    return null;
  }

  function getBandHref(feature, names) {
    const asset = getAsset(feature, names);

    return asset && asset.href
      ? asset.href
      : null;
  }

  // =====================================================
  // 7. THERMAL ANALYSIS
  // =====================================================

  window.loadThermalData = async function () {
    if (!selectedPoint) {
      setResult(
        'thermalResult',
        'ابتدا روی نقشه یک نقطه انتخاب کنید.'
      );
      return;
    }

    setResult(
      'thermalResult',
      'در حال جستجوی تصاویر Landsat 8 و 9 ...'
    );

    try {
      const features = await searchSatellite(
        CONFIG.LANDSAT_COLLECTION,
        CONFIG.SEARCH_DAYS
      );

      if (!features.length) {
        throw new Error(
          'تصویر Landsat برای این نقطه در بازه انتخابی یافت نشد.'
        );
      }

      const valid = features.filter(feature => {
        const cloud =
          feature.properties?.['eo:cloud_cover'];

        return cloud == null ||
          Number(cloud) <= CONFIG.CLOUD_MAX;
      });

      if (!valid.length) {
        throw new Error(
          'تصاویر موجود دارای پوشش ابری بیش از حد مجاز هستند.'
        );
      }

      const feature = valid[0];

      const thermal = getAsset(
        feature,
        ['lwir11', 'st_b10', 'ST_B10']
      );

      if (!thermal) {
        throw new Error(
          'باند حرارتی در اطلاعات تصویر موجود نیست.'
        );
      }

      const cloud =
        feature.properties?.['eo:cloud_cover'];

      const date = feature.properties?.datetime;

      const result =
        'تصویر واقعی Landsat پیدا شد.\n\n' +
        `مختصات: ${formatCoord(selectedPoint.lat)}, ` +
        `${formatCoord(selectedPoint.lon)}\n` +
        `تاریخ تصویر: ${formatDate(date)}\n` +
        `پوشش ابر: ${cloud ?? 'نامشخص'} درصد\n` +
        `باند حرارتی: ${thermal.title || thermal.name || thermal.href}\n\n` +
        'وضعیت: فراداده تصویر دریافت شد.\n' +
        'برای محاسبه عدد واقعی دمای سطح زمین، باید داده پیکسلی باند حرارتی دریافت و ضریب تبدیل Landsat روی آن اعمال شود.';

      setResult('thermalResult', result);

    } catch (error) {
      console.error('Thermal Analysis:', error);

      setResult(
        'thermalResult',
        'خطا در تحلیل حرارتی:\n' + error.message
      );
    }
  };

  // =====================================================
  // 8. MINERAL / SPECTRAL ANALYSIS
  // =====================================================

  window.loadMineralData = async function () {
    if (!selectedPoint) {
      setResult(
        'mineralResult',
        'ابتدا روی نقشه یک نقطه انتخاب کنید.'
      );
      return;
    }

    setResult(
      'mineralResult',
      'در حال جستجوی تصاویر Sentinel-2 ...'
    );

    try {
      const features = await searchSatellite(
        CONFIG.SENTINEL_COLLECTION,
        CONFIG.SEARCH_DAYS
      );

      if (!features.length) {
        throw new Error(
          'تصویر Sentinel-2 برای این نقطه یافت نشد.'
        );
      }

      const valid = features.filter(feature => {
        const cloud =
          feature.properties?.['eo:cloud_cover'];

        return cloud == null ||
          Number(cloud) <= CONFIG.CLOUD_MAX;
      });

      if (!valid.length) {
        throw new Error(
          'تصاویر مناسب با پوشش ابر کمتر از حد مجاز یافت نشد.'
        );
      }

      const feature = valid[0];

      const bands = {
        B02: getBandHref(feature, ['blue', 'B02']),
        B03: getBandHref(feature, ['green', 'B03']),
        B04: getBandHref(feature, ['red', 'B04']),
        B08: getBandHref(feature, ['nir', 'B08']),
        B11: getBandHref(feature, ['swir16', 'B11']),
        B12: getBandHref(feature, ['swir22', 'B12'])
      };

      const available = Object.entries(bands)
        .filter(([, value]) => Boolean(value))
        .map(([name]) => name);

      if (available.length < 4) {
        throw new Error(
          'باندهای کافی برای تحلیل طیفی در دسترس نیستند.'
        );
      }

      const cloud =
        feature.properties?.['eo:cloud_cover'];

      const date = feature.properties?.datetime;

      let result =
        'تصویر واقعی Sentinel-2 پیدا شد.\n\n' +
        `تاریخ تصویر: ${formatDate(date)}\n` +
        `پوشش ابر: ${cloud ?? 'نامشخص'} درصد\n` +
        `باندهای موجود: ${available.join(', ')}\n\n`;

      result +=
        'شاخص‌های قابل محاسبه پس از دریافت داده پیکسلی:\n\n' +
        'NDVI: پوشش گیاهی\n' +
        'NDMI: رطوبت سطحی\n' +
        'BSI: خاک بدون پوشش گیاهی\n' +
        'شاخص‌های SWIR: بررسی ویژگی‌های طیفی سطح زمین\n\n';

      result +=
        'وضعیت: فراداده و باندهای تصویر دریافت شدند؛ ' +
        'مقادیر عددی شاخص‌ها هنوز محاسبه نشده‌اند.';

      setResult('mineralResult', result);

    } catch (error) {
      console.error('Mineral Analysis:', error);

      setResult(
        'mineralResult',
        'خطا در تحلیل طیفی:\n' + error.message
      );
    }
  };

  // =====================================================
  // 9. GPS / EXTERNAL POINT
  // =====================================================

  window.setEarthAnalysisPoint = function (lat, lon) {
    lat = Number(lat);
    lon = Number(lon);

    if (!validatePoint(lat, lon)) {
      setResult(
        'selectedCoordinates',
        'مختصات وارد شده معتبر نیست.'
      );
      return;
    }

    selectEarthPoint({
      lat,
      lng: lon
    });
  };

  // =====================================================
  // 10. GET SELECTED POINT
  // =====================================================

  window.EarthAnalysis = {
    attachMapClick,
    selectEarthPoint,

    getSelectedPoint() {
      return selectedPoint
        ? { ...selectedPoint }
        : null;
    }
  };

  // =====================================================
  // 11. INITIALIZATION
  // =====================================================

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

  // =====================================================
  // 12. MAP RECONNECTION
  // =====================================================

  const reconnect = setInterval(() => {
    attachMapClick();

    if (getMap() &&
        getMap()._earthAnalysisAttached) {
      clearInterval(reconnect);
    }
  }, 1000);

})();
