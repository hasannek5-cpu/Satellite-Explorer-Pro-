Satellite Explorer aircraft proxy
=================================

این بسته شامل فایل‌های سرور واسط است:
- server.js
- package.json
- render.yaml
- APP_JS_CHANGE.txt

مراحل:
1. فایل‌های server.js و package.json را در ریشه مخزن GitHub قرار بده.
2. render.yaml را نیز در ریشه مخزن قرار بده.
3. تغییر آدرس داخل APP_JS_CHANGE.txt را در تابع fetchAircraft فایل app.js اعمال کن.
4. در Render از New + > Blueprint استفاده کن و همین مخزن را متصل کن.
5. سرویس satellite-explorer-aircraft ساخته می‌شود.
6. پس از استقرار، آدرس https://satellite-explorer-aircraft.onrender.com/ باید JSON شامل ok:true نشان دهد.
7. سپس سایت GitHub Pages را باز کن، GPS را فعال کن و دریافت پروازها را آزمایش کن.

نکته:
- Render Free ممکن است پس از بی‌کاری به خواب برود و اولین درخواست دیر پاسخ دهد.
- سرویس فقط داده‌های عمومی ADS-B را عبور می‌دهد؛ همه هواپیماها الزاماً قابل مشاهده نیستند.
- نام سرویس در render.yaml با آدرس مورد استفاده در app.js هماهنگ است.
