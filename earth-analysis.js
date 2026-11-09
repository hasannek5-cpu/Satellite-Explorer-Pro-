
/* =========================================================
   🛰️ Satellite Explorer - Earth Analysis + Regional Aircraft
   نسخه اعتبارسنجی علمی داده‌های Sentinel-2 و Landsat
   این فایل را بعد از app.js بارگذاری کنید.
   ========================================================= */

(() => {
  'use strict';

  if (typeof L === 'undefined' || typeof map === 'undefined') {
    console.error('Earth analysis: Leaflet/map is not ready.');
    return;
  }

  const STAC_URL = 'https://earth-search.aws.element84.com/v1/search';
  const AIRCRAFT_RADIUS_NM = 120;
  const REQUEST_TIMEOUT_MS = 25000;

  let selectedPoint = null;
  let mineralBusy = false;
  let thermalBusy = false;
  let analysisMarker = null;

  /* -------------------- پنل و ظاهر -------------------- */

  const oldPanel = document.getElementById('earthAnalysisPanel');
  if (oldPanel) oldPanel.remove();

  const oldStyle = document.getElementById('earthAnalysisStyles');
  if (oldStyle) oldStyle.remove();

  const style = document.createElement('style');
  style.id = 'earthAnalysisStyles';
  style.textContent = `
    #earthAnalysisPanel {
      position:absolute; z-index:1000; left:10px; bottom:12px;
      width:min(370px,calc(100% - 20px)); max-height:52%;
      overflow:auto; direction:rtl; color:#f4f8ff;
      background:rgba(12,29,49,.97); border:1px solid #00bcd4;
      border-radius:12px; padding:12px; box-shadow:0 3px 14px #0008;
      font:13px/1.9 Tahoma,Arial,sans-serif;
    }
    #earthAnalysisPanel h3 {margin:0 0 7px;color:#55dfff;font-size:15px}
    #earthAnalysisPanel button {
      width:100%; margin:5px 0; padding:9px; border:0;
      border-radius:8px; color:white; background:#087cf0;
      font-weight:bold; font-size:13px;
    }
    #earthAnalysisPanel button:disabled {opacity:.55}
    #earthAnalysisPanel .earth-muted {color:#b9c8d8;font-size:11px}
    #earthAnalysisPanel .earth-result {
      background:#183652; border-radius:8px; padding:8px; margin-top:8px;
      overflow-wrap:anywhere;
    }
    #earthAnalysisPanel .earth-ok {color:#8df0b1;font-weight:bold}
    #earthAnalysisPanel .earth-warn {color:#ffd27a;font-weight:bold}
    #earthAnalysisPanel .earth-bad {color:#ff9c9c;font-weight:bold}
  `;
  document.head.appendChild(style);

  const mapContainer = map.getContainer();

  if (getComputedStyle(mapContainer).position === 'static') {
    mapContainer.style.position = 'relative';
  }

  const panel = document.createElement('section');
  panel.id = 'earthAnalysisPanel';

  panel.innerHTML = `
    <h3>🌍 تحلیل نقطه انتخابی</h3>

    <div id="earthPointText">
      برای شروع، روی یک نقطه از نقشه بزنید.
    </div>

    <button id="earthAnalyzeButton" type="button" disabled>
      🔬 تحلیل خاک و شاخص‌های طیفی
    </button>

    <button id="earthThermalButton" type="button" disabled>
      🌡️ دریافت دمای سطح زمین
    </button>

    <div id="earthMineralOutput" class="earth-result">
      شاخص‌های طیفی هنوز دریافت نشده‌اند.
    </div>

    <div id="earthThermalOutput" class="earth-result">
      داده حرارتی هنوز دریافت نشده است.
    </div>

    <div class="earth-muted">
      این خروجی‌ها سنجش‌ازدور اکتشافی هستند؛ شاخص‌های طیفی به‌تنهایی
      وجود معدن، نوع کانی یا ترکیب شیمیایی خاک را اثبات نمی‌کنند.
    </div>
  `;

  mapContainer.appendChild(panel);

  const $ = id => document.getElementById(id);

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = String(value ?? '');
  }

  function setHTML(id, value) {
    const el = $(id);
    if (el) el.innerHTML = value;
  }

  function safe(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    })[ch]);
  }

  function formatNumber(value, digits = 3) {
    return Number.isFinite(value)
      ? value.toFixed(digits)
      : 'نامشخص';
  }

  function timeoutSignal(milliseconds) {
    const controller = new AbortController();

    const timer = window.setTimeout(
      () => controller.abort(),
      milliseconds
    );

    return {
      controller,
      clear: () => window.clearTimeout(timer)
    };
  }

  /* -------------------- کتابخانه‌های رستری -------------------- */

  function loadScriptOnce(src, globalName) {
    if (window[globalName]) {
      return Promise.resolve(window[globalName]);
    }

    return new Promise((resolve, reject) => {
      let script = document.querySelector(
        `script[data-earth-lib="${globalName}"]`
      );

      if (
        script &&
        script.dataset.loaded === 'true' &&
        window[globalName]
      ) {
        resolve(window[globalName]);
        return;
      }

      const isNewScript = !script;

      if (!script) {
        script = document.createElement('script');
        script.src = src;
        script.async = true;
        script.dataset.earthLib = globalName;
      }

      const onLoad = () => {
        script.dataset.loaded = 'true';

        if (window[globalName]) {
          resolve(window[globalName]);
        } else {
          reject(
            new Error(
              `کتابخانه ${globalName} بارگذاری شد اما در دسترس نیست.`
            )
          );
        }
      };

      const onError = () => {
        reject(
          new Error(`بارگذاری کتابخانه ${globalName} ناموفق بود.`)
        );
      };

      script.addEventListener('load', onLoad, { once: true });
      script.addEventListener('error', onError, { once: true });

      if (isNewScript) {
        document.head.appendChild(script);
      }

      window.setTimeout(() => {
        if (!window[globalName]) {
          reject(
            new Error(`مهلت بارگذاری ${globalName} تمام شد.`)
          );
        }
      }, REQUEST_TIMEOUT_MS);
    });
  }

  async function ensureRasterLibraries() {
    await Promise.all([
      loadScriptOnce(
        'https://cdn.jsdelivr.net/npm/geotiff@2.1.3/dist-browser/geotiff.js',
        'GeoTIFF'
      ),

      loadScriptOnce(
        'https://cdn.jsdelivr.net/npm/proj4@2.11.0/dist/proj4.js',
        'proj4'
      )
    ]);
  }

  /* -------------------- جست‌وجوی STAC -------------------- */

  function daysAgoISO(days) {
    return new Date(
      Date.now() - days * 86400000
    ).toISOString();
  }

  async function searchStac(
    collection,
    lat,
    lon,
    days,
    cloudLimit
  ) {
    const request = timeoutSignal(REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(STAC_URL, {
        method: 'POST',

        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/geo+json, application/json'
        },

        signal: request.controller.signal,

        body: JSON.stringify({
          collections: [collection],

          intersects: {
            type: 'Point',
            coordinates: [lon, lat]
          },

          datetime:
            `${daysAgoISO(days)}/${new Date().toISOString()}`,

          limit: 40,

          query: {
            'eo:cloud_cover': {
              lte: cloudLimit
            }
          },

          sortby: [
            {
              field: 'properties.datetime',
              direction: 'desc'
            }
          ]
        })
      });

      if (!response.ok) {
        throw new Error(
          `جست‌وجوی ${collection} با خطای HTTP ${response.status} روبه‌رو شد.`
        );
      }

      const data = await response.json();

      return Array.isArray(data.features)
        ? data.features
        : [];

    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error('مهلت دریافت فهرست تصاویر تمام شد.');
      }

      throw error;

    } finally {
      request.clear();
    }
  }

  function getAsset(item, candidates) {
    const assets = item && item.assets
      ? item.assets
      : {};

    for (const candidate of candidates) {
      if (assets[candidate] && assets[candidate].href) {
        return {
          key: candidate,
          asset: assets[candidate]
        };
      }
    }

    const key = Object.keys(assets).find(k =>
      candidates.some(candidate =>
        k.toLowerCase() === candidate.toLowerCase()
      )
    );

    return key
      ? { key, asset: assets[key] }
      : null;
  }

  function itemDate(item) {
    const value =
      item &&
      item.properties &&
      item.properties.datetime;

    if (!value) return 'نامشخص';

    const date = new Date(value);

    return Number.isNaN(date.getTime())
      ? 'نامشخص'
      : date.toLocaleDateString('fa-IR');
  }

  function itemCloud(item) {
    const value = Number(
      item &&
      item.properties &&
      item.properties['eo:cloud_cover']
    );

    return Number.isFinite(value)
      ? value
      : null;
  }

  /* -------------------- خواندن پیکسل از COG -------------------- */

  function getEpsg(image, item, asset) {
    const assetEpsg = asset && asset['proj:epsg'];

    const itemEpsg =
      item &&
      item.properties &&
      item.properties['proj:epsg'];

    const epsg = Number(assetEpsg || itemEpsg || 0);

    if (epsg) return epsg;

    const keys = image.getGeoKeys
      ? image.getGeoKeys()
      : {};

    return Number(
      keys.ProjectedCSTypeGeoKey ||
      keys.GeographicTypeGeoKey ||
      0
    );
  }

  async function readRawPixel(
    item,
    assetInfo,
    lat,
    lon
  ) {
    if (
      !assetInfo ||
      !assetInfo.asset ||
      !assetInfo.asset.href
    ) {
      throw new Error(
        'باند موردنیاز در تصویر موجود نیست.'
      );
    }

    const tiff = await window.GeoTIFF.fromUrl(
      assetInfo.asset.href,
      { cache: true }
    );

    const image = await tiff.getImage();

    const epsg = getEpsg(
      image,
      item,
      assetInfo.asset
    );

    if (!epsg) {
      throw new Error(
        'سیستم مختصات تصویر قابل شناسایی نیست.'
      );
    }

    const projected = window.proj4(
      'EPSG:4326',
      `EPSG:${epsg}`,
      [lon, lat]
    );

    const bounds = image.getBoundingBox();

    const width = image.getWidth();
    const height = image.getHeight();

    const [minX, minY, maxX, maxY] = bounds;

    if (
      !Number.isFinite(projected[0]) ||
      !Number.isFinite(projected[1]) ||
      projected[0] < minX ||
      projected[0] >= maxX ||
      projected[1] <= minY ||
      projected[1] > maxY
    ) {
      throw new Error(
        'نقطه انتخابی خارج از محدوده این تصویر است.'
      );
    }

    const pixelWidth = (maxX - minX) / width;
    const pixelHeight = (maxY - minY) / height;

    if (
      !(pixelWidth > 0) ||
      !(pixelHeight > 0)
    ) {
      throw new Error('ابعاد تصویر معتبر نیست.');
    }

    const px = Math.max(
      0,
      Math.min(
        width - 1,
        Math.floor(
          (projected[0] - minX) / pixelWidth
        )
      )
    );

    const py = Math.max(
      0,
      Math.min(
        height - 1,
        Math.floor(
          (maxY - projected[1]) / pixelHeight
        )
      )
    );

    const raster = await image.readRasters({
      window: [
        px,
        py,
        px + 1,
        py + 1
      ],
      samples: [0],
      interleave: true
    });

    const raw = Number(raster[0]);

    const bandMeta =
      Array.isArray(assetInfo.asset['raster:bands'])
        ? (assetInfo.asset['raster:bands'][0] || {})
        : {};

    const nodata = bandMeta.nodata;

    if (
      !Number.isFinite(raw) ||
      (
        nodata !== undefined &&
        raw === Number(nodata)
      ) ||
      raw === -9999 ||
      raw === -32768
    ) {
      throw new Error(
        'پیکسل انتخابی فاقد داده معتبر است.'
      );
    }

    return {
      raw,

      scale:
        bandMeta.scale !== undefined &&
        bandMeta.scale !== null &&
        Number.isFinite(Number(bandMeta.scale))
          ? Number(bandMeta.scale)
          : null,

      offset:
        bandMeta.offset !== undefined &&
        bandMeta.offset !== null &&
        Number.isFinite(Number(bandMeta.offset))
          ? Number(bandMeta.offset)
          : null,

      nodata,

      key: assetInfo.key,

      resolution: Number(
        bandMeta.spatial_resolution ||
        assetInfo.asset.gsd ||
        0
      ) || null
    };
  }

  function applyScaleOffset(
    sample,
    fallbackScale,
    fallbackOffset
  ) {
    const scale =
      sample.scale !== null
        ? sample.scale
        : fallbackScale;

    const offset =
      sample.offset !== null
        ? sample.offset
        : fallbackOffset;

    if (
      !Number.isFinite(scale) ||
      !Number.isFinite(offset)
    ) {
      throw new Error(
        'ضریب تبدیل باند مشخص نیست؛ برای جلوگیری از عددسازی، نتیجه نمایش داده نشد.'
      );
    }

    return sample.raw * scale + offset;
  }

  function normalizedDifference(a, b) {
    const sum = a + b;

    return (
      Number.isFinite(sum) &&
      Math.abs(sum) > 1e-9
    )
      ? (a - b) / sum
      : null;
  }

  function ratio(a, b) {
    return (
      Number.isFinite(a) &&
      Number.isFinite(b) &&
      Math.abs(b) > 1e-9
    )
      ? a / b
      : null;
  }

  /* -------------------- کنترل کیفیت Sentinel-2 -------------------- */

  async function readSentinelScene(
    item,
    lat,
    lon
  ) {
    const assets = {
      blue: getAsset(item, ['blue', 'B02']),
      green: getAsset(item, ['green', 'B03']),
      red: getAsset(item, ['red', 'B04']),
      nir: getAsset(item, ['nir', 'B08']),
      swir16: getAsset(item, ['swir16', 'B11']),
      swir22: getAsset(item, ['swir22', 'B12']),
      scl: getAsset(item, ['scl', 'SCL'])
    };

    const required = [
      'blue',
      'red',
      'nir',
      'swir16',
      'swir22',
      'scl'
    ];

    const missing = required.filter(
      name => !assets[name]
    );

    if (missing.length) {
      throw new Error(
        `باندهای لازم موجود نیستند: ${missing.join(', ')}`
      );
    }

    const names = [
      'blue',
      'red',
      'nir',
      'swir16',
      'swir22',
      'scl'
    ];

    const samples = {};

    for (const name of names) {
      samples[name] = await readRawPixel(
        item,
        assets[name],
        lat,
        lon
      );
    }

    const scl = Math.round(samples.scl.raw);

    // Sentinel-2 SCL:
    // 0 بدون داده
    // 1 پیکسل اشباع/معیوب
    // 3 سایه ابر
    // 8 ابر متوسط
    // 9 ابر زیاد
    // 10 سیروس
    // 11 برف/یخ

    const invalidScl = new Set([
      0, 1, 3, 8, 9, 10, 11
    ]);

    if (invalidScl.has(scl)) {
      const labels = {
        0: 'بدون داده',
        1: 'پیکسل اشباع یا معیوب',
        3: 'سایه ابر',
        8: 'ابر با احتمال متوسط',
        9: 'ابر با احتمال زیاد',
        10: 'ابر سیروس',
        11: 'برف یا یخ'
      };

      throw new Error(
        `پیکسل انتخابی برای تحلیل معتبر نیست: ${
          labels[scl] || 'کیفیت نامعتبر'
        }. نقطه دیگری انتخاب کنید.`
      );
    }

    const reflectance = {};

    for (const name of [
      'blue',
      'red',
      'nir',
      'swir16',
      'swir22'
    ]) {
      // Collection 1:
      // استفاده از scale و offset خود متادیتای باند.
      // در نبود متادیتا، مقیاس 0.0001 و آفست صفر.
      reflectance[name] = applyScaleOffset(
        samples[name],
        0.0001,
        0
      );

      if (
        !Number.isFinite(reflectance[name]) ||
        reflectance[name] < -0.15 ||
        reflectance[name] > 1.6
      ) {
        throw new Error(
          `بازتاب باند ${name} خارج از محدوده قابل قبول است؛ احتمال ناسازگاری متادیتا وجود دارد.`
        );
      }
    }

    return {
      reflectance,
      scl,
      samples
    };
  }

  function surfaceDescription(
    ndvi,
    bsi,
    ndmi
  ) {
    if (
      ndvi !== null &&
      ndvi < -0.1 &&
      ndmi !== null &&
      ndmi > 0.1
    ) {
      return 'احتمال آب یا سطح بسیار مرطوب';
    }

    if (ndvi !== null && ndvi >= 0.4) {
      return 'پوشش گیاهی متراکم یا فعال';
    }

    if (ndvi !== null && ndvi >= 0.2) {
      return 'پوشش گیاهی متوسط';
    }

    if (
      bsi !== null &&
      bsi > 0.15 &&
      (ndvi === null || ndvi < 0.2)
    ) {
      return 'سطح کم‌پوشش یا خاک برهنه محتمل است';
    }

    return 'سطح مختلط؛ برای تعیین نوع خاک به داده تکمیلی نیاز است';
  }

  async function analyzeMinerals() {
    if (!selectedPoint || mineralBusy) return;

    mineralBusy = true;

    const button = $('earthAnalyzeButton');

    if (button) button.disabled = true;

    setText(
      'earthMineralOutput',
      'در حال دریافت و کنترل کیفیت تصویر Sentinel-2...'
    );

    try {
      await ensureRasterLibraries();

      const items = await searchStac(
        'sentinel-2-c1-l2a',
        selectedPoint.lat,
        selectedPoint.lon,
        730,
        80
      );

      if (!items.length) {
        throw new Error(
          'در دو سال اخیر تصویر Sentinel-2 برای این نقطه پیدا نشد.'
        );
      }

      const ranked = items.slice().sort((a, b) => {
        const ca = itemCloud(a);
        const cb = itemCloud(b);

        return (
          (ca === null ? 100 : ca) -
          (cb === null ? 100 : cb)
        );
      });

      let chosen = null;
      let scene = null;
      let lastError = null;

      for (const item of ranked.slice(0, 12)) {
        try {
          const result = await readSentinelScene(
            item,
            selectedPoint.lat,
            selectedPoint.lon
          );

          chosen = item;
          scene = result;
          break;

        } catch (error) {
          lastError = error;
        }
      }

      if (!chosen || !scene) {
        throw new Error(
          lastError
            ? lastError.message
            : 'هیچ پیکسل معتبر و بدون ابر پیدا نشد.'
        );
      }

      const r = scene.reflectance;

      const ndvi = normalizedDifference(
        r.nir,
        r.red
      );

      const ndmi = normalizedDifference(
        r.nir,
        r.swir16
      );

      const bsiDenominator =
        r.swir16 +
        r.red +
        r.nir +
        r.blue;

      const bsi =
        Math.abs(bsiDenominator) > 1e-9
          ? (
              (r.swir16 + r.red) -
              (r.nir + r.blue)
            ) / bsiDenominator
          : null;

      // نسبت‌های کمکی اکتشافی؛ تشخیص قطعی کانی نیستند.
      const ferricProxy = ratio(
        r.red,
        r.blue
      );

      const clayProxy = ratio(
        r.swir16,
        r.swir22
      );

      const cloud = itemCloud(chosen);
      const date = itemDate(chosen);

      const description = surfaceDescription(
        ndvi,
        bsi,
        ndmi
      );

      const qualityText =
        cloud === null
          ? 'ابر صحنه نامشخص؛ کیفیت باید با احتیاط تفسیر شود.'
          : cloud <= 20
            ? 'پوشش ابر کلی صحنه کم است؛ پیکسل انتخابی نیز از نظر SCL کنترل شد.'
            : 'پوشش ابر کلی صحنه نسبتاً زیاد است؛ پیکسل انتخابی از نظر SCL معتبر بوده است.';

      setHTML('earthMineralOutput', `
        <b>🔬 تحلیل طیفی Sentinel-2 Collection 1</b><br>

        <span class="earth-ok">
          ✓ پیکسل از کنترل کیفیت SCL عبور کرد
        </span><br>

        تاریخ تصویر: ${safe(date)}<br>

        پوشش ابر کل صحنه:
        ${cloud === null ? 'نامشخص' : cloud.toFixed(1) + '%'}<br>

        وضوح باندها:
        قرمز/آبی/NIR حدود 10 متر؛ SWIR حدود 20 متر<br>

        طبقه‌بندی کلی:
        <b>${safe(description)}</b><br>

        NDVI پوشش گیاهی:
        ${formatNumber(ndvi)}<br>

        NDMI رطوبت نسبی پوشش/سطح:
        ${formatNumber(ndmi)}<br>

        BSI خاک برهنه:
        ${formatNumber(bsi)}<br>

        نسبت قرمز/آبی (شاخص کمکی اکسید آهن):
        ${formatNumber(ferricProxy)}<br>

        نسبت SWIR1/SWIR2 (شاخص کمکی رس/کانی):
        ${formatNumber(clayProxy)}<br>

        کلاس SCL: ${scene.scl}<br>

        <span class="earth-muted">
          ${safe(qualityText)}
        </span><br>

        <span class="earth-warn">
          تفسیر زمین‌شناسی قطعی نیست: نسبت‌ها به سنگ‌شناسی،
          خاک، رطوبت، زاویه تابش و شرایط جوی وابسته‌اند
          و برای اثبات ذخیره معدنی کافی نیستند.
        </span><br>

        <span class="earth-muted">
          شناسه تصویر: ${safe(chosen.id)}
        </span>
      `);

    } catch (error) {
      console.error('Sentinel analysis error:', error);

      setText(
        'earthMineralOutput',
        'تحلیل معتبر انجام نشد: ' + error.message
      );

    } finally {
      mineralBusy = false;

      if (button) {
        button.disabled = !selectedPoint;
      }
    }
  }

  /* -------------------- کنترل کیفیت Landsat -------------------- */

  function landsatQaIsBad(qa) {
    const value = Math.round(qa);

    // QA_PIXEL bits 0-5:
    // fill, dilated cloud, cirrus, cloud, cloud shadow, snow.
    return (value & 0b111111) !== 0;
  }

  async function analyzeThermal() {
    if (!selectedPoint || thermalBusy) return;

    thermalBusy = true;

    const button = $('earthThermalButton');

    if (button) button.disabled = true;

    setText(
      'earthThermalOutput',
      'در حال دریافت باند دمای سطح و کنترل کیفیت Landsat...'
    );

    try {
      await ensureRasterLibraries();

      const items = await searchStac(
        'landsat-c2-l2',
        selectedPoint.lat,
        selectedPoint.lon,
        730,
        80
      );

      if (!items.length) {
        throw new Error(
          'تصویر Landsat Collection 2 در دو سال اخیر پیدا نشد.'
        );
      }

      let chosen = null;
      let thermal = null;
      let qaSample = null;
      let stQaSample = null;
      let lastError = null;

      const ranked = items.slice().sort((a, b) => {
        const ca = itemCloud(a);
        const cb = itemCloud(b);

        return (
          (ca === null ? 100 : ca) -
          (cb === null ? 100 : cb)
        );
      });

      for (const item of ranked.slice(0, 15)) {
        try {
          const thermalAsset = getAsset(
            item,
            [
              'lwir11',
              'ST_B10',
              'st',
              'surface_temperature'
            ]
          );

          if (!thermalAsset) continue;

          const sample = await readRawPixel(
            item,
            thermalAsset,
            selectedPoint.lat,
            selectedPoint.lon
          );

          // در Landsat Collection 2 مقدار صفر fill/no-data است.
          if (sample.raw === 0) {
            throw new Error(
              'پیکسل دمایی مقدار fill برابر صفر دارد.'
            );
          }

          const qaAsset = getAsset(
            item,
            ['qa_pixel', 'QA_PIXEL']
          );

          let qa = null;

          if (qaAsset) {
            qa = await readRawPixel(
              item,
              qaAsset,
              selectedPoint.lat,
              selectedPoint.lon
            );

            if (landsatQaIsBad(qa.raw)) {
              throw new Error(
                'پیکسل Landsat طبق QA_PIXEL دارای ابر، سایه، برف یا داده نامعتبر است.'
              );
            }
          }

          const stQaAsset = getAsset(
            item,
            ['st_qa', 'ST_QA']
          );

          let stQa = null;

          if (stQaAsset) {
            stQa = await readRawPixel(
              item,
              stQaAsset,
              selectedPoint.lat,
              selectedPoint.lon
            );
          }

          chosen = item;
          thermal = sample;
          qaSample = qa;
          stQaSample = stQa;

          break;

        } catch (error) {
          lastError = error;
        }
      }

      if (!chosen || !thermal) {
        throw new Error(
          lastError
            ? lastError.message
            : 'پیکسل حرارتی معتبر در تصاویر پیدا نشد.'
        );
      }

      // Landsat Collection 2:
      // Kelvin = DN * 0.00341802 + 149
      const tempKelvin = applyScaleOffset(
        thermal,
        0.00341802,
        149.0
      );

      const tempCelsius = tempKelvin - 273.15;

      if (
        !Number.isFinite(tempCelsius) ||
        tempKelvin < 180 ||
        tempKelvin > 400 ||
        tempCelsius < -93.15 ||
        tempCelsius > 126.85
      ) {
        throw new Error(
          'دمای محاسبه‌شده خارج از محدوده فیزیکی معتبر است؛ نتیجه رد شد.'
        );
      }

      let uncertainty = null;

      if (stQaSample) {
        // ST_QA معمولاً با ضریب 0.01 کلوین ذخیره می‌شود.
        uncertainty = applyScaleOffset(
          stQaSample,
          0.01,
          0
        );

        if (
          !Number.isFinite(uncertainty) ||
          uncertainty < 0 ||
          uncertainty > 20
        ) {
          uncertainty = null;
        }
      }

      const cloud = itemCloud(chosen);
      const date = itemDate(chosen);

      const qaText = qaSample
        ? '✓ پیکسل از کنترل QA_PIXEL عبور کرد.'
        : '⚠️ باند QA_PIXEL در این آیتم در دسترس نبود؛ حذف ابر/سایه به‌طور کامل تأیید نشده است.';

      setHTML('earthThermalOutput', `
        <b>🌡️ دمای سطح زمین Landsat Collection 2</b><br>

        <span class="earth-ok">
          ${safe(qaText)}
        </span><br>

        دمای سطح:
        <b>${tempCelsius.toFixed(1)} °C</b><br>

        دما بر حسب کلوین:
        ${tempKelvin.toFixed(1)} K<br>

        تاریخ تصویر:
        ${safe(date)}<br>

        پوشش ابر کل صحنه:
        ${cloud === null ? 'نامشخص' : cloud.toFixed(1) + '%'}<br>

        وضوح مکانی معمول:
        30 متر<br>

        ${
          uncertainty === null
            ? ''
            : `عدم‌قطعیت تقریبی ST_QA: ±${uncertainty.toFixed(1)} K<br>`
        }

        <span class="earth-muted">
          این مقدار دمای سطح در زمان عبور ماهواره است،
          نه دمای هوای فعلی و نه دمای لحظه‌ای.
        </span><br>

        <span class="earth-muted">
          شناسه تصویر: ${safe(chosen.id)}
        </span>
      `);

    } catch (error) {
      console.error('Landsat thermal error:', error);

      setText(
        'earthThermalOutput',
        'دمای معتبر به دست نیامد: ' + error.message
      );

    } finally {
      thermalBusy = false;

      if (button) {
        button.disabled = !selectedPoint;
      }
    }
  }

  /* -------------------- انتخاب نقطه روی نقشه -------------------- */

  function selectMapPoint(lat, lon) {
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon)
    ) return;

    selectedPoint = { lat, lon };

    setText(
      'earthPointText',
      `مختصات انتخابی: ${lat.toFixed(6)}, ${lon.toFixed(6)}`
    );

    const coordinateOutput = $('selectedCoordinates');

    if (coordinateOutput) {
      coordinateOutput.textContent =
        `عرض: ${lat.toFixed(6)} | طول: ${lon.toFixed(6)}`;
    }

    if (analysisMarker) {
      map.removeLayer(analysisMarker);
    }

    analysisMarker = L.circleMarker(
      [lat, lon],
      {
        radius: 8,
        color: '#ffeb3b',
        fillColor: '#ff9800',
        fillOpacity: 0.9,
        weight: 2
      }
    )
      .addTo(map)
      .bindPopup(
        `نقطه تحلیل<br>${lat.toFixed(6)}, ${lon.toFixed(6)}`
      )
      .openPopup();

    $('earthAnalyzeButton').disabled = false;
    $('earthThermalButton').disabled = false;

    setText(
      'earthMineralOutput',
      'نقطه انتخاب شد؛ برای محاسبه شاخص‌های طیفی دکمه تحلیل را بزنید.'
    );

    setText(
      'earthThermalOutput',
      'نقطه انتخاب شد؛ برای محاسبه دمای سطح دکمه حرارتی را بزنید.'
    );
  }

  // جلوگیری از ثبت چندباره رویداد کلیک نقشه
  if (window.__earthAnalysisMapClick) {
    map.off(
      'click',
      window.__earthAnalysisMapClick
    );
  }

  window.__earthAnalysisMapClick = event => {
    selectMapPoint(
      event.latlng.lat,
      event.latlng.lng
    );
  };

  map.on(
    'click',
    window.__earthAnalysisMapClick
  );

  $('earthAnalyzeButton').addEventListener(
    'click',
    analyzeMinerals
  );

  $('earthThermalButton').addEventListener(
    'click',
    analyzeThermal
  );

  window.loadMineralData = analyzeMinerals;
  window.loadThermalData = analyzeThermal;

  window.runEarthAnalysis = async () => {
    if (!selectedPoint) {
      setText(
        'earthPointText',
        'ابتدا روی یک نقطه از نقشه بزنید.'
      );
      return;
    }

    await analyzeMinerals();
    await analyzeThermal();
  };

  /* -------------------- دریافت پروازهای منطقه -------------------- */

  let aircraftButton = $('aircraftRefreshButton');

  if (aircraftButton) {
    const cleanButton = aircraftButton.cloneNode(true);

    aircraftButton.replaceWith(cleanButton);

    aircraftButton = cleanButton;
  }

  function aircraftDistanceKm(
    lat1,
    lon1,
    lat2,
    lon2
  ) {
    const rad = value => value * Math.PI / 180;

    const dLat = rad(lat2 - lat1);
    const dLon = rad(lon2 - lon1);

    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(rad(lat1)) *
      Math.cos(rad(lat2)) *
      Math.sin(dLon / 2) ** 2;

    return 6371 * 2 *
      Math.atan2(
        Math.sqrt(a),
        Math.sqrt(1 - a)
      );
  }

  function aircraftPopup(plane) {
    return `
      <div dir="rtl" style="line-height:2">
        <b>✈️ اطلاعات پرواز</b><br>

        شناسه:
        ${safe(plane.icao)}<br>

        پرواز:
        ${safe(plane.callsign || 'نامشخص')}<br>

        ثبت/نوع:
        ${safe(plane.registration || plane.type || 'نامشخص')}<br>

        ارتفاع:
        ${
          plane.altitudeKm === null
            ? 'نامشخص'
            : plane.altitudeKm.toFixed(2) + ' کیلومتر'
        }<br>

        سرعت:
        ${
          plane.speedKmh === null
            ? 'نامشخص'
            : plane.speedKmh.toFixed(0) + ' کیلومتر بر ساعت'
        }<br>

        جهت:
        ${
          plane.heading === null
            ? 'نامشخص'
            : plane.heading.toFixed(0) + ' درجه'
        }<br>

        فاصله از GPS:
        ${plane.distanceKm.toFixed(1)} کیلومتر
      </div>
    `;
  }

  async function enhancedFetchAircraft() {
    if (window.__aircraftLocalBusy) return;

    const location =
      (typeof userLocation !== 'undefined')
        ? userLocation
        : null;

    if (
      !location ||
      !Number.isFinite(location.lat) ||
      !Number.isFinite(location.lon)
    ) {
      setText(
        'aircraftStatus',
        'ابتدا GPS گوشی را دریافت کنید.'
      );
      return;
    }

    window.__aircraftLocalBusy = true;

    const button = $('aircraftRefreshButton');

    if (button) button.disabled = true;

    setText(
      'aircraftStatus',
      'در حال دریافت پروازهای اطراف GPS...'
    );

    const request = timeoutSignal(18000);

    try {
      const url =
        `https://api.adsb.lol/v2/lat/${encodeURIComponent(location.lat)}` +
        `/lon/${encodeURIComponent(location.lon)}` +
        `/dist/${AIRCRAFT_RADIUS_NM}`;

      const response = await fetch(url, {
        method: 'GET',
        cache: 'no-store',
        headers: {
          Accept: 'application/json'
        },
        signal: request.controller.signal
      });

      if (!response.ok) {
        throw new Error(
          `سرویس پرواز پاسخ HTTP ${response.status} داد.`
        );
      }

      const data = await response.json();

      if (!Array.isArray(data.ac)) {
        throw new Error(
          'ساختار اطلاعات پرواز معتبر نیست.'
        );
      }

      const found = new Map();

      data.ac.forEach(ac => {
        const lat = Number(ac.lat);
        const lon = Number(ac.lon);
        const icao = ac.hex || ac.icao;

        if (
          !icao ||
          !Number.isFinite(lat) ||
          !Number.isFinite(lon)
        ) return;

        if (
          String(ac.alt_baro).toLowerCase() === 'ground'
        ) return;

        const distanceKm = aircraftDistanceKm(
          location.lat,
          location.lon,
          lat,
          lon
        );

        if (
          distanceKm >
          AIRCRAFT_RADIUS_NM * 1.852 + 5
        ) return;

        const altitudeFeet = Number(ac.alt_baro);
        const speedKnots = Number(ac.gs);
        const heading = Number(ac.track);

        found.set(String(icao), {
          icao: String(icao),

          callsign: String(
            ac.flight || ac.callsign || ''
          ).trim(),

          registration: ac.r,
          type: ac.t,

          lat,
          lon,

          altitudeKm:
            Number.isFinite(altitudeFeet)
              ? altitudeFeet * 0.0003048
              : null,

          speedKmh:
            Number.isFinite(speedKnots)
              ? speedKnots * 1.852
              : null,

          heading:
            Number.isFinite(heading)
              ? heading
              : null,

          distanceKm
        });
      });

      if (
        typeof aircraftMarkers !== 'undefined' &&
        typeof aircraftLayer !== 'undefined'
      ) {
        found.forEach(plane => {
          let marker = aircraftMarkers.get(
            plane.icao
          );

          const icon =
            typeof createAircraftIcon === 'function'
              ? createAircraftIcon(plane.heading)
              : L.divIcon({
                  html: '✈️',
                  className: 'aircraft-icon'
                });

          if (!marker) {
            marker = L.marker(
              [plane.lat, plane.lon],
              { icon }
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

            marker.setIcon(icon);
          }

          marker.bindPopup(
            aircraftPopup(plane)
          );
        });

        for (const [icao, marker] of aircraftMarkers) {
          if (!found.has(icao)) {
            aircraftLayer.removeLayer(marker);
            aircraftMarkers.delete(icao);
          }
        }
      }

      setText(
        'aircraftCount',
        `تعداد هواپیماهای اطراف: ${found.size}`
      );

      setText(
        'aircraftStatus',
        `آخرین دریافت: ${
          new Date().toLocaleTimeString('fa-IR')
        } | شعاع ${AIRCRAFT_RADIUS_NM} مایل دریایی`
      );

    } catch (error) {
      console.error(
        'Regional aircraft error:',
        error
      );

      setText(
        'aircraftStatus',
        'خطا در دریافت پروازها: ' +
        (
          error.name === 'AbortError'
            ? 'زمان پاسخ سرویس پرواز تمام شد.'
            : error.message
        )
      );

    } finally {
      request.clear();

      window.__aircraftLocalBusy = false;

      if (button) button.disabled = false;
    }
  }

  window.fetchAircraft = enhancedFetchAircraft;

  if (aircraftButton) {
    aircraftButton.addEventListener(
      'click',
      enhancedFetchAircraft
    );
  }

  console.log(
    '🌍 Earth analysis with pixel quality checks loaded.'
  );

  console.log(
    '✈️ Regional aircraft tracking loaded.'
  );

})();
