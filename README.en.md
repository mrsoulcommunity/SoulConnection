<div align="center">

<img src="docs/assets/banner.svg" alt="Soul Connection" width="100%">

‎[فارسی](README.fa.md) · **English** · [Русский](README.ru.md) · [↩ Language picker](README.md)

[![Release](https://img.shields.io/github/v/release/mrsoulcommunity/SoulConnection?label=version&labelColor=0a0d13&color=1a8a76)](https://github.com/mrsoulcommunity/SoulConnection/releases)
[![Downloads](https://img.shields.io/github/downloads/mrsoulcommunity/SoulConnection/total?labelColor=0a0d13&color=1a8a76)](https://github.com/mrsoulcommunity/SoulConnection/releases)
[![License](https://img.shields.io/badge/license-MIT-1a8a76?labelColor=0a0d13)](LICENSE)
[![Platform](https://img.shields.io/badge/Windows-x64%20%7C%20ia32-5b6377?labelColor=0a0d13)](https://github.com/mrsoulcommunity/SoulConnection/releases/latest)

</div>

---

**Soul Connection is a desktop client for VMess, VLESS, Trojan and Shadowsocks servers.** It wraps
the Xray core behind a clean, fully Persian interface and adds the parts most clients leave to
guesswork: an anti-DPI layer that *measures* which treatment your network needs, per-app routing
rules, health monitoring with automatic failover, and a server finder that reports real speed
through the tunnel rather than a bare ping.

<br>

<div align="center">

[![Download](https://img.shields.io/badge/Download_latest_setup.exe-1a8a76?style=for-the-badge)](https://github.com/mrsoulcommunity/SoulConnection/releases/latest)

</div>

<br>

## Install

Grab the latest `setup.exe` from the [Releases page](https://github.com/mrsoulcommunity/SoulConnection/releases/latest).
One installer covers **both 32-bit (ia32) and 64-bit (x64) Windows** — it detects your system and
installs the matching build. Windows 10 or later is recommended.

> **Note**
>
> The installer is not code-signed, so SmartScreen may warn on first run: choose
> **More info → Run anyway**. Some antivirus products also flag the bundled `xray.exe`. If the app
> reports that `xray.exe` is missing, add the install folder to your antivirus exclusions and
> reinstall.

A **portable** build is also available. It keeps everything in a `data` folder beside the
executable and leaves nothing on the host machine — delete the folder and it's gone.

<br>

## Features

### Connecting

| | |
|---|---|
| **Protocols** | VMess (AEAD, alterId 0), VLESS with Reality and XTLS Vision, Trojan, Shadowsocks including 2022-blake3 ciphers |
| **Transports** | TCP, WebSocket, gRPC, HTTP/2, mKCP — with TLS or Reality |
| **Connection modes** | **System Proxy** writes the Windows proxy settings for you; **Tunnel (TUN)** routes the whole device through Wintun and needs admin rights |
| **Local proxy** | SOCKS and HTTP listeners on `127.0.0.1` with optional username/password. Ports are configurable and automatically bumped to the next free one when taken |
| **Kill switch** | Windows Firewall rules that block all outbound traffic the moment the tunnel drops, so nothing leaks around it |
| **Auto-reconnect** | Detects an unexpected drop and retries with backoff, up to five attempts |

### Adaptive Shield — anti-DPI that measures instead of guessing

Deep packet inspection can't read your payload, so it decides from the *shape* of the first few
packets. The TLS ClientHello is the richest target: it arrives in one predictable write and carries
the SNI in clear text. Xray can already defend against that — `fragment` slices the ClientHello so
no single packet contains a whole one, and `noises` injects unrelated traffic ahead of the
handshake to pollute the classifier's fingerprint.

Every other client exposes those as a switch you're expected to guess at. Soul Connection races
them instead:

- **It measures.** The tuner runs the candidate treatments against your actual server and keeps the
  one that measurably beats a plain connection. "No treatment" is a real contender, not a special
  case — fragmentation costs round trips and noise costs bandwidth, so a network that doesn't need
  them doesn't pay for them.
- **It remembers per network.** A result is only true for one *(server, network)* pair. The
  fragmentation that rescued a censored mobile carrier is pure overhead on office wifi. Each choice
  is stored against a fingerprint of the link it was measured on and silently ignored elsewhere:
  move networks and it re-tunes, move back and the earlier answer is still there.
- **The fingerprint never leaves your machine.** It's a hash of the local subnet and interface MAC,
  only ever compared against itself.

Modes: `auto` (measure per server), `manual` (pin one profile), `off`.

### Smart Routing

Three modes — everything through the proxy, everything direct, or **Smart**, where your own rules
decide. A rule matches on an executable, a domain, or both:

| Rule | Effect |
|---|---|
| `chrome.exe` → Proxy | one app through the tunnel |
| `*.ir` → Direct | a domain and every subdomain stay local |
| `steam.exe` + `*.steamcontent.com` → Direct | app and domain together, beating a broader rule |

Domains are accepted in any form a person would paste — a bare host, a pasted URL, a leading dot,
a trailing port. LAN and localhost stay off the tunnel by default. The same rule set is compiled
into the Xray config *and* evaluated per connection by the dispatcher, so both layers always agree.

### Choosing a server

- **Server Finder** — TCP ping, real latency measured *through* the tunnel, and download/upload
  speed, combined into a single score you can sort by.
- **Soul Connection pool** — a curated server list the app maintains itself, separate from your own
  profiles. Selection is a two-stage funnel: a cheap TCP fan-out across every server, then a real
  tunnel test on the few survivors. It avoids the classic public-pool failure, a host that answers
  on `:443` while its tunnel is dead or throttled.
- **Automatic failover** — health monitoring watches loss, latency and jitter on the live tunnel
  and moves you when it degrades. Three temperaments (`conservative`, `balanced`, `fast`) and four
  independent brakes — consecutive bad samples, a real quality margin, a cooldown, and a ban on
  returning to the server it just left — so it never oscillates between two servers.

### Managing configs

- **Subscriptions** — import by URL, refresh manually or on a timer, with remaining-quota display.
- **Bulk paste** — paste one link or a whole wall of them; every valid config is extracted and
  deduplicated.
- **QR sharing** — render any config as a QR code, then copy or save it.
- **Backup & restore** — export and import all profiles, subscriptions and settings as one JSON file.

### Day to day

- **Live stats** — real-time upload/download speed and per-server lifetime usage, read from Xray's
  gRPC StatsService.
- **Tray integration** — connect, disconnect and switch servers without opening the window.
- **Startup behaviour** — launch on login, start minimised, minimise to tray, restore the previous
  session.
- **Auto-update** — checks GitHub Releases, downloads with live speed and ETA, verifies SHA-512,
  and installs silently after a cancellable countdown. Downloads are resumable and land in an
  `Updates` folder beside the app, so declining the automatic install leaves a ready-to-run setup
  file rather than nothing. Policy is yours: `auto`, `download only`, or `notify`.

<br>

## How it works

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

The renderer never touches Node. It talks to the main process only through the `contextBridge`
preload; `nodeIntegration` is off and the renderer is sandboxed.

Your data is stored as a single JSON file, written crash-safely — a temp file is fsynced, the
current file is snapshotted to `.bak`, then an atomic rename swaps it in. A power loss leaves you
with either the old file or the new one, never half of each. An unreadable file falls back to the
backup, and if that fails too it is quarantined rather than overwritten.

<br>

## Tech stack

| Layer | Technology |
|-------|------------|
| **UI** | React 18 (plain JSX), hand-written CSS, Vazirmatn variable font |
| **Desktop shell** | Electron 33 |
| **Build tool** | Vite 5 |
| **Core engine** | Xray-core (bundled `xray.exe`, per architecture) |
| **Stats** | gRPC (`@grpc/grpc-js`) against Xray's StatsService |
| **Tunnel driver** | Wintun (`wintun.dll`) |
| **Packaging** | electron-builder (NSIS) |

<br>

## Building from source

**Prerequisites** — [Node.js](https://nodejs.org/) 18 or newer, Git, and Windows (the app and its
build targets are Windows-only).

```bash
git clone https://github.com/mrsoulcommunity/SoulConnection.git
cd SoulConnection
npm install
```

`bin/` is not tracked in git. Populate it with the Xray core and the Wintun driver before building:

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

| Command | Description |
|---------|-------------|
| `npm run dev` | Build the UI bundle and launch Electron |
| `npm run start` | Same as `dev` |
| `npm run build:ui` | Build only the Vite renderer bundle into `dist/` |
| `npm run dist` | Build `release/setup.exe` (x64 + ia32 in one installer) |
| `npm run dist:publish` | Same as `dist`, then publish to GitHub Releases (needs `GH_TOKEN`) |
| `npm run dist:portable` | Build a single-file portable x64 executable |

<br>

## Project structure

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

<br>

## Where your data lives

Profiles, subscriptions and settings are one JSON file:

- **Installed build** — `%APPDATA%\soul-connection\profiles.json`
- **Portable build** — `data\profiles.json`, next to the executable

<br>

## Troubleshooting

<details>
<summary><b>The app says <code>xray.exe</code> is missing</b></summary>

An antivirus has quarantined the bundled core. Add the install folder to its exclusions and
reinstall.
</details>

<details>
<summary><b>Tunnel (TUN) mode won't start</b></summary>

TUN mode installs a virtual network interface and needs administrator rights. Run the app as
administrator, and make sure `wintun.dll` shipped alongside `xray.exe`.
</details>

<details>
<summary><b>Connected, but nothing loads</b></summary>

Check that System Proxy is actually applied (Settings → Network), that Smart Routing isn't sending
the traffic direct, and try the Server Finder's real-latency test — a server can accept TCP on
`:443` while its tunnel is dead.
</details>

<details>
<summary><b>Everything is slow on this network</b></summary>

Let Adaptive Shield re-tune. Its results are stored per network, so a fresh wifi or hotspot starts
without one until it measures.
</details>

<details>
<summary><b>Something went wrong and I want the logs</b></summary>

Settings → open the logs folder. Raise `xrayLogLevel` first if you need more detail.
</details>

<br>

## Contributing

1. Fork the repository.
2. Create a feature branch — `git checkout -b feature/amazing-feature`.
3. Commit your changes.
4. Push the branch and open a Pull Request.

Bug reports and feature requests are welcome in [Issues](https://github.com/mrsoulcommunity/SoulConnection/issues).

<br>

## License

MIT — see [LICENSE](LICENSE). Bundled third-party components keep their own licenses: Xray-core
(MPL-2.0) and Wintun, both covered by the notices shipped in `bin/`.

## Disclaimer

This software is intended for legitimate privacy protection and educational use only. The
developers are not responsible for any misuse. Users must comply with the laws and regulations that
apply to them regarding internet usage and proxy services.

<br>

<div align="center">

**Soul Community** — [mrsoulcommunity](https://github.com/mrsoulcommunity)

<sub>Made with ❤️ by the Soul Team</sub>

[GitHub](https://github.com/mrsoulcommunity/SoulConnection) ·
[Issues](https://github.com/mrsoulcommunity/SoulConnection/issues) ·
[Releases](https://github.com/mrsoulcommunity/SoulConnection/releases)

</div>
