import { formatBytes, formatSpeed as bytesPerSecond } from './format.js';

// Shared vocabulary for the two places an update surfaces -- the sidebar card
// and the Settings panel. They render very differently, but they must never
// describe the same state in two different ways.

export const UPDATE_MODE_OPTIONS = [
  {
    value: 'auto',
    label: 'خودکار (پیشنهادی)',
    hint: 'نسخه‌ی جدید خودش دانلود و نصب می‌شود؛ پیش از نصب فرصت لغو دارید',
  },
  {
    value: 'download',
    label: 'فقط دانلود خودکار',
    hint: 'فایل نصب آماده در پوشه‌ی به‌روزرسانی می‌ماند تا خودتان نصب کنید',
  },
  {
    value: 'notify',
    label: 'فقط اطلاع بده',
    hint: 'هیچ چیزی بدون اجازه‌ی شما دانلود نمی‌شود',
  },
];

// Same unit formatting the traffic readout uses, but a stalled transfer has to
// read as "nothing is arriving" rather than a confident "0 B/s".
export function formatSpeed(rate) {
  if (!rate || rate < 1) return '—';
  return bytesPerSecond(rate);
}

// Deliberately coarse: a download's remaining time is an estimate, and
// second-by-second precision on a five-minute transfer only draws the eye to
// how much it wobbles.
export function formatEta(seconds) {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return null;
  if (seconds < 10) return 'چند لحظه';
  if (seconds < 60) return `${Math.round(seconds / 5) * 5} ثانیه`;
  const min = Math.round(seconds / 60);
  if (min < 60) return `${min} دقیقه`;
  const hr = Math.floor(min / 60);
  const rest = min % 60;
  return rest ? `${hr} ساعت و ${rest} دقیقه` : `${hr} ساعت`;
}

export function formatProgress(update) {
  const total = update?.total || update?.size || 0;
  const done = update?.transferred || 0;
  if (!total) return formatBytes(done);
  return `${formatBytes(done)} از ${formatBytes(total)}`;
}

export function updatePercent(update) {
  return Math.min(100, Math.max(0, Math.round(update?.percent || 0)));
}

// Seconds left on the auto-install countdown, or null when none is armed.
export function countdownSeconds(update, now = Date.now()) {
  if (!update?.autoInstallAt) return null;
  return Math.max(0, Math.ceil((update.autoInstallAt - now) / 1000));
}

// One-line summary, used wherever there is only room for a sentence.
export function updateSummary(update) {
  if (!update) return null;
  switch (update.status) {
    case 'checking':
      return 'در حال بررسی…';
    case 'available':
      return update.size
        ? `نسخه‌ی ${update.version} موجود است · ${formatBytes(update.size)}`
        : `نسخه‌ی ${update.version} موجود است`;
    case 'downloading':
      return `در حال دانلود… ${updatePercent(update)}٪`;
    case 'verifying':
      return 'در حال بررسی سلامت فایل…';
    case 'ready':
      return `نسخه‌ی ${update.version} آماده‌ی نصب است`;
    case 'installing':
      return 'در حال نصب… برنامه بسته و دوباره باز می‌شود';
    case 'not-available':
      return 'شما از آخرین نسخه استفاده می‌کنید';
    case 'error':
      return update.error?.message || 'به‌روزرسانی ناموفق بود';
    default:
      return null;
  }
}

// True while the updater owns the flow and a second command would be noise.
export function isUpdateBusy(update) {
  return ['checking', 'downloading', 'verifying', 'installing'].includes(update?.status);
}
