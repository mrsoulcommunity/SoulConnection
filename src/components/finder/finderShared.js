// Shared vocabulary of the Server Finder UI: the three test modes, the sort
// axes, phase labels, formatting helpers, and the two localStorage pockets
// (finder preferences, recent searches). Pure data and pure functions only --
// anything with state or JSX lives in the components.

export const MODES = [
  { key: 'ping', icon: 'signal', title: 'پینگ شبکه', desc: 'ICMP و TCP — سریع، فقط تاخیر شبکه' },
  { key: 'real', icon: 'radar', title: 'پینگ واقعی', desc: 'اتصال واقعی با کانفیگ و سنجش تاخیر از داخل تونل' },
  { key: 'speed', icon: 'gauge', title: 'تست سرعت', desc: 'بنچمارک دانلود و آپلود از داخل تونل' },
];

export const SORTS = [
  ['score', 'بهترین امتیاز'],
  ['ping', 'کمترین پینگ'],
  ['real', 'کمترین پینگ واقعی'],
  ['down', 'بیشترین سرعت دانلود'],
  ['loss', 'کمترین از‌دست‌رفت'],
  ['stability', 'پایدارترین'],
  ['boot', 'سریع‌ترین برقراری'],
  ['fav', 'موردعلاقه‌ها'],
  ['recent', 'اخیرا استفاده‌شده'],
  ['country', 'کشور'],
  ['name', 'نام'],
];

export const PHASE_SHORT = {
  boot: 'راه‌اندازی تونل…',
  reach: 'بررسی دسترسی…',
  handshake: 'دست‌دادن TLS…',
  probe: 'سنجش تاخیر…',
  warmup: 'گرم‌کردن تونل…',
  download: 'سنجش دانلود…',
  upload: 'سنجش آپلود…',
};

export const fmtMs = (v) => (v == null ? '—' : `${v}ms`);
export const fmtPct = (v) => (v == null ? '—' : `${v}٪`);
export const mbps = (bps) => (bps == null ? '—' : `${((bps * 8) / 1e6).toFixed(1)} Mb`);

export function msTone(v) {
  if (v == null) return 'na';
  if (v < 0) return 'bad';
  if (v < 150) return 'good';
  if (v < 400) return 'mid';
  return 'bad';
}

export function fmtEta(ms) {
  if (ms == null) return null;
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `~${s} ثانیه`;
  return `~${Math.ceil(s / 60)} دقیقه`;
}

// ---- persisted finder preferences ----
//
// Mode, priority and sort survive a close/reopen: choosing "gaming priority,
// sort by jitter" and losing it to a defaults reset every Ctrl+K made the
// choices feel like they didn't matter. Versioned key, try/catch around
// access, same convention as every other localStorage pocket in the app.

const PREFS_KEY = 'soul.finder.prefs.v1';
const PREFS_DEFAULTS = { mode: 'real', priority: 'balanced', sortBy: 'score' };

export function loadPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY));
    return { ...PREFS_DEFAULTS, ...(raw || {}) };
  } catch {
    return { ...PREFS_DEFAULTS };
  }
}

export function savePrefs(prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch { /* quota/private mode -- prefs just won't survive a restart */ }
}

// ---- recent searches ----

const RECENT_KEY = 'soul.finder.recent.v1';

export function loadRecent() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; } catch { return []; }
}

export function saveRecent(list) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 8))); } catch { /* ignore */ }
}
