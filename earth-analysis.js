
/* =========================================================
   SATELLITE EXPLORER PRO
   EARTH ANALYSIS MODULE - INTEGRATED FIXED VERSION
   Map integration + GPS + Thermal + Mineral analysis
   ========================================================= */

(() => {
  'use strict';

  /* ===================== CONFIG ===================== */

  const CONFIG = {
    sentinelUrl: 'https://earth-search.aws.element84.com/v1/search',
    landsatUrl: 'https://landsatlook.usgs.gov/stac-server/search',
    timeout: 70000,
    maxCloud: 30,
    maxItems: 8
  };

  /* ===================== STATE ===================== */

  let selectedPoint = null;
  let analysisBusy = false;
  let thermalBusy = false;
  let mineralBusy = false;

  let pointMarker = null;
  let lastThermalData = null;
  let lastMineralData = null;

  /* ===================== HELPERS ===================== */

  const $ = id => document.getElementById(id);

  function log(message, error = false) {
    console[error ? 'error' : 'log'](
      '[EarthAnalysis]',
      message
    );
  }

  function formatNumber(value, digits = 2) {
    if (!Number.isFinite(Number(value))) return 'نامشخص';

    return Number(value).toFixed(digits);
  }

  function showMessage(element, message, type = 'info') {
    if (!element) return;

    element.textContent = message;
    element.dataset.status = type;
  }

  function setBusy(button, busy, text = 'در حال پردازش...') {
    if (!button) return;

    if (busy) {
      button.dataset.originalText =
        button.textContent || '';

      button.disabled = true;
      button.textContent = text;
    } else {
      button.disabled = false;

      if (button.dataset.originalText) {
        button.textContent =
          button.dataset.originalText;
      }
    }
  }

  async function fetchJSON(url, options = {}) {
    const controller = new AbortController();

    const timeout = setTimeout(
      () => controller.abort(),
      CONFIG.timeout
    );

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(
          `HTTP ${response.status}`
        );
      }

      return await response.json();
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error(
          'زمان دریافت اطلاعات به پایان رسید.'
        );
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  function validateCoordinates(lat, lon) {
    return (
      Number.isFinite(lat) &&
      Number.isFinite(lon) &&
      lat >= -90 &&
      lat <= 90 &&
      lon >= -180 &&
      lon <= 180
    );
  }

  function getCoordinatesFromMap() {
    if (!window.map) {
      throw new Error(
        'نقشه اصلی در دسترس نیست.'
      );
    }

    const center = window.map.getCenter();

    return {
      lat: center.lat,
      lon: center.lng
    };
  }

  function setSelectedPoint(lat, lon) {
    if (!validateCoordinates(lat, lon)) {
      throw new Error(
        'مختصات انتخاب‌شده معتبر نیست.'
      );
    }

    selectedPoint = {
      lat,
      lon,
      timestamp: Date.now()
    };

    const coordinatesText =
      `${lat.toFixed(6)}, ${lon.toFixed(6)}`;

    const coordinateElement =
      $('selectedCoordinates') ||
      $('earthPointText');

    if (coordinateElement) {
      coordinateElement.textContent =
        coordinatesText;
    }

    if (window.map && window.L) {
      if (pointMarker) {
        window.map.removeLayer(pointMarker);
      }

      pointMarker = window.L.marker([
        lat,
        lon
      ]).addTo(window.map);

      pointMarker.bindPopup(
        `<b>نقطه تحلیل زمین</b><br>${coordinatesText}`
      );
    }

    log('Selected point: ' + coordinatesText);

    return selectedPoint;
  }

  /* ===================== MAP INTEGRATION ===================== */

  function installMapEvents() {
    if (!window.map || !window.L) {
      log('Leaflet map is not available.');
      return;
    }

    window.map.on('click', event => {
      try {
        setSelectedPoint(
          event.latlng.lat,
          event.latlng.lng
        );
      } catch (error) {
        log(error.message, true);
      }
    });
  }

  /* ===================== SENTINEL-2 ===================== */

  async function searchSentinel2(lat, lon) {
    const body = {
      collections: ['sentinel-2-l2a'],
      limit: CONFIG.maxItems,
      intersects: {
        type: 'Point',
        coordinates: [lon, lat]
      },
      query: {
        'eo:cloud_cover': {
          lt: CONFIG.maxCloud
        }
      },
      sortby: [
        {
          field: 'datetime',
          direction: 'desc'
        }
      ]
    };

    const result = await fetchJSON(
      CONFIG.sentinelUrl,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      }
    );

    return result.features || [];
  }

  function getAssetUrl(item, name) {
    const asset = item.assets?.[name];

    if (!asset) return null;

    return asset.href || null;
  }

  function getSentinelMetadata(item) {
    const properties = item.properties || {};

    return {
      id: item.id,
      date: properties.datetime || 'نامشخص',
      cloud: properties['eo:cloud_cover'],
      platform: properties.platform || 'Sentinel-2',
      tile: properties['s2:mgrs_tile'] || 'نامشخص',
      assets: item.assets || {}
    };
  }

  /* ===================== MINERAL ANALYSIS ===================== */

  function calculateSpectralIndices(values) {
    const B02 = Number(values.B02);
    const B03 = Number(values.B03);
    const B04 = Number(values.B04);
    const B08 = Number(values.B08);
    const B11 = Number(values.B11);
    const B12 = Number(values.B12);

    const safeRatio = (a, b) => {
      const denominator = a + b;

      if (!Number.isFinite(denominator) ||
          Math.abs(denominator) < 1e-10) {
        return null;
      }

      return (a - b) / denominator;
    };

    return {
      NDVI: safeRatio(B08, B04),
      NDWI: safeRatio(B03, B08),
      NDBI: safeRatio(B11, B08),
      BSI: safeRatio(
        B11 + B04,
        B08 + B02
      ),
      SWIR_RATIO: safeRatio(B12, B11)
    };
  }

  function classifySurface(indices) {
    const ndvi = indices.NDVI;
    const ndwi = indices.NDWI;
    const ndbi = indices.NDBI;
    const bsi = indices.BSI;

    if (ndwi !== null && ndwi > 0.3) {
      return 'احتمال سطح آبی';
    }

    if (ndvi !== null && ndvi > 0.5) {
      return 'پوشش گیاهی متراکم';
    }

    if (
      bsi !== null &&
      bsi > 0.2 &&
      (ndvi === null || ndvi < 0.2)
    ) {
      return 'سطح خاکی یا منطقه کم‌پوشش';
    }

    if (ndbi !== null && ndbi > 0.2) {
      return 'احتمال سطح ساخته‌شده یا شهری';
    }

    return 'سطح مختلط یا نامشخص';
  }

  function renderMineralResults(data) {
    const output =
      $('mineralResult') ||
      $('earthMineralOutput');

    if (!output) return;

    const indices = data.indices || {};

    output.innerHTML = '';

    const container =
      document.createElement('div');

    container.className =
      'earth-analysis-result';

    const title =
      document.createElement('h3');

    title.textContent =
      'تحلیل طیفی زمین';

    container.appendChild(title);

    const table =
      document.createElement('table');

    table.className =
      'earth-analysis-table';

    const rows = [
      ['NDVI', indices.NDVI],
      ['NDWI', indices.NDWI],
      ['NDBI', indices.NDBI],
      ['BSI', indices.BSI],
      ['SWIR Ratio', indices.SWIR_RATIO]
    ];

    rows.forEach(([name, value]) => {
      const row =
        document.createElement('tr');

      const nameCell =
        document.createElement('td');

      const valueCell =
        document.createElement('td');

      nameCell.textContent = name;

      valueCell.textContent =
        value === null || value === undefined
          ? 'نامشخص'
          : formatNumber(value, 4);

      row.appendChild(nameCell);
      row.appendChild(valueCell);

      table.appendChild(row);
    });

    container.appendChild(table);

    const classification =
      document.createElement('p');

    classification.textContent =
      'طبقه‌بندی سطح: ' +
      classifySurface(indices);

    container.appendChild(classification);

    const date =
      document.createElement('p');

    date.textContent =
      'تاریخ تصویر: ' +
      (data.date || 'نامشخص');

    container.appendChild(date);

    output.appendChild(container);
  }

  async function loadMineralData() {
    if (mineralBusy) return;

    mineralBusy = true;

    const button =
      $('earthAnalyzeButton');

    setBusy(button, true);

    try {
      const point =
        selectedPoint ||
        getCoordinatesFromMap();

      const items =
        await searchSentinel2(
          point.lat,
          point.lon
        );

      if (!items.length) {
        throw new Error(
          'تصویر Sentinel-2 مناسب پیدا نشد. منطقه یا تاریخ دیگری را امتحان کنید.'
        );
      }

      const item = items[0];

      const metadata =
        getSentinelMetadata(item);

      const data = {
        metadata,
        date: metadata.date,
        assets: {
          B02: getAssetUrl(item, 'B02'),
          B03: getAssetUrl(item, 'B03'),
          B04: getAssetUrl(item, 'B04'),
          B08: getAssetUrl(item, 'B08'),
          B11: getAssetUrl(item, 'B11'),
          B12: getAssetUrl(item, 'B12')
        },
        indices: null,
        message:
          'تصویر Sentinel-2 دریافت شد. برای محاسبه شاخص‌ها، مقادیر باندها باید از داده رستری استخراج شوند.'
      };

      lastMineralData = data;

      renderMineralResults(data);

      showMessage(
        $('mineralResult') ||
        $('earthMineralOutput'),
        data.message,
        'success'
      );

      log('Sentinel-2 metadata loaded.');

      return data;
    } catch (error) {
      log(error.message, true);

      showMessage(
        $('mineralResult') ||
        $('earthMineralOutput'),
        'خطا در تحلیل معدنی: ' +
          error.message,
        'error'
      );
    } finally {
      mineralBusy = false;
      setBusy(button, false);
    }
  }

  /* ===================== LANDSAT / THERMAL ===================== */

  async function searchLandsat(lat, lon) {
    const body = {
      collections: [
        'landsat-c2l2-sr',
        'landsat-c2l2-st'
      ],
      limit: CONFIG.maxItems,
      intersects: {
        type: 'Point',
        coordinates: [lon, lat]
      },
      sortby: [
        {
          field: 'datetime',
          direction: 'desc'
        }
      ]
    };

    const result = await fetchJSON(
      CONFIG.landsatUrl,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      }
    );

    return result.features || [];
  }

  function renderThermalResults(data) {
    const output =
      $('thermalResult') ||
      $('earthThermalOutput');

    if (!output) return;

    output.innerHTML = '';

    const container =
      document.createElement('div');

    container.className =
      'earth-analysis-result';

    const title =
      document.createElement('h3');

    title.textContent =
      'اطلاعات حرارتی زمین';

    container.appendChild(title);

    const fields = [
      ['شناسه تصویر', data.id],
      ['تاریخ تصویر', data.date],
      ['ماهواره', data.platform],
      ['باند حرارتی', data.band],
      ['وضعیت', data.status]
    ];

    fields.forEach(([label, value]) => {
      const p =
        document.createElement('p');

      p.textContent =
        `${label}: ${value || 'نامشخص'}`;

      container.appendChild(p);
    });

    if (data.asset) {
      const link =
        document.createElement('a');

      link.href = data.asset;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent =
        'مشاهده فایل باند حرارتی';

      container.appendChild(link);
    }

    output.appendChild(container);
  }

  async function loadThermalData() {
    if (thermalBusy) return;

    thermalBusy = true;

    const button =
      $('earthThermalButton');

    setBusy(button, true);

    try {
      const point =
        selectedPoint ||
        getCoordinatesFromMap();

      const items =
        await searchLandsat(
          point.lat,
          point.lon
        );

      if (!items.length) {
        throw new Error(
          'تصویر Landsat مناسب پیدا نشد.'
        );
      }

      const item = items[0];
      const properties =
        item.properties || {};

      const assets =
        item.assets || {};

      const thermalAsset =
        assets['lwir11'] ||
        assets['ST_B10'] ||
        assets['B10'] ||
        assets['thermal'];

      const data = {
        id: item.id,
        date: properties.datetime,
        platform: properties.platform,
        band: thermalAsset
          ? thermalAsset.title || thermalAsset.key
          : 'ST_B10 / B10',
        asset: thermalAsset
          ? thermalAsset.href
          : null,
        status: thermalAsset
          ? 'باند حرارتی موجود است؛ استخراج دمای واقعی نیازمند پردازش پیکسل‌ها است.'
          : 'متادیتا دریافت شد؛ باند حرارتی مستقیم در این محصول پیدا نشد.'
      };

      lastThermalData = data;

      renderThermalResults(data);

      log('Landsat thermal metadata loaded.');

      return data;
    } catch (error) {
      log(error.message, true);

      showMessage(
        $('thermalResult') ||
        $('earthThermalOutput'),
        'خطا در تحلیل حرارتی: ' +
          error.message,
        'error'
      );
    } finally {
      thermalBusy = false;
      setBusy(button, false);
    }
  }

  /* ===================== GPS ===================== */

  function locateUser() {
    if (!navigator.geolocation) {
      showMessage(
        $('location'),
        'GPS در مرورگر پشتیبانی نمی‌شود.',
        'error'
      );

      return;
    }

    showMessage(
      $('location'),
      'در حال دریافت موقعیت GPS...',
      'info'
    );

    navigator.geolocation.getCurrentPosition(
      position => {
        const lat =
          position.coords.latitude;

        const lon =
          position.coords.longitude;

        try {
          setSelectedPoint(lat, lon);

          if (window.map) {
            window.map.setView(
              [lat, lon],
              12
            );
          }

          showMessage(
            $('location'),
            `GPS: ${lat.toFixed(5)}, ${lon.toFixed(5)}`,
            'success'
          );
        } catch (error) {
          showMessage(
            $('location'),
            error.message,
            'error'
          );
        }
      },
      error => {
        showMessage(
          $('location'),
          'خطای GPS: ' + error.message,
          'error'
        );
      },
      {
        enableHighAccuracy: true,
        timeout: 30000,
        maximumAge: 10000
      }
    );
  }

  /* ===================== PUBLIC API ===================== */

  window.EarthAnalysis = {
    setPoint: setSelectedPoint,

    getPoint() {
      return selectedPoint;
    },

    getMineralData() {
      return lastMineralData;
    },

    getThermalData() {
      return lastThermalData;
    },

    analyzeMinerals:
      loadMineralData,

    analyzeThermal:
      loadThermalData,

    locateUser
  };

  window.setEarthAnalysisPoint =
    setSelectedPoint;

  window.loadMineralData =
    loadMineralData;

  window.loadThermalData =
    loadThermalData;

  /* ===================== INIT ===================== */

  function init() {
    installMapEvents();

    const gpsButton =
      $('gpsTab');

    if (gpsButton) {
      gpsButton.addEventListener(
        'click',
        locateUser
      );
    }

    const mineralButton =
      $('earthAnalyzeButton');

    if (mineralButton) {
      mineralButton.addEventListener(
        'click',
        loadMineralData
      );
    }

    const thermalButton =
      $('earthThermalButton');

    if (thermalButton) {
      thermalButton.addEventListener(
        'click',
        loadThermalData
      );
    }

    log('Earth Analysis initialized.');
  }

  if (document.readyState === 'loading') {
    document.addEventListener(
      'DOMContentLoaded',
      init,
      { once: true }
    );
  } else {
    init();
  }

})();
