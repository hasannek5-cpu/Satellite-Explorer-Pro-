
/* =========================================================
   SATELLITE EXPLORER PRO — INTEGRATED APP.JS (FIXED)
   Map • GPS • Satellites • TLE • Orbit • Pass prediction
   Radio information • Aircraft • Aircraft trails • Routes
   ========================================================= */
'use strict';

if (!window.L) throw new Error('Leaflet بارگذاری نشده است.');
if (!window.satellite) throw new Error('satellite.js بارگذاری نشده است.');

const $ = id => document.getElementById(id);
if (!$('map')) throw new Error('عنصر #map در HTML پیدا نشد.');

const CONFIG = {
  tleGroups: ['stations','weather','noaa','goes','resource','sarsat','cubesat','education','amateur'],
  tleRefreshMs: 30 * 60 * 1000,
  positionRefreshMs: 5000,
  aircraftApi: window.AIRCRAFT_API || 'https://satellite-explorer-pro.onrender.com/api/aircraft',
  aircraftRefreshMs: 20000,
  aircraftTimeoutMs: 15000,
  aircraftMinRadiusNm: 30,
  aircraftMaxRadiusNm: 250,
  aircraftMinPointDistanceKm: 0.02,
  aircraftRouteApi: 'https://api.adsbdb.com/v0/callsign/',
  aircraftRouteTimeoutMs: 10000,
  maxTrailPoints: 300,
  minTrailDistanceKm: 0.02,
  orbitMinutes: 180,
  passHours: 120,
  passStepMs: 30000,
  gpsTimeoutMs: 60000,
  gpsMaximumAgeMs: 10000
};

const map = window.map = L.map('map', {
  zoomControl: true, preferCanvas: true, worldCopyJump: true
}).setView([32, 53], 4);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap contributors', maxZoom: 19
}).addTo(map);

const satelliteLayer = L.layerGroup().addTo(map);
const orbitLayer = L.layerGroup().addTo(map);
const aircraftLayer = L.layerGroup().addTo(map);
const satelliteMarkers = new Map();
const aircraftMarkers = new Map();
const aircraftTrails = new Map();
const aircraftRouteCache = new Map();
const aircraftRouteLayers = new Map();
const latestAircraft = new Map();

let satellites = [];
let selectedSatellite = null;
let userPosition = null;
let userMarker = null;
let userAccuracyCircle = null;
let selectedAircraftId = null;
let selectedAircraftPath = null;
let aircraftBusy = false;
let passBusy = false;
let gpsBusy = false;
let gpsWatchId = null;

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  })[c]);
}

function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = value;
}

function showMessage(message) {
  const el = $('details');
  if (el) el.textContent = message;
  console.log(message);
}

function distanceKm(lat1,lon1,lat2,lon2) {
  const r=Math.PI/180, dLat=(lat2-lat1)*r, dLon=(lon2-lon1)*r;
  const a=Math.sin(dLat/2)**2+Math.cos(lat1*r)*Math.cos(lat2*r)*Math.sin(dLon/2)**2;
  return 6371*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}

function showTab(name) {
  ['map','info','gps','earth'].forEach(tab=>{
    const el=$(tab+'Tab');
    if(el) el.hidden=tab!==name;
  });
  if(name==='map') setTimeout(()=>map.invalidateSize(),200);
}
window.showTab=showTab;

// ==================== TLE ====================

function parseTLE(text,group) {
  const lines=text.split(/\r?\n/).map(x=>x.trim()).filter(Boolean),out=[];
  for(let i=0;i<lines.length-2;i++){
    if(lines[i+1].startsWith('1 ')&&lines[i+2].startsWith('2 ')){
      const name=lines[i].replace(/^0\s+/,''),line1=lines[i+1],line2=lines[i+2];
      try{
        const satrec=satellite.twoline2satrec(line1,line2);
        if(!satrec.error)out.push({
          id:line1.substring(2,7).trim(),
          name,group,line1,line2,satrec,
          lat:null,lon:null,altitude:null
        });
      }catch(e){
        console.warn('TLE parse:',name,e);
      }
      i+=2;
    }
  }
  return out;
}

async function fetchTLEGroup(group){
  const url=`https://celestrak.org/NORAD/elements/gp.php?GROUP=${encodeURIComponent(group)}&FORMAT=tle`;
  const response=await fetch(url,{cache:'no-store'});
  if(!response.ok) throw new Error(`CelesTrak HTTP ${response.status}`);
  return parseTLE(await response.text(),group);
}

async function loadSatellites(){
  showMessage('در حال دریافت اطلاعات ماهواره‌ها...');
  const results=await Promise.allSettled(CONFIG.tleGroups.map(fetchTLEGroup)),unique=new Map();
  let goodGroups=0;

  results.forEach(r=>{
    if(r.status!=='fulfilled'){
      console.warn('TLE group failed:',r.reason);
      return;
    }
    goodGroups++;
    r.value.forEach(s=>{
      if(!unique.has(s.id)) unique.set(s.id,s);
    });
  });

  if(!unique.size){
    showMessage('دریافت TLE ناموفق بود. نقشه همچنان فعال است؛ اتصال یا CORS را بررسی کنید.');
    return;
  }

  satellites=[...unique.values()];

  if(selectedSatellite&&!satellites.some(s=>s.id===selectedSatellite.id)){
    selectedSatellite=null;
    orbitLayer.clearLayers();
  }

  updateSatellitePositions();
  renderSatelliteList();
  showMessage(`${satellites.length} ماهواره از ${goodGroups} گروه دریافت شد.`);
}

function satellitePosition(sat,date=new Date()){
  try{
    const pv=satellite.propagate(sat.satrec,date);
    if(!pv||!pv.position||!Number.isFinite(pv.position.x)) return null;

    const geo=satellite.eciToGeodetic(pv.position,satellite.gstime(date));
    const lat=satellite.degreesLat(geo.latitude);
    const lon=satellite.degreesLong(geo.longitude);

    if(![lat,lon,geo.height].every(Number.isFinite)) return null;

    return {lat,lon,altitude:geo.height,eci:pv.position};
  }catch(e){
    console.warn('Propagation error:',sat.name,e);
    return null;
  }
}

function satelliteIcon(){
  return L.divIcon({
    className:'satellite-marker',
    html:'<span style="font-size:23px;filter:drop-shadow(0 0 4px #00d9ff)">🛰️</span>',
    iconSize:[28,28],
    iconAnchor:[14,14]
  });
}

function updateSatellitePositions(){
  const active=new Set(),now=new Date();

  satellites.forEach(sat=>{
    const p=satellitePosition(sat,now);
    if(!p) return;

    Object.assign(sat,p);
    active.add(sat.id);

    let marker=satelliteMarkers.get(sat.id);

    if(!marker){
      marker=L.marker([p.lat,p.lon],{icon:satelliteIcon()}).addTo(satelliteLayer);
      marker.on('click',()=>showSatelliteInfo(sat.id));
      satelliteMarkers.set(sat.id,marker);
    }else{
      marker.setLatLng([p.lat,p.lon]);
    }

    marker.bindPopup(`<div dir="rtl"><b>${escapeHTML(sat.name)}</b><br>NORAD: ${sat.id}<br>ارتفاع: ${p.altitude.toFixed(1)} کیلومتر</div>`);
  });

  satelliteMarkers.forEach((marker,id)=>{
    if(!active.has(id)){
      satelliteLayer.removeLayer(marker);
      satelliteMarkers.delete(id);
    }
  });

  if(selectedSatellite) updateSelectedSatellite();
}

function renderSatelliteList(){
  const list=$('satelliteList');
  if(!list) return;

  const fragment=document.createDocumentFragment();

  satellites.forEach(sat=>{
    const button=document.createElement('button');
    button.type='button';
    button.textContent=`${sat.name} | NORAD ${sat.id}`;
    button.style.cssText='display:block;width:100%;padding:10px;margin:4px 0;text-align:right';
    button.addEventListener('click',()=>showSatelliteInfo(sat.id));
    fragment.appendChild(button);
  });

  list.replaceChildren(fragment);
}

function showSatelliteInfo(id){
  const sat=satellites.find(s=>s.id===String(id));
  if(!sat) return;

  selectedSatellite=sat;
  drawSatelliteOrbit(sat);
  updateSelectedSatellite();
  showTab('info');
}
window.showSatelliteInfo=showSatelliteInfo;

function updateSelectedSatellite(){
  if(!selectedSatellite) return;

  const sat=selectedSatellite,p=satellitePosition(sat);
  if(!p) return;

  Object.assign(sat,p);

  const details=$('details');
  if(details) details.innerHTML=`<div dir="rtl"><h3>🛰️ ${escapeHTML(sat.name)}</h3>
    <p>NORAD: ${escapeHTML(sat.id)}</p><p>گروه: ${escapeHTML(sat.group)}</p>
    <p>عرض جغرافیایی: ${p.lat.toFixed(5)}°</p><p>طول جغرافیایی: ${p.lon.toFixed(5)}°</p>
    <p>ارتفاع: ${p.altitude.toFixed(2)} کیلومتر</p>
    <button type="button" onclick="predictSatellitePass()">پیش‌بینی عبور ۱۲۰ ساعته</button>
    <button type="button" onclick="showSatelliteCommunication()">اطلاعات رادیویی</button></div>`;

  renderSatelliteCommunication();
}

function drawSatelliteOrbit(sat){
  orbitLayer.clearLayers();
  let segment=[],segments=[];
  const start=Date.now();

  for(let t=0;t<=CONFIG.orbitMinutes*60000;t+=120000){
    const p=satellitePosition(sat,new Date(start+t));
    if(!p) continue;

    if(segment.length&&Math.abs(p.lon-segment[segment.length-1][1])>180){
      if(segment.length>1) segments.push(segment);
      segment=[];
    }

    segment.push([p.lat,p.lon]);
  }

  if(segment.length>1) segments.push(segment);

  segments.forEach(points=>{
    L.polyline(points,{
      color:'#ffcc00',
      weight:3,
      opacity:.9,
      dashArray:'8,7'
    }).addTo(orbitLayer);
  });
}

// ==================== GPS FIX ====================

function gpsErrorMessage(error){
  if(!error) return 'خطای نامشخص GPS';

  const messages={
    1:'اجازه دسترسی به موقعیت رد شد. مجوز Location مرورگر را فعال کنید.',
    2:'موقعیت GPS در دسترس نیست؛ GPS/Location گوشی و اینترنت را بررسی کنید.',
    3:'مهلت دریافت GPS تمام شد. به فضای باز بروید و دوباره تلاش کنید.'
  };

  return messages[error.code]||`خطای GPS (کد ${error.code})`;
}

function applyGPSPosition(position){
  const c=position.coords;
  const lat=Number(c.latitude);
  const lon=Number(c.longitude);
  const accuracy=Number(c.accuracy);

  if(!Number.isFinite(lat)||!Number.isFinite(lon)){
    showMessage('مختصات GPS نامعتبر دریافت شد.');
    return;
  }

  userPosition={
    lat,lon,
    altitude:Number.isFinite(c.altitude)?c.altitude:0,
    accuracy:Number.isFinite(accuracy)?accuracy:0
  };

  const ll=[lat,lon];

  if(userMarker){
    userMarker.setLatLng(ll);
  }else{
    userMarker=L.marker(ll).addTo(map).bindPopup('📍 موقعیت فعلی شما');
  }

  if(userAccuracyCircle){
    userAccuracyCircle.setLatLng(ll);
    userAccuracyCircle.setRadius(userPosition.accuracy||0);
  }else{
    userAccuracyCircle=L.circle(ll,{
      radius:userPosition.accuracy||0,
      color:'#168cff',
      fillColor:'#168cff',
      fillOpacity:.08
    }).addTo(map);
  }

  map.setView(ll,12);
  showTab('map');

  const output=$('location');
  if(output){
    output.textContent=`عرض: ${lat.toFixed(5)} | طول: ${lon.toFixed(5)} | دقت: ${Math.round(userPosition.accuracy)} متر`;
  }

  const coords=$('selectedCoordinates');
  if(coords) coords.textContent=`${lat.toFixed(6)}, ${lon.toFixed(6)}`;

  setText('gpsStatus',`GPS فعال | دقت ${Math.round(userPosition.accuracy)} متر`);
  showMessage(`موقعیت GPS دریافت شد: ${lat.toFixed(5)}, ${lon.toFixed(5)}`);

  console.log('GPS position:',userPosition);
  fetchAircraft();
}

function getLocation(){
  if(gpsBusy){
    showMessage('درخواست GPS قبلی هنوز در حال انجام است...');
    return;
  }

  if(!navigator.geolocation){
    showMessage('GPS در این مرورگر پشتیبانی نمی‌شود. از HTTPS و مرورگر معتبر استفاده کنید.');
    return;
  }

  gpsBusy=true;
  setText('gpsStatus','در حال دریافت موقعیت GPS...');
  showMessage('در حال دریافت موقعیت GPS؛ لطفاً اجازه دسترسی را تأیید کنید...');

  navigator.geolocation.getCurrentPosition(
    position=>{
      gpsBusy=false;
      applyGPSPosition(position);
    },
    error=>{
      gpsBusy=false;
      const message=gpsErrorMessage(error);
      setText('gpsStatus',message);
      showMessage(message);
      console.warn('GPS error:',error.code,error.message);
    },
    {
      enableHighAccuracy:true,
      timeout:CONFIG.gpsTimeoutMs,
      maximumAge:CONFIG.gpsMaximumAgeMs
    }
  );
}
window.getLocation=getLocation;

function startGPSWatch(){
  if(!navigator.geolocation){
    showMessage('GPS در این مرورگر پشتیبانی نمی‌شود.');
    return;
  }

  if(gpsWatchId!==null) return;

  setText('gpsStatus','ردیابی GPS زنده فعال شد...');

  gpsWatchId=navigator.geolocation.watchPosition(
    applyGPSPosition,
    error=>{
      const message=gpsErrorMessage(error);
      setText('gpsStatus',message);
      console.warn('GPS watch error:',error);
    },
    {
      enableHighAccuracy:true,
      timeout:CONFIG.gpsTimeoutMs,
      maximumAge:5000
    }
  );
}

function stopGPSWatch(){
  if(gpsWatchId!==null&&navigator.geolocation){
    navigator.geolocation.clearWatch(gpsWatchId);
    gpsWatchId=null;
    setText('gpsStatus','ردیابی GPS متوقف شد.');
  }
}

window.startGPSWatch=startGPSWatch;
window.stopGPSWatch=stopGPSWatch;

// ==================== LOOK ANGLES / PASS ====================

function calculateLook(sat,timestamp){
  if(!userPosition) return null;

  const date=new Date(timestamp);
  const pv=satellite.propagate(sat.satrec,date);

  if(!pv||!pv.position||!Number.isFinite(pv.position.x)) return null;

  const observer={
    longitude:userPosition.lon*Math.PI/180,
    latitude:userPosition.lat*Math.PI/180,
    height:(userPosition.altitude||0)/1000
  };

  const ecf=satellite.eciToEcf(pv.position,satellite.gstime(date));
  const look=satellite.ecfToLookAngles(observer,ecf);

  return {
    elevation:look.elevation*180/Math.PI,
    azimuth:(look.azimuth*180/Math.PI+360)%360,
    range:look.rangeSat
  };
}

function refinePassBoundary(sat,left,right,wasVisible){
  let low=left,high=right;

  for(let i=0;i<18;i++){
    const mid=(low+high)/2;
    const look=calculateLook(sat,mid);
    if(!look) break;

    if((look.elevation>=0)===wasVisible) low=mid;
    else high=mid;
  }

  return new Date((low+high)/2);
}

function getPassPanel(){
  let panel=$('passDetails');

  if(!panel){
    panel=document.createElement('section');
    panel.id='passDetails';
    panel.dir='rtl';
    panel.style.cssText='padding:14px;margin:12px 0;border:1px solid #00bcd4;border-radius:12px;line-height:2';
    ($('infoTab')||document.body).appendChild(panel);
  }

  return panel;
}

function predictSatellitePass(){
  const panel=getPassPanel();

  if(!selectedSatellite){
    panel.textContent='ابتدا یک ماهواره انتخاب کنید.';
    return;
  }

  if(!userPosition){
    panel.textContent='ابتدا موقعیت GPS را دریافت کنید.';
    return;
  }

  if(passBusy) return;

  passBusy=true;
  panel.textContent='در حال محاسبه عبورهای ۱۲۰ ساعت آینده...';

  setTimeout(()=>{
    try{
      const sat=selectedSatellite;
      const start=Date.now();
      const end=start+CONFIG.passHours*3600000;
      const step=CONFIG.passStepMs;
      const passes=[];

      let previousTime=start;
      let previous=calculateLook(sat,start);
      let active=null;

      if(previous&&previous.elevation>=0){
        active={
          start:new Date(start),
          peak:previous.elevation,
          peakTime:new Date(start),
          azimuth:previous.azimuth,
          range:previous.range,
          end:null
        };
      }

      for(let t=start+step;t<=end;t+=step){
        const current=calculateLook(sat,t);

        if(!current){
          previousTime=t;
          previous=null;
          continue;
        }

        const visible=current.elevation>=0;
        const wasVisible=!!previous&&previous.elevation>=0;

        if(visible&&!wasVisible&&!active){
          active={
            start:previous?refinePassBoundary(sat,previousTime,t,false):new Date(t),
            peak:current.elevation,
            peakTime:new Date(t),
            azimuth:current.azimuth,
            range:current.range,
            end:null
          };
        }

        if(visible&&active){
          if(current.elevation>active.peak){
            active.peak=current.elevation;
            active.peakTime=new Date(t);
            active.azimuth=current.azimuth;
          }
          active.range=Math.min(active.range,current.range);
        }

        if(!visible&&wasVisible&&active){
          active.end=refinePassBoundary(sat,previousTime,t,true);
          passes.push(active);
          active=null;
        }

        previousTime=t;
        previous=current;
      }

      if(active) passes.push(active);

      const fmt=d=>new Date(d).toLocaleString('fa-IR');

      if(!passes.length){
        panel.innerHTML='<h3>نتیجه پیش‌بینی</h3><p>در ۱۲۰ ساعت آینده عبور قابل مشاهده‌ای پیدا نشد.</p>';
      }else{
        panel.innerHTML=`<h3>🛰️ پیش‌بینی عبور ${escapeHTML(sat.name)}</h3><p>تعداد عبورها: ${passes.length}</p>`+
          passes.map((p,i)=>`<article style="padding:10px;margin:10px 0;background:#183652;color:white;border-radius:9px"><b>عبور ${i+1}</b>
          <p>شروع: ${fmt(p.start)}</p><p>اوج ارتفاع: ${p.peak.toFixed(2)} درجه</p><p>زمان اوج: ${fmt(p.peakTime)}</p>
          <p>سمت: ${p.azimuth.toFixed(1)} درجه</p><p>کمترین فاصله: ${p.range.toFixed(1)} کیلومتر</p>
          <p>پایان: ${p.end?fmt(p.end):'پس از پایان بازه بررسی'}</p></article>`).join('')+
          '<p style="font-size:12px">پیش‌بینی بر اساس TLE است و ممکن است با مشاهده واقعی اختلاف داشته باشد.</p>';
      }

    }catch(e){
      console.error('Pass prediction:',e);
      panel.textContent='خطا در پیش‌بینی: '+e.message;
    }finally{
      passBusy=false;
    }
  },50);
}
window.predictSatellitePass=predictSatellitePass;

// ==================== RADIO ====================

const RADIO_DATABASE={
  '25544':{
    title:'ISS (ZARYA)',
    source:'https://www.amsat.org/amateur-radio-on-the-iss/',
    modes:[
      {
        name:'APRS / Packet',
        uplink:'145.825 MHz',
        downlink:'145.825 MHz',
        protocol:'AFSK / AX.25'
      },
      {
        name:'FM voice repeater',
        uplink:'145.990 MHz',
        downlink:'437.800 MHz',
        protocol:'FM'
      }
    ]
  }
};

function renderSatelliteCommunication(){
  const details=$('details');
  if(!details||!selectedSatellite) return;

  const old=$('radioPanel');
  if(old) old.remove();

  const panel=document.createElement('section');
  panel.id='radioPanel';
  panel.dir='rtl';
  panel.style.cssText='padding:14px;margin-top:15px;border:1px solid #00bcd4;border-radius:12px;line-height:2';

  const data=RADIO_DATABASE[selectedSatellite.id];

  if(!data){
    panel.textContent='اطلاعات فرکانسی تأییدشده برای این ماهواره در پایگاه فعلی موجود نیست.';
  }else{
    panel.innerHTML=`<h3>📡 اطلاعات رادیویی ${escapeHTML(data.title)}</h3>`+
      data.modes.map(m=>`<div><b>${escapeHTML(m.name)}</b><p>ارسال: ${escapeHTML(m.uplink)}</p><p>دریافت: ${escapeHTML(m.downlink)}</p><p>پروتکل: ${escapeHTML(m.protocol)}</p></div>`).join('')+
      `<a href="${data.source}" target="_blank" rel="noopener">منبع اطلاعات</a>`;
  }

  const note=document.createElement('p');
  note.textContent='اطلاعات فرکانسی به معنی تضمین فعال بودن سرویس نیست؛ مقررات و مجوزهای رادیویی را رعایت کنید.';
  panel.appendChild(note);
  details.appendChild(panel);
}

function showSatelliteCommunication(){
  renderSatelliteCommunication();
}
window.showSatelliteCommunication=showSatelliteCommunication;

// ==================== AIRCRAFT ====================

function aircraftCenter(){
  const c=map.getCenter();
  return {lat:c.lat,lon:c.lng};
}

function aircraftRadiusNm(){
  const b=map.getBounds(),c=map.getCenter();
  const corners=[b.getNorthWest(),b.getNorthEast(),b.getSouthWest(),b.getSouthEast()];
  let max=0;

  corners.forEach(p=>{
    max=Math.max(max,distanceKm(c.lat,c.lng,p.lat,p.lng));
  });

  return Math.max(
    CONFIG.aircraftMinRadiusNm,
    Math.min(CONFIG.aircraftMaxRadiusNm,Math.ceil(max/1.852))
  );
}

function setAircraftStatus(message){
  setText('aircraftStatus',message);
}

function aircraftIcon(heading){
  const h=Number.isFinite(heading)?heading:0;

  return L.divIcon({
    className:'aircraft-marker',
    html:`<div style="font-size:25px;transform:rotate(${h}deg);filter:drop-shadow(0 1px 3px #000)">✈️</div>`,
    iconSize:[32,32],
    iconAnchor:[16,16]
  });
}

function normalizeAircraft(raw){
  const lat=Number(raw.lat),lon=Number(raw.lon);

  if(!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>90||Math.abs(lon)>180) return null;

  const icao=String(raw.hex||raw.icao||raw.id||'').trim().toLowerCase();
  if(!icao) return null;

  const altRaw=raw.alt_baro;
  const altitude=altRaw==='ground'?0:
    (Number.isFinite(Number(altRaw))?Number(altRaw)*0.3048:
    (Number.isFinite(Number(raw.altitude))?Number(raw.altitude):null));

  return {
    icao,
    lat,
    lon,
    callsign:String(raw.flight||raw.callsign||'').trim(),
    registration:String(raw.r||raw.registration||'').trim(),
    aircraftType:String(raw.t||raw.type||'').trim(),
    heading:Number.isFinite(Number(raw.track))?Number(raw.track):Number(raw.heading)||0,
    altitude,
    speedKmh:Number.isFinite(Number(raw.gs))?Number(raw.gs)*1.852:
      (Number.isFinite(Number(raw.speed))?Number(raw.speed):null),
    verticalRate:Number.isFinite(Number(raw.baro_rate))?Number(raw.baro_rate)*0.00508:null,
    squawk:String(raw.squawk||'').trim(),
    emergency:String(raw.emergency||'').trim(),
    seenPosition:Number(raw.seen_pos??raw.seen)||0,
    onGround:altRaw==='ground'||raw.on_ground===true,
    raw
  };
}

function aircraftPopup(p){
  const altitude=Number.isFinite(p.altitude)?
    `${Math.round(p.altitude).toLocaleString('fa-IR')} متر`:'نامشخص';

  const speed=Number.isFinite(p.speedKmh)?
    `${Math.round(p.speedKmh).toLocaleString('fa-IR')} کیلومتر بر ساعت`:'نامشخص';

  const vertical=Number.isFinite(p.verticalRate)?
    `${p.verticalRate.toFixed(1)} متر بر ثانیه`:'نامشخص';

  return `<div dir="rtl" style="line-height:1.9;min-width:210px"><b>✈️ ${escapeHTML(p.callsign||'شماره پرواز نامشخص')}</b>
    <p>شناسه ICAO: ${escapeHTML(p.icao)}</p><p>رجیستر: ${escapeHTML(p.registration||'نامشخص')}</p>
    <p>شرکت/مدل: ${escapeHTML(p.aircraftType||'نامشخص')}</p><p>ارتفاع: ${altitude}</p><p>سرعت زمینی: ${speed}</p>
    <p>جهت حرکت: ${p.heading.toFixed(1)}°</p><p>نرخ صعود/نزول: ${vertical}</p><p>کد ترانسپوندر: ${escapeHTML(p.squawk||'نامشخص')}</p>
    <p>آخرین موقعیت: ${Math.round(p.seenPosition)} ثانیه قبل</p>
    <button type="button" onclick="selectAircraft('${escapeHTML(p.icao)}')">نمایش اطلاعات مسیر و مبدأ/مقصد</button></div>`;
}

function routeAirportLabel(airport){
  if(!airport) return 'نامشخص';

  return [
    airport.name,
    airport.iata_code||airport.icao_code,
    airport.municipality,
    airport.country_name
  ].filter(Boolean).join(' — ')||'نامشخص';
}

async function fetchAircraftRoute(plane){
  if(!plane.callsign) return null;

  const key=plane.callsign.replace(/\s+/g,'').toUpperCase();
  if(aircraftRouteCache.has(key)) return aircraftRouteCache.get(key);

  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),CONFIG.aircraftRouteTimeoutMs);

  try{
    const response=await fetch(
      CONFIG.aircraftRouteApi+encodeURIComponent(key),
      {cache:'no-store',signal:controller.signal}
    );

    if(!response.ok) throw new Error(`Route HTTP ${response.status}`);

    const body=await response.json();
    const root=body.response||body;
    const route=root.flightroute||root.route||null;

    if(!route) throw new Error('اطلاعات مسیر برای این شماره پرواز ثبت نشده است.');

    const result={
      callsign:route.callsign||key,
      airline:route.airline||null,
      origin:route.origin||null,
      midpoint:route.midpoint||null,
      destination:route.destination||null
    };

    aircraftRouteCache.set(key,result);
    return result;

  }catch(error){
    console.warn('Aircraft route lookup:',key,error);
    return {error:error.message};
  }finally{
    clearTimeout(timer);
  }
}

function drawAircraftRoute(id,route){
  const old=aircraftRouteLayers.get(id);

  if(old){
    aircraftLayer.removeLayer(old);
    aircraftRouteLayers.delete(id);
  }

  if(!route||route.error) return;

  const airports=[route.origin,route.midpoint,route.destination].filter(a=>
    a&&Number.isFinite(Number(a.latitude))&&Number.isFinite(Number(a.longitude))
  );

  if(airports.length<2) return;

  const points=airports.map(a=>[
    Number(a.latitude),
    Number(a.longitude)
  ]);

  const group=L.layerGroup();

  L.polyline(points,{
    color:'#00e5ff',
    weight:3,
    opacity:.9,
    dashArray:'9,7'
  }).addTo(group);

  airports.forEach((airport,index)=>{
    const label=index===0?'مبدأ':
      (index===airports.length-1?'مقصد':'توقف');

    L.circleMarker(
      [Number(airport.latitude),Number(airport.longitude)],
      {
        radius:7,
        color:'#fff',
        weight:2,
        fillColor:index===0?'#16a34a':
          (index===airports.length-1?'#ef4444':'#f59e0b'),
        fillOpacity:1
      }
    ).bindPopup(
      `<div dir="rtl"><b>${label}</b><br>${escapeHTML(routeAirportLabel(airport))}</div>`
    ).addTo(group);
  });

  group.addTo(aircraftLayer);
  aircraftRouteLayers.set(id,group);
}

function showAircraftRouteDetails(plane,route){
  const marker=aircraftMarkers.get(plane.icao);
  if(!marker) return;

  const airline=route?.airline;
  const origin=route?.origin;
  const destination=route?.destination;
  const midpoint=route?.midpoint;

  const routeText=route?.error?
    `<p>مبدأ و مقصد: ${escapeHTML(route.error)}</p>`:
    `<p><b>شرکت هواپیمایی:</b> ${escapeHTML(airline?.name||'نامشخص')}</p>
    <p><b>مبدأ:</b> ${escapeHTML(routeAirportLabel(origin))}</p>
    ${midpoint?`<p><b>توقف میانی:</b> ${escapeHTML(routeAirportLabel(midpoint))}</p>`:''}
    <p><b>مقصد:</b> ${escapeHTML(routeAirportLabel(destination))}</p>
    <p style="font-size:11px">خط فیروزه‌ای مسیر برنامه‌ریزی‌شده بین فرودگاه‌هاست، نه مسیر دقیق ثبت‌شده هواپیما.</p>`;

  marker.bindPopup(
    aircraftPopup(plane).replace('</div>',`${routeText}</div>`)
  ).openPopup();
}

function recordAircraftPosition(plane){
  const id=plane.icao;
  let points=aircraftTrails.get(id)||[];
  const next=[plane.lat,plane.lon];
  const last=points[points.length-1];

  if(last&&distanceKm(last[0],last[1],next[0],next[1])<CONFIG.aircraftMinPointDistanceKm) return;

  points.push(next);

  if(points.length>CONFIG.maxTrailPoints) points.shift();

  aircraftTrails.set(id,points);

  if(selectedAircraftId===id&&selectedAircraftPath){
    selectedAircraftPath.setLatLngs(points);
    selectedAircraftPath.bringToFront();
  }
}

function renderAircraft(planes){
  const active=new Set();

  planes.forEach(p=>{
    active.add(p.icao);
    latestAircraft.set(p.icao,p);
    recordAircraftPosition(p);

    let marker=aircraftMarkers.get(p.icao);

    if(!marker){
      marker=L.marker([p.lat,p.lon],{
        icon:aircraftIcon(p.heading)
      }).addTo(aircraftLayer);

      marker.on('click',()=>selectAircraft(p.icao));
      aircraftMarkers.set(p.icao,marker);
    }else{
      marker.setLatLng([p.lat,p.lon]);
      marker.setIcon(aircraftIcon(p.heading));
    }

    marker.bindPopup(aircraftPopup(p));
  });

  aircraftMarkers.forEach((marker,id)=>{
    if(!active.has(id)){
      aircraftLayer.removeLayer(marker);
      aircraftMarkers.delete(id);
    }
  });

  setText('aircraftCount',`تعداد هواپیماهای قابل مشاهده: ${planes.length}`);
}

async function selectAircraft(id){
  const key=String(id);
  const marker=aircraftMarkers.get(key);

  if(!marker) return;

  selectedAircraftId=key;

  if(selectedAircraftPath) aircraftLayer.removeLayer(selectedAircraftPath);

  selectedAircraftPath=L.polyline(
    aircraftTrails.get(key)||[],
    {color:'#ff9800',weight:3,opacity:.95}
  ).addTo(aircraftLayer);

  marker.setZIndexOffset(1000);

  const plane=latestAircraft.get(key);

  if(!plane){
    marker.openPopup();
    return;
  }

  marker.bindPopup(
    aircraftPopup(plane).replace(
      '</div>',
      '<p>در حال دریافت مبدأ و مقصد...</p></div>'
    )
  ).openPopup();

  const route=await fetchAircraftRoute(plane);

  if(selectedAircraftId!==key) return;

  drawAircraftRoute(key,route);
  showAircraftRouteDetails(plane,route);
}
window.selectAircraft=selectAircraft;

function clearAircraftSelection(){
  selectedAircraftId=null;

  if(selectedAircraftPath){
    aircraftLayer.removeLayer(selectedAircraftPath);
    selectedAircraftPath=null;
  }

  aircraftRouteLayers.forEach(layer=>aircraftLayer.removeLayer(layer));
  aircraftRouteLayers.clear();
}
window.clearAircraftSelection=clearAircraftSelection;

async function fetchAircraft(){
  if(aircraftBusy) return;

  aircraftBusy=true;
  setAircraftStatus('در حال دریافت اطلاعات پروازها...');

  const center=aircraftCenter();
  const radius=aircraftRadiusNm();
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),CONFIG.aircraftTimeoutMs);

  try{
    const api=CONFIG.aircraftApi;
    const url=new URL(api,window.location.href);

    if(api.includes('/v2/lat')){
      url.pathname=`/v2/lat/${center.lat}/lon/${center.lon}/dist/${Math.round(radius*1852)}`;
    }else{
      url.searchParams.set('lat',center.lat);
      url.searchParams.set('lon',center.lon);
      url.searchParams.set('dist',Math.round(radius*1.852));
      url.searchParams.set('radiusKm',Math.round(radius*1.852));
    }

    const response=await fetch(
      url.toString(),
      {signal:controller.signal,cache:'no-store'}
    );

    if(!response.ok) throw new Error(`HTTP ${response.status}`);

    const data=await response.json();

    const raw=Array.isArray(data.ac)?data.ac:
      (Array.isArray(data.aircraft)?data.aircraft:
      (Array.isArray(data)?data:[]));

    const planes=raw.map(normalizeAircraft)
      .filter(Boolean)
      .filter(p=>!p.onGround&&p.seenPosition<120);

    renderAircraft(planes);

    setAircraftStatus(
      `به‌روزرسانی موفق | ${new Date().toLocaleTimeString('fa-IR')}`
    );

  }catch(error){
    console.warn('Aircraft API error:',error);

    setAircraftStatus(
      error.name==='AbortError'?
      'مهلت دریافت اطلاعات تمام شد':
      `دریافت هواپیما ناموفق: ${error.message}`
    );

  }finally{
    clearTimeout(timeout);
    aircraftBusy=false;
  }
}
window.fetchAircraft=fetchAircraft;

// ==================== AIRCRAFT MAP CONTROLS ====================

const aircraftControl=L.control({position:'topright'});

aircraftControl.onAdd=function(){
  const box=L.DomUtil.create('div','aircraft-control');
  box.dir='rtl';

  box.style.cssText='background:#10243a;color:white;padding:10px;border:1px solid #00bcd4;border-radius:10px;min-width:165px;line-height:1.8;font-size:12px;box-shadow:0 2px 8px #0006';

  box.innerHTML=`<b>✈️ پروازهای زنده</b>
    <div id="aircraftStatus">آماده دریافت</div>
    <div id="aircraftCount">تعداد هواپیما: ۰</div>
    <button id="aircraftRefresh" type="button" style="width:100%;padding:7px;margin-top:6px">بروزرسانی</button>
    <button id="aircraftClear" type="button" style="width:100%;padding:7px;margin-top:5px">پاک کردن مسیر</button>`;

  L.DomEvent.disableClickPropagation(box);
  L.DomEvent.disableScrollPropagation(box);

  L.DomEvent.on(
    box.querySelector('#aircraftRefresh'),
    'click',
    fetchAircraft
  );

  L.DomEvent.on(
    box.querySelector('#aircraftClear'),
    'click',
    clearAircraftSelection
  );

  return box;
};

aircraftControl.addTo(map);

// ==================== TIMERS AND STARTUP ====================

map.on('moveend zoomend',()=>{
  clearTimeout(window._aircraftMoveTimer);
  window._aircraftMoveTimer=setTimeout(fetchAircraft,1200);
});

function startApp(){
  map.invalidateSize();
  loadSatellites();
  fetchAircraft();

  setInterval(updateSatellitePositions,CONFIG.positionRefreshMs);
  setInterval(loadSatellites,CONFIG.tleRefreshMs);
  setInterval(fetchAircraft,CONFIG.aircraftRefreshMs);
}

window.addEventListener('load',()=>setTimeout(startApp,250));

// ==================== PUBLIC HTML API ====================

window.loadSatellites=loadSatellites;
window.updateSatellitePositions=updateSatellitePositions;
window.drawSatelliteOrbit=drawSatelliteOrbit;
window.calculateLook=calculateLook;

console.log('🛰️ Satellite Explorer Pro app.js initialized (GPS fixed).');
