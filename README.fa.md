<div align="center">

<img src="docs/assets/banner.svg" alt="Soul Connection" width="100%">

**فارسی** · [English](README.en.md) · [Русский](README.ru.md) · [↩ انتخاب زبان](README.md)

[![Release](https://img.shields.io/github/v/release/mrsoulcommunity/SoulConnection?label=version&labelColor=0a0d13&color=1a8a76)](https://github.com/mrsoulcommunity/SoulConnection/releases)
[![Downloads](https://img.shields.io/github/downloads/mrsoulcommunity/SoulConnection/total?labelColor=0a0d13&color=1a8a76)](https://github.com/mrsoulcommunity/SoulConnection/releases)
[![License](https://img.shields.io/badge/license-MIT-1a8a76?labelColor=0a0d13)](LICENSE)
[![Platform](https://img.shields.io/badge/Windows-x64%20%7C%20ia32-5b6377?labelColor=0a0d13)](https://github.com/mrsoulcommunity/SoulConnection/releases/latest)

</div>

---

<div dir="rtl" align="right">

**سول کانکشن یک کلاینت دسکتاپ برای سرورهای VMess، VLESS، Trojan و Shadowsocks است.** هستهٔ Xray را
پشت یک رابط کاربری تمیز و کاملاً فارسی می‌گذارد و چیزهایی را اضافه می‌کند که بیشتر کلاینت‌ها به حدس
کاربر واگذار می‌کنند: لایه‌ای ضدِ DPI که *اندازه می‌گیرد* شبکهٔ شما به چه درمانی نیاز دارد، قواعد
مسیریابی برای هر برنامه، پایش سلامت اتصال با جابه‌جایی خودکار، و یابنده‌ای که سرعت واقعیِ داخل تونل
را گزارش می‌کند نه یک پینگ خالی را.

</div>

<br>

<div align="center">

[![Download](https://img.shields.io/badge/Download_setup.exe-1a8a76?style=for-the-badge)](https://github.com/mrsoulcommunity/SoulConnection/releases/latest)

**دریافت آخرین نسخه برای ویندوز**

</div>

<br>

<div dir="rtl" align="right">

## نصب

آخرین فایل `setup.exe` را از [صفحهٔ Releases](https://github.com/mrsoulcommunity/SoulConnection/releases/latest)
بگیرید. یک نصب‌کننده هم **ویندوز ۳۲ بیتی (ia32)** و هم **۶۴ بیتی (x64)** را پوشش می‌دهد؛ خودش سیستم
شما را تشخیص می‌دهد و نسخهٔ درست را نصب می‌کند. ویندوز ۱۰ به بالا توصیه می‌شود.

> **نکته**
>
> نصب‌کننده امضای دیجیتال (code signing) ندارد، پس ممکن است SmartScreen در اجرای اول هشدار بدهد؛
> روی **More info** و سپس **Run anyway** بزنید. بعضی آنتی‌ویروس‌ها هم به `xray.exe` همراه برنامه گیر
> می‌دهند. اگر برنامه گفت `xray.exe` پیدا نشد، پوشهٔ نصب را به فهرست استثناهای آنتی‌ویروس اضافه کنید
> و دوباره نصب کنید.

نسخهٔ **پرتابل** هم موجود است: همه‌چیز را در پوشهٔ `data` کنار فایل اجرایی نگه می‌دارد و هیچ ردی روی
سیستم باقی نمی‌گذارد — پوشه را پاک کنید، انگار هرگز نبوده.

<br>

## امکانات

### اتصال

| | |
|---|---|
| **پروتکل‌ها** | VMess (با AEAD و alterId صفر)، VLESS همراه Reality و XTLS Vision، Trojan، و Shadowsocks شامل رمزهای <span dir="ltr">2022-blake3</span> |
| **انتقال‌ها** | TCP، WebSocket، gRPC، HTTP/2، mKCP — با TLS یا Reality |
| **حالت‌های اتصال** | **پراکسی سیستم** تنظیمات پراکسی ویندوز را برایتان می‌نویسد؛ **تونل (TUN)** کل دستگاه را از طریق Wintun عبور می‌دهد و به دسترسی مدیر نیاز دارد |
| **پراکسی محلی** | شنونده‌های SOCKS و HTTP روی `127.0.0.1` با نام کاربری و رمز اختیاری. پورت‌ها قابل تنظیم‌اند و اگر اشغال باشند خودکار به اولین پورت آزاد منتقل می‌شوند |
| **کلید قطع** | قواعد فایروال ویندوز (Kill Switch) که لحظهٔ افتادن تونل تمام ترافیک خروجی را می‌بندند تا چیزی از کنار تونل بیرون نزند |
| **اتصال مجدد خودکار** | افتادن ناگهانی تونل را تشخیص می‌دهد و تا پنج بار با فاصلهٔ فزاینده دوباره تلاش می‌کند |

### سپر تطبیقی — ضدِ DPI، با اندازه‌گیری به‌جای حدس

بازرسی عمیق بسته (DPI) نمی‌تواند محتوای شما را بخواند، پس از روی *شکلِ* چند بستهٔ اول تصمیم می‌گیرد.
پیام ClientHello در TLS چرب‌ترین هدف است: در یک نوشتِ قابل‌پیش‌بینی می‌رسد و SNI را بدون رمز حمل
می‌کند. Xray از قبل ابزار مقابله را دارد — `fragment` این پیام را چنان تکه‌تکه می‌کند که هیچ بسته‌ای
یک ClientHello کامل نداشته باشد، و `noises` پیش از دست‌دادن اولیه ترافیک بی‌ربط تزریق می‌کند تا اثر
انگشت آماری‌ای که دسته‌بند جمع کرده به‌هم بریزد.

هر کلاینت دیگری این‌ها را به شکل کلیدی عرضه می‌کند که قرار است خودتان حدس بزنید کدام را بزنید. سول
کانکشن به‌جای حدس، آن‌ها را با هم مسابقه می‌دهد:

- **اندازه می‌گیرد.** تیونر گزینه‌ها را روی سرور واقعی شما اجرا می‌کند و همانی را نگه می‌دارد که
  به‌طور قابل‌اندازه‌گیری از اتصال ساده بهتر باشد. «بدون تغییر» هم یک رقیب واقعی است نه استثنا —
  تکه‌تکه‌کردن هزینهٔ رفت‌وبرگشت دارد و نویز پهنای باند می‌خورد، پس شبکه‌ای که به آن‌ها نیاز ندارد
  بهایشان را هم نمی‌پردازد.
- **به‌ازای هر شبکه به‌خاطر می‌سپارد.** یک نتیجه فقط برای یک زوجِ *(سرور، شبکه)* درست است.
  تکه‌تکه‌کردنی که روی یک اپراتور موبایل فیلترشده اتصال را نجات داده، روی وای‌فای دفتر فقط سربار
  است. هر انتخاب کنار اثر انگشت شبکه‌ای ذخیره می‌شود که رویش اندازه‌گیری شده و جای دیگر بی‌سروصدا
  نادیده گرفته می‌شود: شبکه عوض شود دوباره تنظیم می‌کند، برگردید پاسخ قبلی سر جایش است.
- **این اثر انگشت هرگز از دستگاه شما بیرون نمی‌رود.** درهم‌سازی‌ای از زیرشبکهٔ محلی و مکآدرس کارت
  شبکه است که فقط با خودش مقایسه می‌شود.

حالت‌ها: `خودکار` (اندازه‌گیری برای هر سرور)، `دستی` (یک نمایه برای همه)، `خاموش`.

### مسیریابی هوشمند

سه حالت — همه‌چیز از پراکسی، همه‌چیز مستقیم، یا **هوشمند** که قواعد خودتان تصمیم می‌گیرند. هر قاعده
می‌تواند بر اساس یک برنامهٔ اجرایی، یک دامنه، یا هر دو باشد:

| قاعده | نتیجه |
|---|---|
| `chrome.exe` ← پراکسی | فقط یک برنامه از تونل رد می‌شود |
| `*.ir` ← مستقیم | یک دامنه و همهٔ زیردامنه‌هایش محلی می‌مانند |
| `steam.exe` + `*.steamcontent.com` ← مستقیم | برنامه و دامنه با هم، که بر قاعدهٔ کلی‌تر غلبه می‌کند |

دامنه را به هر شکلی که آدم می‌چسباند می‌پذیرد: نام خالی، یک URL کامل، نقطهٔ ابتدایی، یا پورت
انتهایی. شبکهٔ محلی و localhost به‌صورت پیش‌فرض از تونل رد نمی‌شوند. همین مجموعه قواعد هم به تنظیمات
Xray ترجمه می‌شود و هم به‌ازای هر اتصال توسط توزیع‌کننده ارزیابی می‌شود، تا این دو لایه هیچ‌وقت با
هم اختلاف پیدا نکنند.

### انتخاب سرور

- **یابندهٔ سرور** — پینگ TCP، تأخیر واقعی که *از داخل* تونل اندازه‌گیری می‌شود، و سرعت دانلود و
  آپلود؛ همه در یک امتیاز واحد جمع می‌شوند که می‌توانید بر اساسش مرتب کنید.
- **استخر سرورهای سول کانکشن** — فهرستی گزیده که خودِ برنامه نگه‌داری می‌کند و از پروفایل‌های شما
  جداست. انتخاب دو مرحله‌ای است: اول یک آزمون TCP ارزان روی همهٔ سرورها، بعد آزمون تونل واقعی روی
  چند بازمانده. همین جلوی خطای کلاسیک استخرهای عمومی را می‌گیرد: میزبانی که روی `:443` جواب می‌دهد
  ولی تونلش مرده یا خفه شده است.
- **جابه‌جایی خودکار** — پایش سلامت، اتلاف بسته و تأخیر و لرزش را روی تونل زنده می‌بیند و وقتی افت
  کند شما را جابه‌جا می‌کند. سه خُلق‌وخو (`محافظه‌کار`، `متعادل`، `سریع`) و چهار ترمز مستقل — چند
  نمونهٔ بد پشت سر هم، یک اختلاف کیفیت واقعی، یک دورهٔ خنک‌شدن، و ممنوعیت بازگشت به سروری که تازه
  ترکش کرده — تا هرگز بین دو سرور نوسان نکند.

### مدیریت کانفیگ‌ها

- **اشتراک‌ها** — افزودن با URL، به‌روزرسانی دستی یا زمان‌بندی‌شده، همراه نمایش حجم باقی‌مانده.
- **چسباندن انبوه** — یک لینک یا یک دیوار لینک را یک‌جا بچسبانید؛ هر کانفیگ معتبری استخراج و تکراری‌ها
  حذف می‌شوند.
- **اشتراک‌گذاری QR** — هر کانفیگ را به‌صورت کد QR ببینید و کپی یا ذخیره کنید.
- **پشتیبان‌گیری و بازیابی** — همهٔ پروفایل‌ها، اشتراک‌ها و تنظیمات در قالب یک فایل JSON.

### در استفادهٔ روزمره

- **آمار زنده** — سرعت لحظه‌ای دانلود و آپلود و مصرف کل هر سرور، از سرویس gRPC StatsService خودِ Xray.
- **سینی سیستم** — اتصال، قطع و تعویض سرور بدون بازکردن پنجره.
- **رفتار هنگام راه‌اندازی** — اجرا با ورود به ویندوز، شروع به‌صورت کوچک‌شده، کوچک‌شدن در سینی،
  بازیابی نشست قبلی.
- **به‌روزرسانی خودکار** — Releases گیت‌هاب را بررسی می‌کند، با نمایش سرعت و زمان باقی‌مانده دانلود
  می‌کند، SHA-512 را بررسی می‌کند و پس از یک شمارش معکوسِ قابل‌لغو بی‌صدا نصب می‌کند. دانلود
  ازسرگرفتنی است و در پوشهٔ `Updates` کنار برنامه می‌نشیند، پس اگر نصب خودکار را رد کنید یک فایل
  نصب آمادهٔ اجرا برایتان می‌ماند، نه هیچ. سیاستش هم با شماست: `خودکار`، `فقط دانلود`، یا `فقط اطلاع`.

<br>

## معماری

</div>

```text
┌──────────────────────────────────────────────────────────────────────────┐
│  Renderer — React 18                                        sandboxed    │
│  ServerList · ConnectHero · Finder · Shield · Routing · Settings         │
└────────────────────────────────┬─────────────────────────────────────────┘
                                 │  contextBridge (electron/preload.cjs)
                                 │  nodeIntegration off, no remote module
┌────────────────────────────────┴─────────────────────────────────────────┐
│  Main process — electron/main.cjs                                        │
│                                                                          │
│    store.cjs        xrayConfig.cjs    routing/        shield/            │
│    atomic JSON      config builder    rule matcher    anti-DPI tuner     │
│                                                                          │
│    health/          soulPool.cjs      update/         killSwitch.cjs     │
│    failover         curated pool      SHA-512 OTA     firewall rules     │
└────────────────────────────────┬─────────────────────────────────────────┘
                                 │  spawn + gRPC StatsService
┌────────────────────────────────┴─────────────────────────────────────────┐
│  xray.exe          SOCKS 127.0.0.1:xxxxx   ·   HTTP 127.0.0.1:xxxxx      │
└────────────────────────────────┬─────────────────────────────────────────┘
                     ┌───────────┴────────────┐
               System Proxy               Tunnel (TUN)
               Windows registry           wintun.dll
```

<div dir="rtl" align="right">

رابط کاربری هیچ‌وقت به Node دست نمی‌زند. فقط از طریق پیش‌بارگذارِ `contextBridge` با پروسهٔ اصلی
حرف می‌زند؛ `nodeIntegration` خاموش است و رندرر در جعبهٔ شنی (sandbox) اجرا می‌شود.

داده‌های شما در یک فایل JSON نگه‌داری می‌شود، آن هم با نوشتنی مقاوم در برابر خرابی: اول یک فایل موقت
نوشته و fsync می‌شود، بعد فایل فعلی به `.bak` کپی می‌شود، و آخر یک rename اتمیک جایشان را عوض می‌کند.
قطع برق یا کرش یا فایل قدیمی سالم را برایتان می‌گذارد یا فایل جدید را — هیچ‌وقت نیمی از هرکدام. فایل
ناخوانا از روی نسخهٔ پشتیبان بازیابی می‌شود، و اگر آن هم خراب باشد به‌جای بازنویسی قرنطینه می‌شود.

<br>

## پشتهٔ فناوری

| لایه | فناوری |
|-------|------------|
| **رابط کاربری** | React 18 (JSX ساده)، CSS دست‌نویس، فونت متغیر وزیرمتن |
| **پوستهٔ دسکتاپ** | Electron 33 |
| **ابزار ساخت** | Vite 5 |
| **هستهٔ اصلی** | Xray-core (فایل `xray.exe` همراه برنامه، برای هر معماری) |
| **آمار** | gRPC (`@grpc/grpc-js`) روی StatsService خودِ Xray |
| **درایور تونل** | Wintun (`wintun.dll`) |
| **بسته‌بندی** | electron-builder (NSIS) |

<br>

## ساخت از روی کد

**پیش‌نیازها** — [Node.js](https://nodejs.org/) نسخهٔ ۱۸ یا بالاتر، Git، و ویندوز (خودِ برنامه و
هدف‌های ساختش فقط ویندوزی هستند).

</div>

```bash
git clone https://github.com/mrsoulcommunity/SoulConnection.git
cd SoulConnection
npm install
```

<div dir="rtl" align="right">

پوشهٔ `bin/` در گیت ردیابی نمی‌شود. پیش از ساخت، هستهٔ Xray و درایور Wintun را در آن بگذارید:

</div>

```text
bin/
├── geoip.dat
├── geosite.dat
├── win-x64/
│   ├── xray.exe        # 64-bit Xray core
│   └── wintun.dll      # 64-bit Wintun driver
└── win-ia32/
    ├── xray.exe        # 32-bit Xray core
    └── wintun.dll      # 32-bit Wintun driver
```

<div dir="rtl" align="right">

| دستور | توضیح |
|---------|-------------|
| `npm run dev` | ساخت باندل رابط کاربری و اجرای Electron |
| `npm run start` | مثل `dev` |
| `npm run build:ui` | فقط ساخت باندل Vite در `dist/` |
| `npm run dist` | ساخت `release/setup.exe` (هر دو معماری در یک نصب‌کننده) |
| `npm run dist:publish` | مثل `dist`، بعد انتشار روی GitHub Releases (نیازمند `GH_TOKEN`) |
| `npm run dist:portable` | ساخت نسخهٔ پرتابل تک‌فایلی ۶۴ بیتی |

<br>

## ساختار پروژه

</div>

```text
SoulConnection/
├── electron/
│   ├── main.cjs              # Main process: IPC, tray, connection lifecycle
│   ├── preload.cjs           # contextBridge API exposed to the renderer
│   └── lib/
│       ├── shield/           # Adaptive Shield: profiles, tuner, per-network memory
│       ├── routing/          # Smart Routing: rules, matcher, dispatcher, compiler
│       ├── health/           # Health monitoring, scoring, automatic failover
│       ├── update/           # Feed, resumable download, SHA-512 verify, installer
│       ├── xrayProcess.cjs   # Xray lifecycle
│       ├── xrayConfig.cjs    # Config builder
│       ├── killSwitch.cjs    # Windows Firewall rules
│       ├── systemProxy.cjs   # Windows proxy settings
│       ├── tunNetwork.cjs    # TUN interface setup
│       ├── soulPool.cjs      # Curated server pool
│       └── store.cjs         # Crash-safe JSON store
├── src/
│   ├── App.jsx               # Root component
│   ├── components/           # Server list, settings, finder, shield, modals
│   ├── finder/               # Server-test orchestration
│   └── utils/                # Formatting, geo lookup, scoring
├── bin/                      # Xray core + Wintun (not tracked; see above)
├── scripts/build-exe.cjs     # Packaging pipeline
├── vite.config.js
└── package.json              # Also holds the electron-builder config
```

<div dir="rtl" align="right">

<br>

## داده‌های شما کجاست

پروفایل‌ها، اشتراک‌ها و تنظیمات همه در یک فایل JSON هستند:

- **نسخهٔ نصبی** — <code dir="ltr">%APPDATA%\soul-connection\profiles.json</code>
- **نسخهٔ پرتابل** — <code dir="ltr">data\profiles.json</code>، کنار فایل اجرایی

<br>

## عیب‌یابی

<details>
<summary><b>برنامه می‌گوید <code>xray.exe</code> پیدا نشد</b></summary>

آنتی‌ویروس هستهٔ همراه برنامه را قرنطینه کرده است. پوشهٔ نصب را به استثناهایش اضافه کنید و دوباره
نصب کنید.
</details>

<details>
<summary><b>حالت تونل (TUN) بالا نمی‌آید</b></summary>

این حالت یک کارت شبکهٔ مجازی نصب می‌کند و به دسترسی مدیر نیاز دارد. برنامه را با Run as
administrator اجرا کنید و مطمئن شوید `wintun.dll` کنار `xray.exe` قرار دارد.
</details>

<details>
<summary><b>وصل شده‌ام ولی هیچ سایتی باز نمی‌شود</b></summary>

ببینید پراکسی سیستم واقعاً اعمال شده باشد (تنظیمات ← شبکه)، مطمئن شوید مسیریابی هوشمند ترافیک را
مستقیم نمی‌فرستد، و آزمون تأخیر واقعیِ یابندهٔ سرور را بگیرید — یک سرور می‌تواند روی `:443` جواب
بدهد در حالی که تونلش مرده باشد.
</details>

<details>
<summary><b>روی این شبکه همه‌چیز کند است</b></summary>

بگذارید سپر تطبیقی دوباره تنظیم کند. نتیجه‌هایش به‌ازای هر شبکه ذخیره می‌شوند، پس یک وای‌فای یا
هات‌اسپات تازه تا وقتی اندازه‌گیری نکرده هیچ نتیجه‌ای ندارد.
</details>

<details>
<summary><b>مشکلی پیش آمده و لاگ می‌خواهم</b></summary>

از تنظیمات، پوشهٔ لاگ‌ها را باز کنید. اگر جزئیات بیشتری لازم دارید اول `xrayLogLevel` را بالا ببرید.
</details>

<br>

## مشارکت

1. مخزن را fork کنید.
2. یک شاخهٔ ویژگی بسازید — `git checkout -b feature/amazing-feature`.
3. تغییرهایتان را commit کنید.
4. شاخه را push کنید و یک Pull Request باز کنید.

گزارش اشکال و پیشنهاد ویژگی در [Issues](https://github.com/mrsoulcommunity/SoulConnection/issues) خوش‌آمد است.

<br>

## پروانه

‏MIT — فایل [LICENSE](LICENSE) را ببینید. اجزای شخص ثالثِ همراه برنامه پروانهٔ خودشان را دارند:
Xray-core با MPL-2.0 و Wintun، که هر دو در `bin/` با متن پروانه‌شان عرضه می‌شوند.

## سلب مسئولیت

این نرم‌افزار فقط برای حفاظت مشروع از حریم خصوصی و استفادهٔ آموزشی در نظر گرفته شده است. توسعه‌دهندگان
مسئول هیچ‌گونه سوءاستفاده‌ای نیستند. کاربران باید قوانین و مقرراتی را که در مورد استفاده از اینترنت و
سرویس‌های پراکسی بر آن‌ها اعمال می‌شود رعایت کنند.

</div>

<br>

<div align="center">

**Soul Community** — [mrsoulcommunity](https://github.com/mrsoulcommunity)

<sub>ساخته شده با ❤️ توسط تیم سول</sub>

[GitHub](https://github.com/mrsoulcommunity/SoulConnection) ·
[Issues](https://github.com/mrsoulcommunity/SoulConnection/issues) ·
[Releases](https://github.com/mrsoulcommunity/SoulConnection/releases)

</div>
