'use strict';
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, Notification, dialog, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');

// Windows/Electron quirk: when launched from a UAC elevation prompt (portable
// build run as administrator, or the app's own relaunchElevated() for tunnel
// mode), Chromium can start up with a stale/unscaled DPI reading from before
// the secure-desktop transition finishes settling -- the window then renders
// at the wrong scale, with every row's layout box sized for 100% while the
// actual text/glyphs paint at the real (125%/150%/etc.) scale, so everything
// overlaps. Must be set before app is ready.
app.commandLine.appendSwitch('high-dpi-support', '1');

const { parseLink, parseMany, newId, parseSubscriptionUserinfo, buildCustomProfile } = require('./lib/parsers.cjs');

// ---- The VPN ----
//
// Everything about being connected -- the xray process, Smart Routing's
// dispatcher, the tunnel adapter and its routes, the Windows proxy
// configuration, the Kill Switch, the measurement loops, health and failover --
// lives behind this one object. main.cjs supplies what only it can know (where
// the binaries are, what the settings say, how to reach the window) and is
// otherwise a consumer of it like any other. See electron/vpn/index.cjs.
const { createVpnCore } = require('./vpn/index.cjs');
const { Activity } = require('./vpn/machine.cjs');
const { DEFAULT_SOCKS_PORT, DEFAULT_HTTP_PORT } = require('./vpn/ports.cjs');
const { measurePing } = require('./lib/pingTest.cjs');
const serverTest = require('./lib/serverTest.cjs');
const { fetchText } = require('./lib/fetchText.cjs');
const { JsonStore } = require('./lib/store.cjs');
const { isElevated, relaunchElevated } = require('./lib/elevation.cjs');
const { UpdateManager, MODES: UPDATE_MODES } = require('./lib/update/index.cjs');
const { ShieldManager, MODES: SHIELD_MODES } = require('./lib/shield/index.cjs');
const { isKnown: isShieldKey } = require('./lib/shield/profiles.cjs');
const { SoulPool } = require('./lib/soulPool.cjs');
const routingRulesLib = require('./lib/routing/rules.cjs');
const { AppList } = require('./lib/routing/appList.cjs');
const { FAILOVER_MODES } = require('./lib/health/failover.cjs');
const { tcpOnlyScore } = require('./lib/health/score.cjs');

// The preferred local ports. Whether a session actually lands on them is up to
// vpn/ports.cjs, which bumps past anything already taken.
const SOCKS_PORT = DEFAULT_SOCKS_PORT;
const HTTP_PORT = DEFAULT_HTTP_PORT;

const DEFAULT_SETTINGS = {
  launchOnStartup: false,
  runLocalProxyOnStartup: false, // replaces the old autoConnect (migrated in getSettings())
  startMinimized: false,
  restorePreviousSession: false, // renderer-owned UI state; main just persists/exposes it
  minimizeToTray: true,
  autoReconnect: true,
  // How hard auto-reconnect tries before giving up, and the step it backs off
  // by (attempt N waits N x this). Exposed because the right answer depends on
  // the link: a phone hotspot that drops for ten seconds at a time needs more
  // patience than a desk connection where five fast tries is already generous.
  reconnectAttempts: 5,
  reconnectDelayMs: 2000,
  killSwitchEnabled: false,
  subAutoUpdateInterval: 0, // ms; 0 = off

  // ---- Appearance ----
  // Turns off the ambient, always-running motion (the stage auroras, the ring's
  // breathing halo, the shimmer and skeleton loops) and shortens the rest to a
  // near-instant crossfade. Purely a renderer concern -- main only persists it
  // -- but it belongs here because it has to survive a restart like every other
  // preference. Windows' own "show animations" setting is honoured separately
  // and independently, through prefers-reduced-motion in the stylesheet.
  reduceMotion: false,

  // ---- Notifications ----
  // `notifications` is the master switch; the rest silence one category each,
  // so "tell me when a server switches under me, but stop announcing every
  // connect" is expressible. Failures the user has to act on (Kill Switch
  // could not be applied, the system proxy was refused) are not categorised --
  // they follow the master switch only.
  notifications: true,
  notifyConnection: true,
  notifyFailover: true,
  notifyUpdates: true,
  // App update policy. 'auto' downloads a new release and installs it after a
  // visible, cancellable countdown; 'download' parks the installer in the
  // Updates folder and waits; 'notify' does nothing until asked. See
  // lib/update/index.cjs.
  autoUpdateMode: 'auto',
  // Adaptive Shield. 'auto' measures which anti-DPI treatment this network
  // needs and applies it per server; 'manual' pins one for everything; 'off'
  // disables it. See lib/shield/.
  shieldMode: 'auto',
  xrayLogLevel: 'warning',
  socksPort: SOCKS_PORT, // preferred; auto-bumped to the next free port if taken
  httpPort: HTTP_PORT,
  socksHost: '127.0.0.1',
  socksUsername: '',
  socksPassword: '',
  httpHost: '127.0.0.1',
  httpUsername: '',
  httpPassword: '',
  customBypass: '', // extra semicolon-separated hosts/patterns added to the system-proxy bypass list

  // ---- Tunnel mode ----
  // The resolvers Windows hands to apps while the tunnel adapter is up, and
  // the ones xray re-issues those queries to over DoH. Both halves read this
  // one setting, so they cannot disagree. Empty falls back to the defaults in
  // lib/xrayConfig.cjs.
  tunDns: '1.1.1.1, 8.8.8.8',

  // ---- Smart Routing ----
  // 'proxy' keeps the historical behaviour (everything through the tunnel),
  // so an existing install is unaffected until the user opts in.
  routingMode: 'proxy', // 'proxy' | 'direct' | 'smart'
  lanDirect: true,      // localhost / private networks never go through the tunnel

  // ---- Smart server selection & failover ----
  autoSelectBestServer: false,
  failoverEnabled: true,
  failoverMode: 'balanced', // 'conservative' | 'balanced' | 'fast'
  backupMonitoring: true,
};

// True portable mode: electron-builder's portable Windows target sets
// PORTABLE_EXECUTABLE_DIR (the folder containing the actual .exe, as opposed
// to the temp dir it's extracted/run from) so the app can keep all of its
// data next to the exe instead of scattering it into the user's AppData --
// carry the exe + its "data" folder anywhere and it's fully self-contained,
// with no trace left on a machine after you delete that folder. Falls back
// to the normal per-user AppData path for the NSIS-installed build and for
// local development (where this env var is never set).
if (process.env.PORTABLE_EXECUTABLE_DIR) {
  app.setPath('userData', path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'data'));
}

const userDataDir = app.getPath('userData');
fs.mkdirSync(userDataDir, { recursive: true });
const store = new JsonStore(path.join(userDataDir, 'profiles.json'), {
  profiles: [],
  subscriptions: [],
  activeProfileId: null,
  settings: { ...DEFAULT_SETTINGS },
  // Persisted USER INTENT for system proxy -- "route my system through the
  // tunnel". Deliberately not "is it on right now": that is read back from the
  // Windows registry by SystemProxyController, which is the only thing allowed
  // to answer it. Intent survives disconnect and restart; application does not.
  systemProxyDesired: false,
  systemProxySaved: null,      // the user's own proxy config, parked while ours is active
  systemProxyKnownPorts: [],   // ports we have written, so leftovers stay recognisable
});

// Migration: `systemProxyEnabled` used to be a single boolean conflating intent
// with live state. Carry it over as intent once, then drop it.
if ('systemProxyEnabled' in store.data) {
  if (store.get('systemProxyEnabled', false) && !store.get('systemProxyDesired', false)) {
    store.set('systemProxyDesired', true);
  }
  delete store.data.systemProxyEnabled;
  store.set('systemProxyDesired', store.get('systemProxyDesired', false));
}

// Packaged, extraResources flattens the per-arch binary and the shared .dat
// files into one resources/bin. In the repo they're split: xray.exe lives in
// bin/win-x64 (or win-ia32) while geoip.dat/geosite.dat stay in bin/ -- so the
// binary and the assets need resolving separately.
function resolveXrayPaths() {
  if (app.isPackaged) {
    const dir = path.join(process.resourcesPath, 'bin');
    return { bin: path.join(dir, 'xray.exe'), assets: dir };
  }
  const binRoot = path.join(__dirname, '..', 'bin');
  const flat = path.join(binRoot, 'xray.exe');
  if (fs.existsSync(flat)) return { bin: flat, assets: binRoot };
  const archDir = path.join(binRoot, process.arch === 'ia32' ? 'win-ia32' : 'win-x64');
  return { bin: path.join(archDir, 'xray.exe'), assets: binRoot };
}

const { bin: xrayBin, assets: xrayAssetDir } = resolveXrayPaths();
const xrayWorkDir = path.join(userDataDir, 'xray-run');

// Same work root the manual server tests use -- startTestTunnel() already
// carves a throwaway per-test subdirectory out of it.
const soulPool = new SoulPool({ store, xrayBin, xrayAssetDir, workRoot: xrayWorkDir });

let mainWindow = null;
let tray = null;
let isQuitting = false;
let subAutoUpdateTimer = null;

// Enumerating running programs for the rule picker. This is not the same thing
// as the dispatcher's process lookup (which answers "who owns this connection"
// thousands of times per session, and lives inside the VPN core): this one
// answers "what is running" when a dialog opens.
const appList = new AppList();

// ---- Smart Routing ----
//
// The rule list lives under its own store key rather than inside `settings`:
// it is a growing collection the user edits item by item, not a flat set of
// preferences, and settings:update's whitelist/type validation has nothing
// useful to say about it.
//
// `routingCache` is the compiled, validated policy the dispatcher consults on
// every single connection. Re-sanitizing the raw list per connection would put
// avoidable work on the hot path, so it is rebuilt only when something changes.
let routingCache = null;

function getRoutingRules() {
  return routingRulesLib.sanitizeRules(store.get('routingRules', []));
}

function routingPolicy() {
  if (!routingCache) {
    const s = getSettings();
    routingCache = {
      mode: routingRulesLib.MODES.has(s.routingMode) ? s.routingMode : 'proxy',
      lanDirect: s.lanDirect !== false,
      rules: getRoutingRules(),
    };
  }
  return routingCache;
}

function invalidateRoutingCache() {
  routingCache = null;
}

// Who the failover engine is allowed to move to. A pool server falls back to
// other pool servers; a user config prefers its own subscription group (same
// provider, same credentials, most likely to actually work) and widens to the
// whole list only when that group is too small to be useful.
const MAX_FAILOVER_CANDIDATES = 40;
function failoverCandidates(limit = MAX_FAILOVER_CANDIDATES) {
  const activeId = store.get('activeProfileId');
  if (!activeId) return [];
  if (soulPool.find(activeId)) {
    return soulPool.list().filter((p) => p.id !== activeId).slice(0, limit);
  }
  const active = store.get('profiles', []).find((p) => p.id === activeId);
  if (!active) return [];
  const profiles = store.get('profiles', []).filter((p) => p.id !== activeId);
  const group = active.subId ? profiles.filter((p) => p.subId === active.subId) : [];
  return (group.length >= 2 ? group : profiles).slice(0, limit);
}

function sendToWindow(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

// ---- The VPN core ----
//
// Constructed once, here, with the things it cannot work out for itself: where
// the binaries live, what the user's settings and routing policy say, how to
// resolve a profile id, and how to reach the user (window, notifications).
// Every connection state transition in the app goes through it.
const vpn = createVpnCore({
  store,
  xrayBin,
  xrayAssetDir,
  workDir: xrayWorkDir,
  getSettings: () => getSettings(),
  findProfile: (id) => findProfile(id),
  getRoutingPolicy: () => routingPolicy(),
  getShieldKey: (profile) => shieldManager.keyFor(profile),
  getFailoverCandidates: (limit) => failoverCandidates(limit),
  // In pool mode the server was chosen because it was the best one *at the
  // time*. If it just died, retrying it is the one thing guaranteed not to
  // work -- re-run the selection and land on whatever is healthy now.
  selectOnReconnect: async ({ profileId, signal }) => {
    if (!store.get('soulModeEnabled', false) || !soulPool.find(profileId)) return profileId;
    const { profile, metrics } = await soulPool.selectBest({ signal, emit: sendSoulProgress });
    // The sweep row is settled here rather than after the connect: the core
    // owns the reconnect from this point and the connection state itself is
    // what the UI shows next, so anything else would leave the row spinning if
    // that connect went on to fail.
    sendSoulProgress({ phase: 'done', server: profile.name, ...metrics });
    return profile.id;
  },
  notify: (title, body, category) => notify(title, body, category),
  emit: (channel, payload) => sendToWindow(channel, payload),
  log: (msg) => { if (process.env.SC_DEBUG) console.log(msg); },
});

// One subscription, one job: whenever anything about the VPN moves, the window
// and the tray are told. Nothing else is driven from here -- the pollers, the
// health monitor and the system proxy all follow the session inside the core,
// which is what stopped a routine status broadcast from resetting them.
vpn.on('changed', () => sendState());

const briefProfile = (p) => (p ? { id: p.id, name: p.name, address: p.address } : null);

function getSettings() {
  const raw = store.get('settings', {});
  // One-time migration: the old autoConnect toggle became runLocalProxyOnStartup
  // (same trigger -- connect to the last active profile at launch -- but no
  // longer auto-enables system proxy as a side effect). Idempotent: once
  // migrated, 'runLocalProxyOnStartup' in raw is true and this is a no-op.
  if ('autoConnect' in raw && !('runLocalProxyOnStartup' in raw)) {
    raw.runLocalProxyOnStartup = raw.autoConnect;
    delete raw.autoConnect;
    store.set('settings', raw);
  }
  return { ...DEFAULT_SETTINGS, ...raw };
}

function updateSettings(patch) {
  const merged = { ...getSettings(), ...patch };
  store.set('settings', merged);
  return merged;
}

// Categories a notification can belong to, and the setting that silences each.
// Anything uncategorised is a failure the user has to act on, and follows the
// master switch alone -- silencing "tell me when I connect" must not also
// silence "the Kill Switch could not be applied".
const NOTIFY_CATEGORIES = {
  connection: 'notifyConnection',
  failover: 'notifyFailover',
  update: 'notifyUpdates',
};

function notify(title, body, category = null) {
  const s = getSettings();
  if (!s.notifications) return;
  const gate = NOTIFY_CATEGORIES[category];
  if (gate && s[gate] === false) return;
  try {
    if (Notification.isSupported()) {
      new Notification({ title, body, icon: APP_ICON_PATH }).show();
    }
  } catch { /* ignore */ }
}

// The active profile only when it came from the pool -- user profiles are
// already in the renderer's own list and don't need shipping over IPC.
function soulActiveProfile() {
  const p = soulPool.find(store.get('activeProfileId'));
  return p ? { id: p.id, name: p.name, address: p.address, port: p.port, protocol: p.protocol } : null;
}

function sendState() {
  sendToWindow('state-changed', {
    // Connection state, connectedAt, the registry-verified system proxy status
    // and the Kill Switch all come from the core in one consistent snapshot,
    // never assembled from separate places that could disagree.
    ...vpn.snapshot(),
    activeProfileId: store.get('activeProfileId', null),
    soulModeEnabled: store.get('soulModeEnabled', false),
    // The pool server we landed on, so the UI can name it without holding a
    // copy of the whole pool.
    activeSoulProfile: soulActiveProfile(),
    routingMode: getSettings().routingMode,
  });
  updateTray();
}

function updateTray() {
  if (!tray) return;
  const profile = findProfile(store.get('activeProfileId'));
  const label = vpn.state === 'connected' ? `وصل — ${profile ? profile.name : ''}`
    : vpn.state === 'connecting' ? 'در حال اتصال…'
    : vpn.state === 'disconnecting' ? 'در حال قطع…'
    : 'قطع — Soul Connection';
  tray.setToolTip(label.trim());
  tray.setContextMenu(buildTrayMenu());
}

const TRAY_SERVER_LIST_LIMIT = 12;

function buildTrayMenu() {
  const connected = vpn.isConnected;
  const busy = vpn.state === 'connecting' || vpn.state === 'disconnecting';
  const activeId = store.get('activeProfileId');
  const profile = findProfile(activeId);
  const mode = store.get('connectionMode', 'proxy');
  const allProfiles = store.get('profiles', []);

  const serverItems = allProfiles.slice(0, TRAY_SERVER_LIST_LIMIT).map((p) => ({
    label: p.name || `${p.address}:${p.port}`,
    type: 'radio',
    checked: p.id === activeId,
    enabled: !busy,
    click: () => {
      if (p.id === activeId && connected) return;
      vpn.connect(p.id).catch(() => {});
    },
  }));

  return Menu.buildFromTemplate([
    {
      label: profile ? `سرور: ${profile.name}` : 'کانفیگی انتخاب نشده',
      enabled: false,
    },
    { label: `حالت: ${mode === 'tun' ? 'تانل کامل' : 'پروکسی سیستم'}`, enabled: false },
    { type: 'separator' },
    {
      label: connected ? 'قطع اتصال' : 'اتصال',
      enabled: !busy && !!profile,
      click: () => {
        if (connected) vpn.disconnect().catch(() => {});
        else if (profile) vpn.connect(profile.id).catch(() => {});
      },
    },
    {
      label: 'انتخاب سریع سرور',
      enabled: serverItems.length > 0,
      submenu: serverItems.length ? serverItems : [{ label: 'کانفیگی وجود ندارد', enabled: false }],
    },
    { type: 'separator' },
    { label: 'باز کردن Soul Connection', click: () => mainWindow && mainWindow.show() },
    {
      label: 'تنظیمات',
      click: () => {
        if (!mainWindow) return;
        mainWindow.show();
        mainWindow.webContents.send('open-settings');
      },
    },
    { type: 'separator' },
    { label: 'خروج', click: () => { isQuitting = true; app.quit(); } },
  ]);
}

const APP_ICON_PATH = path.join(__dirname, 'assets', 'icon.ico');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 880,
    height: 880,
    minWidth: 720,
    minHeight: 720,
    backgroundColor: '#0a0d13',
    autoHideMenuBar: true,
    icon: APP_ICON_PATH,
    frame: false, // fully custom title bar, drawn in the renderer
    roundedCorners: true, // native DWM corner rounding on Windows 11 when not maximized
    show: false, // paired with 'ready-to-show' below so launch never flashes an unpainted frame
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.setAspectRatio(1); // the UI is designed as a 1:1 square, restored on unmaximize/leave-fullscreen below

  // Belt-and-suspenders for the same elevated-launch DPI quirk noted above:
  // nudging the size by a pixel and immediately back forces Chromium to
  // actually re-run layout against the display's real (by-then-settled)
  // scale factor, instead of whatever it cached at the moment of construction.
  const nudgeResizeForDpiRefresh = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const [w, h] = mainWindow.getSize();
    mainWindow.setSize(w + 1, h + 1);
    setImmediate(() => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setSize(w, h);
    });
  };

  mainWindow.once('ready-to-show', () => {
    const settings = getSettings();
    if (settings.startMinimized) {
      // Tray-enabled: stay fully hidden -- the tray icon's click handler
      // (and its "باز کردن" menu item) already call mainWindow.show() to restore.
      if (!settings.minimizeToTray) {
        mainWindow.show();
        mainWindow.minimize();
        nudgeResizeForDpiRefresh();
      }
    } else {
      mainWindow.show();
      nudgeResizeForDpiRefresh();
    }
  });

  const indexPath = path.join(__dirname, '..', 'dist', 'index.html');
  mainWindow.loadFile(indexPath);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  const sendWindowState = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window-state', {
        maximized: mainWindow.isMaximized(),
        fullscreen: mainWindow.isFullScreen(),
      });
    }
  };
  // Maximize/fullscreen fill the whole screen, so the 1:1 lock has to relax
  // for that duration and snap back the moment the window is a normal square again.
  mainWindow.on('maximize', () => { mainWindow.setAspectRatio(0); sendWindowState(); });
  mainWindow.on('unmaximize', () => { mainWindow.setAspectRatio(1); sendWindowState(); });
  mainWindow.on('enter-full-screen', () => { mainWindow.setAspectRatio(0); sendWindowState(); });
  mainWindow.on('leave-full-screen', () => { mainWindow.setAspectRatio(1); sendWindowState(); });
  mainWindow.webContents.once('did-finish-load', sendWindowState);

  mainWindow.on('close', (e) => {
    if (!isQuitting && getSettings().minimizeToTray) {
      e.preventDefault();
      mainWindow.hide();
    }
    // Otherwise let the window close normally; the 'will-quit' handler is the
    // single authoritative gate that disconnects before the app actually exits.
  });
}

function createTray() {
  const icon = nativeImage.createFromPath(APP_ICON_PATH);
  try {
    tray = new Tray(icon);
    tray.setContextMenu(buildTrayMenu());
    tray.on('click', () => mainWindow && mainWindow.show());
  } catch {
    tray = null;
  }
}

// Soul Connection pool servers are connectable but live outside the user's
// own list (see soulPool.cjs), so every lookup that resolves an id to a
// profile has to consider both. This is the single place that happens.
function findProfile(id) {
  return store.get('profiles', []).find((p) => p.id === id) || soulPool.find(id);
}

// ---- App updates ----
//
// The manager owns the whole protocol (check, download, verify, install) and
// publishes one status snapshot per change. Everything main.cjs contributes is
// the two things only it can know: what the user's policy is, and how to bring
// the machine back to a clean state before the installer runs.
const updateManager = new UpdateManager();
updateManager.on('status', (status) => sendToWindow('updater-status', status));

// ---- Adaptive Shield ----
//
// Owns which anti-DPI treatment each server uses on the current network, and
// the measurement that decides it. connect() below asks it for a key; it never
// touches the connection itself.
const shieldManager = new ShieldManager({
  store,
  xrayBin,
  xrayAssetDir,
  workRoot: xrayWorkDir,
  getMode: () => getSettings().shieldMode,
  log: (msg) => { if (process.env.SC_DEBUG) console.log(msg); },
});
shieldManager.on('progress', (p) => sendToWindow('shield-progress', p));

app.whenReady().then(async () => {
  app.setAppUserModelId('com.kasra.soulconnection');

  // If we're persisted in tunnel mode from a previous session but this launch
  // isn't elevated, re-launch elevated before ever showing a window -- avoids
  // a flash of a window that can't actually connect in tunnel mode.
  const persistedMode = store.get('connectionMode', 'proxy');
  if (persistedMode === 'tun' && !(await isElevated())) {
    const relaunched = await relaunchElevated(app);
    if (relaunched) return; // this instance is exiting; the elevated one takes over
    // UAC prompt was declined or failed -- fall back to proxy mode instead of
    // exiting with no window ever shown.
    store.set('connectionMode', 'proxy');
    notify('دسترسی مدیر رد شد', 'حالت تانل نیاز به دسترسی مدیر دارد. برنامه در حالت پروکسی سیستم باز شد.');
  }

  createWindow();
  createTray();

  updateManager.configure({
    app,
    getMode: () => getSettings().autoUpdateMode,
    notify: (version) => notify(
      'نسخه‌ی جدید موجود است',
      `Soul Connection ${version} منتشر شد و در حال آماده‌سازی است.`,
      'update'
    ),
    beforeInstall: prepareForInstall,
    log: (msg) => { if (process.env.SC_DEBUG) console.log(msg); },
  });
  // Only a packaged build has a real release to compare itself against; in
  // development the version in package.json is whatever is being worked on.
  if (app.isPackaged) updateManager.start();

  const settings = getSettings();
  app.setLoginItemSettings({ openAtLogin: !!settings.launchOnStartup });
  scheduleSubAutoUpdate();

  // A crash, a force-quit, or a machine that lost power while connected leaves
  // three things behind that all look to the user like "the internet is
  // broken": Windows still pointed at a loopback proxy port with nothing
  // listening on it, a pair of /1 routes into an adapter that died with the
  // process, and possibly a Kill Switch block. None of those endings run the
  // normal teardown, so the core reconciles all of them here -- touching only
  // what is unmistakably ours -- and samples the un-tunnelled baseline address
  // while it is still meaningful to do so.
  vpn.recoverFromUnclean().catch(() => {});

  // If this launch is the one right after an update installed itself, put the
  // user back on the server they were using.
  resumeAfterUpdateIfNeeded();

  if (settings.runLocalProxyOnStartup) {
    const profileId = store.get('activeProfileId');
    if (profileId && findProfile(profileId)) {
      vpn.connect(profileId).catch((err) => {
        if (process.env.SC_DEBUG) console.error('[connect] rejected:', err);
      });
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else mainWindow.show();
  });
});

// Bring the machine back to a clean state, then let the update manager spawn
// the installer. The installer replaces the app's files and restarts it, so
// anything still live at that moment is a problem: an xray process holding
// the proxy port, a WinINET system-proxy pointing at 127.0.0.1, or a Kill
// Switch firewall rule would all outlive the app that owns them.
//
// The one thing the user should not lose to an update is their connection, so
// an active session is recorded first and picked up again by the new version
// on its first launch (see RESUME_KEY below).
const RESUME_KEY = 'resumeAfterUpdate';

async function prepareForInstall() {
  isQuitting = true;

  if (vpn.state !== 'disconnected') {
    store.set(RESUME_KEY, {
      profileId: store.get('activeProfileId', null),
      soul: store.get('soulModeEnabled', false),
      at: Date.now(),
    });
  }

  // shutdown() disconnects and then, belt and braces, withdraws the system
  // proxy and tears down any tunnel routes even if the disconnect threw
  // partway: leaving the user stuck on an old version is worse than a teardown
  // that didn't fully report success, but leaving Windows pointed at a port
  // that is about to stop existing is worse than both.
  await vpn.shutdown();
  store.flush();
}

// The manager spawns a detached installer and then this fires: the running exe
// has to release its own files before NSIS can replace them. app.exit() skips
// the will-quit teardown, which has already run above.
updateManager.on('handoff', () => {
  setTimeout(() => app.exit(0), 400);
});

// Consumed once, on the first launch of the version that was just installed.
// Only honoured if the handoff was recent -- an update the user walked away
// from for a day should not silently reconnect them a day later.
function resumeAfterUpdateIfNeeded() {
  const resume = store.get(RESUME_KEY, null);
  if (!resume) return;
  store.set(RESUME_KEY, null);
  if (!resume.profileId || Date.now() - (resume.at || 0) > 30 * 60 * 1000) return;
  if (getSettings().runLocalProxyOnStartup) return; // startup already handles it

  setTimeout(() => {
    if (vpn.state !== 'disconnected') return;
    if (resume.soul && soulPool.find(resume.profileId)) {
      connectBestSoul().catch(() => {});
      return;
    }
    if (findProfile(resume.profileId)) {
      vpn.connect(resume.profileId, { reason: 'resume' }).catch(() => {});
    }
  }, 2500);
}

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Teardown has to run before the process goes away, but app.quit() re-fires
// will-quit -- so the work happens exactly once and the second pass falls
// straight through, otherwise preventDefault + quit() loops forever.
let quitCleanupDone = false;
app.on('will-quit', (e) => {
  if (quitCleanupDone) { store.flush(); return; }
  e.preventDefault();
  quitCleanupDone = true;
  (async () => {
    try {
      // Disconnect, then withdraw the system proxy and tear down tunnel routes
      // regardless of how that went: a teardown that threw partway -- or a
      // previous run that died mid-session -- must not leave Windows pointed at
      // a port that no longer exists.
      //
      // Capped: this shells out to reg.exe, and an app that cannot be closed
      // because a registry call hung is worse than a proxy left behind (which
      // the next launch reconciles anyway).
      await Promise.race([
        vpn.shutdown(),
        new Promise((r) => setTimeout(r, 6000)),
      ]);
    } catch { /* fall through -- quitting must happen regardless */ } finally {
      try { store.flush(); } catch { /* ignore */ }
      // The quietest possible moment to apply an update that is already
      // downloaded and verified: the user is closing the app anyway, so the
      // installer runs silently behind them and the next launch is simply the
      // new version. No relaunch, no interruption, nothing to click.
      try { updateManager.installOnQuit(); } catch { /* never block the quit */ }
      app.quit();
    }
  })();
});

// ---- IPC handlers ----

// ---- Window controls (custom title bar) ----

ipcMain.handle('window:minimize', () => { mainWindow?.minimize(); });
ipcMain.handle('window:toggleMaximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.handle('window:close', () => { mainWindow?.close(); });
ipcMain.handle('window:isMaximized', () => !!mainWindow?.isMaximized());

// Everything a freshly opened window needs to draw itself, in one call.
ipcMain.handle('profiles:list', () => {
  const { active, backup, failover } = vpn.healthSnapshot();
  return {
    profiles: store.get('profiles', []),
    subscriptions: store.get('subscriptions', []),
    activeProfileId: store.get('activeProfileId', null),
    connectionMode: vpn.connectionMode,
    ...vpn.snapshot(),
    settings: getSettings(),
    soulModeEnabled: store.get('soulModeEnabled', false),
    soulCount: soulPool.list().length,
    activeSoulProfile: soulActiveProfile(),
    routing: vpn.routingState(),
    health: { active, backup },
    failover,
  };
});

ipcMain.handle('settings:setMode', async (_e, mode) => {
  if (mode !== 'proxy' && mode !== 'tun') throw new Error('حالت نامعتبر');
  if (vpn.state !== 'disconnected') throw new Error('اول باید قطع اتصال کنی');

  if (mode === 'tun' && !(await isElevated())) {
    notify('اجرای مجدد با دسترسی مدیر', 'حالت تانل نیاز به دسترسی مدیر دارد. برنامه به‌زودی دوباره باز می‌شود…');
    const relaunched = await relaunchElevated(app);
    if (!relaunched) {
      throw new Error('برای فعال‌سازی حالت تانل باید درخواست دسترسی مدیر (UAC) رو تایید کنی');
    }
    return mode; // unreachable in practice -- app.exit() fires inside relaunchElevated
  }

  vpn.connectionMode = mode;
  return mode;
});

ipcMain.handle('profiles:addLink', (_e, text) => {
  // Accepts a single link or a whole clipboard/textarea paste containing
  // several -- parseMany scans for every valid config regardless of how
  // they're separated (or not separated at all) and dedupes within the paste.
  const parsed = parseMany(text);
  if (!parsed.length) throw new Error('کانفیگ نامعتبر است یا پشتیبانی نمی‌شود');

  const profiles = store.get('profiles', []);
  const existingLinks = new Set(profiles.map((p) => p.link).filter(Boolean));
  const added = [];
  for (const p of parsed) {
    if (existingLinks.has(p.link)) continue; // already saved -- skip duplicate
    existingLinks.add(p.link);
    added.push(p);
  }
  if (!added.length) throw new Error('همه‌ی کانفیگ‌های شناسایی‌شده از قبل اضافه شده بودند');

  store.set('profiles', profiles.concat(added));
  return { profiles: added, duplicates: parsed.length - added.length };
});

ipcMain.handle('profiles:addCustom', (_e, fields) => {
  const profile = buildCustomProfile(fields);
  const profiles = store.get('profiles', []);
  profiles.push(profile);
  store.set('profiles', profiles);
  return profile;
});

ipcMain.handle('profiles:delete', async (_e, id) => {
  if (store.get('activeProfileId') === id) {
    await vpn.disconnect({ reason: 'profile-deleted' });
    store.set('activeProfileId', null);
  }
  const profiles = store.get('profiles', []).filter((p) => p.id !== id);
  store.set('profiles', profiles);
  return profiles;
});

ipcMain.handle('profiles:rename', (_e, { id, name }) => {
  const profiles = store.get('profiles', []);
  const p = profiles.find((x) => x.id === id);
  if (p) p.name = name;
  store.set('profiles', profiles);
  return profiles;
});

ipcMain.handle('profiles:update', (_e, { id, link }) => {
  const parsed = parseLink(link);
  if (!parsed) throw new Error('کانفیگ نامعتبر است یا پشتیبانی نمی‌شود');
  if (id === store.get('activeProfileId') && vpn.state !== 'disconnected') {
    throw new Error('اول باید قطع اتصال کنی');
  }
  const profiles = store.get('profiles', []);
  const existing = profiles.find((p) => p.id === id);
  if (!existing) throw new Error('کانفیگ پیدا نشد');
  Object.assign(existing, parsed, {
    id: existing.id,
    subId: existing.subId,
    favorite: existing.favorite,
    totalBytes: existing.totalBytes,
    createdAt: existing.createdAt,
    lastUsedAt: existing.lastUsedAt,
  });
  store.set('profiles', profiles);
  return profiles;
});

ipcMain.handle('subscriptions:add', async (_e, url) => {
  const { text, headers } = await fetchText(url);
  const parsed = parseMany(text);
  if (!parsed.length) throw new Error('هیچ کانفیگی در این ساب‌اسکریپشن پیدا نشد');
  const usage = parseSubscriptionUserinfo(headers['subscription-userinfo']);
  const sub = { id: newId(), url, name: url, createdAt: Date.now(), lastUpdated: Date.now(), configCount: parsed.length, usage };
  parsed.forEach((p) => { p.subId = sub.id; });

  const subs = store.get('subscriptions', []);
  subs.push(sub);
  store.set('subscriptions', subs);

  const profiles = store.get('profiles', []).concat(parsed);
  store.set('profiles', profiles);
  return { subscription: sub, profiles: parsed };
});

async function refreshSubscription(subId) {
  const subs = store.get('subscriptions', []);
  const sub = subs.find((s) => s.id === subId);
  if (!sub) throw new Error('ساب‌اسکریپشن پیدا نشد');
  const { text, headers } = await fetchText(sub.url);
  const parsed = parseMany(text);
  // Never let a broken/blocked/rate-limited response wipe the whole group:
  // replacing N working configs with zero is far worse than a failed refresh.
  if (!parsed.length) throw new Error('هیچ کانفیگی در این ساب‌اسکریپشن پیدا نشد');
  const usage = parseSubscriptionUserinfo(headers['subscription-userinfo']);

  const allProfiles = store.get('profiles', []);
  const previousByLink = new Map();
  for (const p of allProfiles) {
    if (p.subId === subId && p.link) previousByLink.set(p.link, p);
  }

  // A refresh almost always re-lists the same servers, but parseMany mints a
  // brand-new id for every entry it parses. Re-attaching the previous id (and
  // the user-owned state hanging off it) is what makes a re-listed server
  // still be *the same* profile: otherwise every refresh -- including the
  // silent auto-update timer -- looks like "the server you're connected to was
  // deleted", tearing down a perfectly healthy tunnel and resetting favorites
  // and lifetime usage counters along with it.
  const refreshed = parsed.map((fresh) => {
    fresh.subId = subId;
    const prev = previousByLink.get(fresh.link);
    if (!prev) return fresh;
    return {
      ...fresh,
      id: prev.id,
      favorite: prev.favorite,
      totalBytes: prev.totalBytes,
      lastUsedAt: prev.lastUsedAt,
      createdAt: prev.createdAt,
    };
  });

  const activeId = store.get('activeProfileId');
  const nextProfiles = allProfiles.filter((p) => p.subId !== subId).concat(refreshed);
  // Only a server genuinely dropped from the feed should end the session.
  const activeVanished = activeId && !nextProfiles.some((p) => p.id === activeId);
  store.set('profiles', nextProfiles);
  if (activeVanished) {
    store.set('activeProfileId', null);
    if (vpn.state !== 'disconnected') await vpn.disconnect({ reason: 'server-vanished' });
  }

  sub.lastUpdated = Date.now();
  sub.configCount = refreshed.length;
  if (usage) sub.usage = usage;
  store.set('subscriptions', subs);

  return { subscription: sub, profiles: refreshed };
}

async function refreshAllSubscriptions() {
  const subs = store.get('subscriptions', []);
  // Each refreshSubscription() call's store read-modify-write is a single
  // synchronous span (no `await` in between), so running them concurrently
  // is safe -- and turns N sequential network round-trips into one.
  return Promise.all(subs.map((sub) =>
    refreshSubscription(sub.id).catch((err) => ({ subscription: sub, error: err.message }))
  ));
}

function scheduleSubAutoUpdate() {
  if (subAutoUpdateTimer) { clearInterval(subAutoUpdateTimer); subAutoUpdateTimer = null; }
  const interval = getSettings().subAutoUpdateInterval;
  if (!interval || interval <= 0) return;
  subAutoUpdateTimer = setInterval(async () => {
    const results = await refreshAllSubscriptions();
    if (results.length) {
      notify('ساب‌اسکریپشن‌ها به‌روزرسانی شدند', `${results.length} ساب‌اسکریپشن بررسی شد`, 'update');
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('profiles-changed');
    }
  }, interval);
}

ipcMain.handle('subscriptions:refresh', async (_e, subId) => {
  return refreshSubscription(subId);
});

ipcMain.handle('subscriptions:delete', async (_e, subId) => {
  const remaining = store.get('profiles', []).filter((p) => p.subId !== subId);
  const removedIds = new Set(
    store.get('profiles', []).filter((p) => p.subId === subId).map((p) => p.id)
  );
  if (removedIds.has(store.get('activeProfileId'))) {
    await vpn.disconnect({ reason: 'subscription-deleted' });
    store.set('activeProfileId', null);
  }
  store.set('profiles', remaining);
  store.set('subscriptions', store.get('subscriptions', []).filter((s) => s.id !== subId));
  return remaining;
});

ipcMain.handle('subscriptions:update', (_e, { id, name, url }) => {
  const subs = store.get('subscriptions', []);
  const sub = subs.find((s) => s.id === id);
  if (!sub) throw new Error('ساب‌اسکریپشن پیدا نشد');
  if (name !== undefined) sub.name = name;
  if (url !== undefined) sub.url = url;
  store.set('subscriptions', subs);
  return subs;
});

ipcMain.handle('connection:connect', async (_e, profileId) => {
  // Connecting to a specific server by hand is an explicit exit from "let the
  // pool choose" -- otherwise the next connect would silently override the
  // server the user just picked. Anything else in flight (a pool sweep, a
  // pending auto-reconnect) is cancelled by the core as part of taking the
  // command, so there is nothing to cancel here first.
  if (store.get('soulModeEnabled', false) && !soulPool.find(profileId)) {
    store.set('soulModeEnabled', false);
  }
  await vpn.connect(profileId);
  return { connectionState: vpn.state };
});

ipcMain.handle('connection:disconnect', async () => {
  // Cancels a selection sweep in flight too -- otherwise "disconnect" would
  // leave probes and test tunnels running and then connect anyway.
  await vpn.disconnect();
  return { connectionState: vpn.state };
});

// ---- Soul Connection server pool ----

function sendSoulProgress(payload) {
  sendToWindow('soul-progress', payload);
}

ipcMain.handle('soul:list', async (_e, { force = false } = {}) => {
  const profiles = await soulPool.refresh({ force });
  return { count: profiles.length, fetchedAt: store.get('soulProfilesFetchedAt', 0) };
});

ipcMain.handle('soul:setEnabled', (_e, enabled) => {
  const on = !!enabled;
  store.set('soulModeEnabled', on);

  // Entering pool mode while idle drops the manual selection, so the connect
  // button can't show one server while the pool is about to pick another.
  // While *connected*, activeProfileId still names the live server -- the
  // tray, traffic accounting and disconnect all read it -- so it stays put
  // and the switch happens on the next connect instead.
  if (on && vpn.state === 'disconnected') {
    store.set('activeProfileId', null);
    sendState();
  }

  // Deliberately no sendState() when leaving pool mode: main changes nothing
  // the renderer doesn't already know, and while disconnected main's
  // activeProfileId is intentionally stale (a manual pick isn't persisted
  // until connect) -- pushing it here would overwrite the selection the user
  // just made in the sidebar.
  return { soulModeEnabled: on };
});

ipcMain.handle('soul:cancel', () => {
  vpn.cancelPending('soul-cancel');
  return true;
});

// Test, rank, then connect to the winner.
//
// The sweep runs inside the core's *activity*, not inside its connection lock:
// it can take ten seconds or more, and holding the lock that long would block
// disconnect and leave the user unable to cancel. What the activity adds is the
// half that used to be missing -- a disconnect during the sweep now aborts it,
// where before it was quietly overwritten by the connect that followed anyway.
async function connectBestSoul() {
  let picked = null;
  try {
    await vpn.connectVia(async ({ signal }) => {
      const { profile, metrics } = await soulPool.selectBest({ signal, emit: sendSoulProgress });
      picked = { profile, metrics };
      sendSoulProgress({ phase: 'connecting', server: profile.name });
      return profile.id;
    }, { reason: 'soul' });
    sendSoulProgress({ phase: 'done', server: picked.profile.name, ...picked.metrics });
    return { connectionState: vpn.state, profile: picked.profile, metrics: picked.metrics };
  } catch (err) {
    const cancelled = Activity.isCancellation(err);
    sendSoulProgress({ phase: 'error', message: cancelled ? null : (err.message || 'خطا') });
    if (cancelled) return { connectionState: vpn.state, cancelled: true };
    throw err;
  }
}

ipcMain.handle('soul:connectBest', () => connectBestSoul());

ipcMain.handle('tunnel:get', () => vpn.tunnelStatus.snapshot());

ipcMain.handle('tunnel:refresh', async () => {
  if (!vpn.isConnected) return vpn.tunnelStatus.snapshot();
  return vpn.tunnelStatus.probe();
});

ipcMain.handle('connection:status', () => ({
  connectionState: vpn.state,
  activeProfileId: store.get('activeProfileId', null),
  killSwitchBlocking: vpn.killSwitch.blocking,
}));

// A real measurement, and the most real one available for this profile:
//   * the server we are currently tunnelling through gets measured THROUGH the
//     tunnel -- an actual request out to the internet and back, which is the
//     latency the user is living with rather than the distance to the front door.
//   * everything else gets repeated TCP handshakes with DNS factored out
//     (see lib/pingTest.cjs). No scores, no interpolation, no cached guesses.
// `payload` is either a bare profile id (a single click on one row) or
// `{ profileId, token }` -- a batch sweep passes a token so its stop button can
// abandon measurements that are already running, not just the queue behind them.
// The token registry is serverTest's, and `test:cancel` already drives it.
ipcMain.handle('ping:test', async (_e, payload) => {
  const profileId = typeof payload === 'string' ? payload : payload?.profileId;
  const token = typeof payload === 'string' ? null : payload?.token;
  const profile = findProfile(profileId);
  if (!profile) throw new Error('کانفیگ پیدا نشد');

  const live = vpn.isConnected && vpn.session.profileId === profileId;
  if (live) {
    // 6s per sample, not proxyPing's 12s default: this backs a button the user
    // is watching, and a tunnel that needs longer than that has already
    // answered the question.
    const samples = await vpn.pingLiveTunnel({ samples: 3, timeoutMs: 6000 });
    if (samples && samples.length) {
      const ok = samples.filter((s) => s > 0).sort((a, b) => a - b);
      if (ok.length) {
        return {
          profileId,
          method: 'tunnel',
          ms: ok[Math.floor(ok.length / 2)],
          min: ok[0],
          max: ok[ok.length - 1],
          avg: Math.round(ok.reduce((a, b) => a + b, 0) / ok.length),
          jitter: ok.length > 1 ? Math.round(ok[ok.length - 1] - ok[0]) : null,
          loss: Math.round(((samples.length - ok.length) / samples.length) * 100),
          samples,
        };
      }
      // Tunnel up but nothing passing -- fall through to the TCP measurement so
      // the user still learns whether the server itself is reachable.
    }
  }

  const run = beginPingRun(token);
  try {
    const result = await measurePing(profile.address, profile.port, {
      count: 5, timeoutMs: 3000, gapMs: 80, signal: run.signal,
    });
    return { profileId, ...result };
  } finally {
    run.done();
  }
});

// Cancelling a batch sweep. One token covers every measurement the sweep has in
// flight -- a dozen at a time -- so a token maps to a SET of controllers.
// serverTest's registry is deliberately not reused: it is one controller per
// token, which is right for the finder (serial) and would silently drop all but
// the last of these.
const pingRuns = new Map(); // token -> Set<AbortController>

function beginPingRun(token) {
  if (!token) return { signal: null, done() {} };
  const controller = new AbortController();
  let set = pingRuns.get(token);
  if (!set) { set = new Set(); pingRuns.set(token, set); }
  set.add(controller);
  return {
    signal: controller.signal,
    done() {
      const live = pingRuns.get(token);
      if (!live) return;
      live.delete(controller);
      if (!live.size) pingRuns.delete(token);
    },
  };
}

ipcMain.handle('ping:cancel', (_e, token) => {
  const set = pingRuns.get(token);
  if (!set) return 0;
  for (const c of set) c.abort();
  pingRuns.delete(token);
  return set.size;
});

// ---- Server Finder test engine ----

function emitTestEvent(token, type, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('test-event', { token, type, ...data });
  }
}

function requireProfile(profileId) {
  const profile = findProfile(profileId);
  if (!profile) throw new Error('کانفیگ پیدا نشد');
  return profile;
}

ipcMain.handle('test:ping', async (_e, { profileId, token }) => {
  const profile = requireProfile(profileId);
  const signal = serverTest.begin(token);
  try {
    return await serverTest.pingStats(profile, {
      signal,
      onSample: (s) => emitTestEvent(token, 'sample', s),
    });
  } finally {
    serverTest.end(token);
  }
});

ipcMain.handle('test:real', async (_e, { profileId, token }) => {
  const profile = requireProfile(profileId);
  const signal = serverTest.begin(token);
  try {
    return await serverTest.realPing(profile, {
      xrayBin, xrayAssetDir, workRoot: xrayWorkDir, signal,
      emit: (type, data) => emitTestEvent(token, type, data),
    });
  } finally {
    serverTest.end(token);
  }
});

ipcMain.handle('test:speed', async (_e, { profileId, token }) => {
  const profile = requireProfile(profileId);
  const signal = serverTest.begin(token);
  try {
    return await serverTest.speedTest(profile, {
      xrayBin, xrayAssetDir, workRoot: xrayWorkDir, signal,
      emit: (type, data) => emitTestEvent(token, type, data),
    });
  } finally {
    serverTest.end(token);
  }
});

ipcMain.handle('test:cancel', (_e, token) => {
  serverTest.cancel(token);
});

ipcMain.handle('profiles:setFavorite', (_e, { id, favorite }) => {
  const profiles = store.get('profiles', []);
  const p = profiles.find((x) => x.id === id);
  if (p) p.favorite = !!favorite;
  store.set('profiles', profiles);
  return profiles;
});

ipcMain.handle('subscriptions:refreshAll', async () => {
  return refreshAllSubscriptions();
});

ipcMain.handle('settings:get', () => getSettings());

const LOG_LEVELS = new Set(['none', 'error', 'warning', 'info', 'debug']);
const BOOLEAN_SETTINGS = new Set([
  'launchOnStartup', 'runLocalProxyOnStartup', 'startMinimized', 'restorePreviousSession',
  'minimizeToTray', 'autoReconnect', 'killSwitchEnabled', 'reduceMotion',
  'lanDirect', 'autoSelectBestServer', 'failoverEnabled', 'backupMonitoring',
  'notifications', 'notifyConnection', 'notifyFailover', 'notifyUpdates',
]);
// Whole numbers with a range. Out-of-range is dropped rather than clamped, so
// a control that sends nonsense is a no-op the user can see rather than a
// silent substitution they can't.
const RANGED_SETTINGS = {
  reconnectAttempts: [1, 20],
  reconnectDelayMs: [500, 30000],
};
const PORT_SETTINGS = new Set(['socksPort', 'httpPort']);
const HOST_SETTINGS = new Set(['socksHost', 'httpHost']);
const TEXT_SETTINGS = new Set(['socksUsername', 'socksPassword', 'httpUsername', 'httpPassword']);
const isValidPort = (v) => typeof v === 'number' && Number.isInteger(v) && v >= 1024 && v <= 65535;
// Accepts a dotted IPv4 address (with octet range checking) or a bare
// hostname/domain, matching the "127.0.0.1 or any custom IP/domain" spec.
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HOSTNAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
function isValidHost(v) {
  if (typeof v !== 'string' || !v.trim()) return false;
  const m = v.match(IPV4_RE);
  if (m) return m.slice(1).every((o) => Number(o) >= 0 && Number(o) <= 255);
  return HOSTNAME_RE.test(v);
}

ipcMain.handle('settings:update', async (_e, patch) => {
  const allowed = new Set(Object.keys(DEFAULT_SETTINGS));
  const clean = {};
  for (const key of Object.keys(patch || {})) {
    if (!allowed.has(key)) continue;
    const value = patch[key];
    if (BOOLEAN_SETTINGS.has(key)) {
      if (typeof value !== 'boolean') continue;
    } else if (key === 'subAutoUpdateInterval') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue;
    } else if (key === 'autoUpdateMode') {
      if (!UPDATE_MODES.has(value)) continue;
    } else if (key === 'shieldMode') {
      if (!SHIELD_MODES.has(value)) continue;
    } else if (key === 'xrayLogLevel') {
      if (!LOG_LEVELS.has(value)) continue;
    } else if (key === 'routingMode') {
      if (!routingRulesLib.MODES.has(value)) continue;
    } else if (key === 'failoverMode') {
      if (!FAILOVER_MODES[value]) continue;
    } else if (PORT_SETTINGS.has(key)) {
      if (!isValidPort(value)) continue;
    } else if (HOST_SETTINGS.has(key)) {
      if (!isValidHost(value)) continue;
    } else if (TEXT_SETTINGS.has(key)) {
      if (typeof value !== 'string' || value.length > 256) continue;
    } else if (RANGED_SETTINGS[key]) {
      const [lo, hi] = RANGED_SETTINGS[key];
      if (typeof value !== 'number' || !Number.isInteger(value) || value < lo || value > hi) continue;
    } else if (key === 'tunDns') {
      if (typeof value !== 'string' || value.length > 200) continue;
    } else if (key === 'customBypass') {
      if (typeof value !== 'string' || value.length > 2000) continue;
    }
    clean[key] = value;
  }

  if ('socksPort' in clean || 'httpPort' in clean) {
    const prospective = { ...getSettings(), ...clean };
    if (prospective.socksPort === prospective.httpPort) {
      throw new Error('پورت SOCKS و HTTP باید متفاوت باشند');
    }
  }

  if ('killSwitchEnabled' in clean) {
    if (clean.killSwitchEnabled) {
      if (!(await isElevated())) {
        notify('اجرای مجدد با دسترسی مدیر', 'Kill Switch نیاز به دسترسی مدیر دارد. برنامه به‌زودی دوباره باز می‌شود…');
        const relaunched = await relaunchElevated(app);
        if (!relaunched) {
          throw new Error('برای فعال‌سازی Kill Switch باید درخواست دسترسی مدیر (UAC) رو تایید کنی');
        }
        return; // unreachable in practice -- app.exit() fires inside relaunchElevated
      }
    }
    // Arming (when already connected) and the emergency lift on the way off are
    // both the guard's business -- see vpn/killSwitchGuard.cjs.
    await vpn.killSwitch.onSettingChanged(clean.killSwitchEnabled, { connected: vpn.isConnected });
  }

  const settings = updateSettings(clean);

  if ('launchOnStartup' in clean) {
    app.setLoginItemSettings({ openAtLogin: !!settings.launchOnStartup });
  }
  if ('subAutoUpdateInterval' in clean) {
    scheduleSubAutoUpdate();
  }
  if ('routingMode' in clean || 'lanDirect' in clean) {
    invalidateRoutingCache();
  }
  // Probe cadence and backup monitoring are derived from these, and the health
  // window's identity check would otherwise keep the old timers running until
  // the next connect.
  if ('failoverMode' in clean || 'failoverEnabled' in clean || 'backupMonitoring' in clean) {
    vpn.restartHealth();
  }
  // The bypass list is written into ProxyOverride, and the host is half of what
  // ProxyServer points at -- edit either while the proxy is live and Windows is
  // now running settings the user has already changed. Push them through.
  if ('customBypass' in clean || 'httpHost' in clean || 'httpPort' in clean) {
    vpn.syncSystemProxy('settings', true).then(() => sendState());
  }
  return settings;
});

ipcMain.handle('app:openLogsFolder', () => {
  shell.openPath(xrayWorkDir);
});

ipcMain.handle('app:openProxyFolder', () => {
  shell.openPath(xrayWorkDir);
});

// These set INTENT and let the controller decide what that means right now.
// Turning it on without a tunnel is allowed and is not an error: the choice is
// recorded, reported back as `pending`, and applied the moment a tunnel exists.
// Never starts or stops xray in either direction.
ipcMain.handle('systemProxy:setDesired', async (_e, desired) => {
  const status = await vpn.systemProxy.setDesired(!!desired);
  sendState();
  // Asking for it with no tunnel to point at is a legitimate state, but the
  // user should hear why nothing changed on their machine yet.
  if (status.desired && !status.active && !status.tunnelUp) {
    return { ...status, note: 'ثبت شد — به‌محض اتصال به سرور، پروکسی سیستم اعمال می‌شود' };
  }
  if (status.desired && !status.active && status.lastError) {
    throw new Error(status.lastError);
  }
  return status;
});

ipcMain.handle('systemProxy:get', () => vpn.systemProxy.status());

// Force a fresh read+converge; what the Settings screen calls when the user
// wants to be sure, and what the renderer calls on window focus.
ipcMain.handle('systemProxy:sync', async () => {
  const status = await vpn.syncSystemProxy('manual', true);
  sendState();
  return status;
});

ipcMain.handle('network:testConnection', (_e, { protocol }) => vpn.testLocalProxy(protocol));

ipcMain.handle('network:getRecentLogs', () => vpn.recentLogs());

const NETWORK_RESET_KEYS = ['socksHost', 'socksPort', 'socksUsername', 'socksPassword', 'httpHost', 'httpPort', 'httpUsername', 'httpPassword', 'customBypass'];
ipcMain.handle('network:resetDefaults', () => {
  if (vpn.state !== 'disconnected') throw new Error('اول باید قطع اتصال کنی');
  const patch = {};
  for (const key of NETWORK_RESET_KEYS) patch[key] = DEFAULT_SETTINGS[key];
  return updateSettings(patch);
});

// Everything back to how it shipped. Deliberately touches settings ONLY --
// servers, subscriptions, routing rules and usage totals are the user's data,
// not preferences, and losing them to a button labelled "reset settings" would
// be indefensible. Requires being disconnected because it rewrites the ports
// and the listen hosts a live tunnel is using.
ipcMain.handle('settings:resetAll', async () => {
  if (vpn.state !== 'disconnected') throw new Error('اول باید قطع اتصال کنی');
  // Lift anything the old settings had switched on at the OS level before the
  // preference that remembers it disappears.
  await vpn.killSwitch.onSettingChanged(false, { connected: false });
  const settings = { ...DEFAULT_SETTINGS };
  store.set('settings', settings);
  app.setLoginItemSettings({ openAtLogin: !!settings.launchOnStartup });
  scheduleSubAutoUpdate();
  invalidateRoutingCache();
  vpn.restartHealth();
  vpn.syncSystemProxy('settings-reset', true).then(() => sendState());
  return settings;
});

ipcMain.handle('app:getInfo', () => ({
  version: app.getVersion(),
  electron: process.versions.electron,
}));

// Every handler answers with the same status snapshot the 'updater-status'
// channel pushes, so the renderer has exactly one shape to understand and a
// freshly opened window can seed itself with updater:state.
// ---- Adaptive Shield ----
// `profileId` is optional everywhere: with none, the panel reports on whatever
// is connected (or last selected), which is what the Settings view wants.
function shieldTarget(profileId) {
  return findProfile(profileId || store.get('activeProfileId', null));
}

ipcMain.handle('shield:state', (_e, profileId) => shieldManager.state(shieldTarget(profileId)));
ipcMain.handle('shield:tune', async (_e, profileId) => {
  const profile = shieldTarget(profileId);
  if (!profile) throw new Error('اول یک سرور انتخاب کن');
  await shieldManager.tune(profile);
  return shieldManager.state(profile);
});
ipcMain.handle('shield:cancel', () => { shieldManager.cancel(); return true; });
ipcMain.handle('shield:clear', () => { shieldManager.clear(); return shieldManager.state(shieldTarget(null)); });
ipcMain.handle('shield:setManualKey', (_e, key) => {
  if (!isShieldKey(key)) throw new Error('پروفایل نامعتبر است');
  store.set('shieldManualKey', key);
  return shieldManager.state(shieldTarget(null));
});

ipcMain.handle('updater:state', () => updateManager.getState());
ipcMain.handle('updater:check', () => updateManager.check({ manual: true }));
ipcMain.handle('updater:download', () => updateManager.download({ install: false }));
ipcMain.handle('updater:downloadAndInstall', () => updateManager.download({ install: true }));
ipcMain.handle('updater:install', () => updateManager.install({ auto: false }));
ipcMain.handle('updater:cancelDownload', () => updateManager.cancelDownload());
ipcMain.handle('updater:cancelAutoInstall', () => updateManager.cancelAutoInstall());
ipcMain.handle('updater:openFolder', () => updateManager.openFolder());

ipcMain.handle('profiles:resetUsage', (_e, id) => {
  const profiles = store.get('profiles', []);
  const p = profiles.find((x) => x.id === id);
  if (p) p.totalBytes = 0;
  store.set('profiles', profiles);
  return profiles;
});

ipcMain.handle('profiles:resetAllUsage', () => {
  const profiles = store.get('profiles', []).map((p) => ({ ...p, totalBytes: 0 }));
  store.set('profiles', profiles);
  return profiles;
});

ipcMain.handle('app:exportBackup', async () => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'پشتیبان‌گیری از کانفیگ‌ها',
    defaultPath: `soul-connection-backup-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (canceled || !filePath) return { canceled: true };

  const backup = {
    version: 1,
    exportedAt: Date.now(),
    profiles: store.get('profiles', []),
    subscriptions: store.get('subscriptions', []),
    settings: getSettings(),
  };
  fs.writeFileSync(filePath, JSON.stringify(backup, null, 2), 'utf8');
  return { canceled: false, filePath };
});

ipcMain.handle('app:saveImage', async (_e, { dataUrl, defaultName }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'ذخیره‌ی تصویر QR',
    defaultPath: defaultName || 'qrcode.png',
    filters: [{ name: 'PNG Image', extensions: ['png'] }],
  });
  if (canceled || !filePath) return { canceled: true };
  const base64 = String(dataUrl).replace(/^data:image\/png;base64,/, '');
  fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
  return { canceled: false, filePath };
});

ipcMain.handle('app:copyImage', (_e, dataUrl) => {
  const img = nativeImage.createFromDataURL(dataUrl);
  clipboard.writeImage(img);
  return true;
});

ipcMain.handle('app:importBackup', async () => {
  if (vpn.state !== 'disconnected') throw new Error('اول باید قطع اتصال کنی');

  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'بازیابی کانفیگ‌ها',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths.length) return { canceled: true };

  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePaths[0], 'utf8'));
  } catch {
    throw new Error('فایل پشتیبان معتبر نیست');
  }
  if (!Array.isArray(data.profiles)) throw new Error('فایل پشتیبان معتبر نیست');

  store.set('profiles', data.profiles);
  store.set('subscriptions', Array.isArray(data.subscriptions) ? data.subscriptions : []);
  if (data.settings && typeof data.settings === 'object') {
    const allowedKeys = new Set(Object.keys(DEFAULT_SETTINGS));
    const clean = {};
    for (const key of Object.keys(data.settings)) {
      if (allowedKeys.has(key)) clean[key] = data.settings[key];
    }
    updateSettings(clean);
  }
  store.set('activeProfileId', null);
  return { canceled: false, profiles: data.profiles.length };
});

// ---- Smart Routing IPC ----

// Apply an edit to the rule list, then work out whether the user has to be
// told that it will not take effect until the next connect. Only a change to
// the compiled rule set xray is running needs one -- app rules live entirely
// in the dispatcher, which reads the policy fresh on every connection, so
// editing those takes effect immediately and silently.
function applyRoutingChange(mutate) {
  const live = vpn.isConnected;
  const before = live ? vpn.routingSignature() : null;
  mutate();
  invalidateRoutingCache();
  const needsReconnect = live && before !== vpn.routingSignature();
  const state = { ...vpn.routingState(), needsReconnect };
  sendToWindow('routing-changed', state);
  return state;
}

function writeRules(rules) {
  if (rules.length > routingRulesLib.MAX_RULES) {
    throw new Error(`حداکثر ${routingRulesLib.MAX_RULES} قانون می‌توانی داشته باشی`);
  }
  store.set('routingRules', rules);
}

ipcMain.handle('routing:get', () => vpn.routingState());

// The running-programs list behind the rule picker. Errors are returned rather
// than thrown: a picker that opens with an explanation and a manual text field
// is useful, one that fails to open is not.
ipcMain.handle('apps:list', async (_e, { force = false } = {}) => {
  try {
    const { apps, source, cached } = await appList.list({ force });
    return { apps, source, cached };
  } catch (err) {
    return { apps: [], source: null, error: err.message || 'فهرست برنامه‌ها خوانده نشد' };
  }
});

ipcMain.handle('routing:setMode', (_e, mode) => applyRoutingChange(() => {
  if (!routingRulesLib.MODES.has(mode)) throw new Error('حالت مسیریابی نامعتبر است');
  updateSettings({ routingMode: mode });
}));

ipcMain.handle('routing:setLanDirect', (_e, enabled) => applyRoutingChange(() => {
  updateSettings({ lanDirect: !!enabled });
}));

// One handler for add and edit: a payload carrying an existing id replaces
// that rule in place (keeping its position in the list), anything else is
// appended. Validation and normalization live in rules.cjs, so a rule saved
// here matches by exactly the same logic the dispatcher applies later.
ipcMain.handle('routing:saveRule', (_e, payload) => applyRoutingChange(() => {
  const rules = getRoutingRules();
  const idx = payload?.id ? rules.findIndex((r) => r.id === payload.id) : -1;
  const rule = routingRulesLib.normalizeRule(payload, idx >= 0 ? rules[idx] : null);
  if (idx >= 0) rules[idx] = rule;
  else rules.push(rule);
  writeRules(rules);
}));

ipcMain.handle('routing:deleteRule', (_e, id) => applyRoutingChange(() => {
  writeRules(getRoutingRules().filter((r) => r.id !== id));
}));

ipcMain.handle('routing:toggleRule', (_e, { id, enabled }) => applyRoutingChange(() => {
  const rules = getRoutingRules();
  const rule = rules.find((r) => r.id === id);
  if (rule) rule.enabled = !!enabled;
  writeRules(rules);
}));

// Bulk entry: a pasted list of domains, one route for all of them. Separators
// are whatever the user happened to use -- commas, semicolons, newlines,
// spaces -- because this field exists precisely so nobody has to add fifteen
// domains one dialog at a time.
ipcMain.handle('routing:addDomains', (_e, { domains, route, exe, appName }) => applyRoutingChange(() => {
  const parts = String(domains || '').split(/[\s,;]+/).map((d) => d.trim()).filter(Boolean);
  if (!parts.length) throw new Error('هیچ دامنه‌ای وارد نشده است');
  const rules = getRoutingRules();
  const seen = new Set(rules.map((r) => `${r.exe}|${r.domain}`));
  let added = 0;
  for (const domain of parts) {
    const rule = routingRulesLib.normalizeRule({ domain, route, exe, appName });
    const key = `${rule.exe}|${rule.domain}`;
    if (seen.has(key)) continue; // re-pasting a list must not duplicate it
    seen.add(key);
    rules.push(rule);
    added++;
  }
  if (!added) throw new Error('همه‌ی این دامنه‌ها از قبل اضافه شده بودند');
  writeRules(rules);
}));

// ---- Smart server selection ----

async function rankByTcp(profiles, limit = 8, signal = null) {
  const results = new Array(profiles.length);
  let cursor = 0;
  const runner = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= profiles.length) return;
      // The user cancelled (disconnected) mid-sweep: stop probing rather than
      // finishing a ranking nobody is waiting for.
      if (signal && signal.aborted) return;
      const p = profiles[i];
      try {
        const r = await serverTest.tcpPingStats(p.address, p.port, { count: 2, timeoutMs: 1500, gapMs: 60, signal });
        results[i] = { profile: p, score: tcpOnlyScore({ latency: r.avg, loss: r.loss }), avg: r.avg };
      } catch {
        results[i] = null;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, profiles.length) }, runner));
  return results.filter((r) => r && r.score != null).sort((a, b) => b.score - a.score);
}

// "Automatically Select Best Server" for the user's own configs. The pool has
// its own, deeper selection (soulPool.selectBest) because it can afford to
// tunnel-test unknown servers; here the list is the user's, usually small, and
// a quick quality-weighted probe is the right trade between accuracy and the
// wait before the connect button does something.
ipcMain.handle('connection:connectBest', async () => {
  const profiles = store.get('profiles', []);
  if (!profiles.length) throw new Error('کانفیگی برای انتخاب وجود ندارد');
  if (profiles.length === 1) {
    await vpn.connect(profiles[0].id, { reason: 'best' });
    return { connectionState: vpn.state, profile: briefProfile(profiles[0]) };
  }

  // The probe sweep takes a couple of seconds. Running it inside the core's
  // activity is what shows it as "connecting" for that whole time, keeps the
  // cancel path honest, and puts the machine back where it was -- including
  // back to `connected` over a still-live tunnel -- if nothing answers.
  let winner = null;
  await vpn.connectVia(async ({ signal }) => {
    const ranked = await rankByTcp(profiles.slice(0, MAX_FAILOVER_CANDIDATES), 8, signal);
    if (!ranked.length) throw new Error('هیچ سروری پاسخ نداد. اتصال اینترنت خود را بررسی کنید.');
    winner = ranked[0];
    return winner.profile.id;
  }, { reason: 'best' });
  return { connectionState: vpn.state, profile: briefProfile(winner.profile), score: winner.score };
});

ipcMain.handle('health:get', () => vpn.healthSnapshot());
