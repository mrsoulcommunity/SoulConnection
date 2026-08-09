'use strict';
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Where a downloaded update lives.
//
// Not in a hidden per-user cache: the folder is called "Updates" and it sits
// next to the application itself, because the file in it is something the user
// is explicitly allowed to keep and run by hand. If auto-install is off -- or
// they cancel it -- the installer is simply still there, named after its
// version, ready to double-click.
//
// Falling back to userData matters for the one case where the app directory
// is not writable: someone pointing the installer at Program Files. Downloads
// keep working there, just out of the way.
// ---------------------------------------------------------------------------

const FOLDER_NAME = 'Updates';
const INSTALLER_PREFIX = 'SoulConnection-Setup-';
const PART_SUFFIX = '.part';
const STALE_PART_MS = 7 * 24 * 3600 * 1000;

const README = [
  'Soul Connection — پوشه‌ی به‌روزرسانی',
  '',
  'فایل نصب نسخه‌ی جدید اینجا دانلود می‌شود.',
  'اگر نصب خودکار را لغو کنید، همین فایل باقی می‌ماند و هر وقت خواستید',
  'می‌توانید روی آن دو بار کلیک کنید تا نسخه‌ی جدید نصب شود. تنظیمات،',
  'سرورها و ساب‌اسکریپشن‌های شما دست‌نخورده باقی می‌مانند.',
  '',
  'فایل‌های با پسوند .part دانلودهای نیمه‌تمام هستند و خودکار پاک می‌شوند.',
  '',
  '---',
  '',
  'This folder holds the downloaded installer for the next version.',
  'If you cancel the automatic install, the file stays here — run it',
  'whenever you like. Your servers and settings are preserved.',
  '',
].join('\r\n');

function canWrite(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.w${process.pid}`);
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

// Portable builds keep everything beside the exe (same rule main.cjs uses for
// userData), an installed build uses its own program folder, and userData is
// the always-writable last resort.
function candidates(app) {
  const list = [];
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    list.push(path.join(process.env.PORTABLE_EXECUTABLE_DIR, FOLDER_NAME));
  } else if (app.isPackaged) {
    list.push(path.join(path.dirname(app.getPath('exe')), FOLDER_NAME));
  }
  list.push(path.join(app.getPath('userData'), FOLDER_NAME));
  return list;
}

let resolved = null;

function updatesDir(app) {
  if (resolved) return resolved;
  const list = candidates(app);
  resolved = list.find(canWrite) || list[list.length - 1];
  try {
    fs.mkdirSync(resolved, { recursive: true });
    const readme = path.join(resolved, 'README.txt');
    if (!fs.existsSync(readme)) fs.writeFileSync(readme, README, 'utf8');
  } catch { /* the folder is still usable for reads; a write will report the real error */ }
  return resolved;
}

function installerName(version) {
  return `${INSTALLER_PREFIX}${version}.exe`;
}

function installerPath(app, version) {
  return path.join(updatesDir(app), installerName(version));
}

function isOurArtifact(name) {
  return name.startsWith(INSTALLER_PREFIX) && (name.endsWith('.exe') || name.endsWith(`.exe${PART_SUFFIX}`));
}

// Housekeeping, so the folder never grows without bound: once a version is
// downloaded, every older installer we put there is redundant. Only files this
// updater created are ever touched.
function prune(app, keepVersion) {
  const dir = updatesDir(app);
  const keep = keepVersion ? installerName(keepVersion) : null;
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }

  for (const name of entries) {
    if (!isOurArtifact(name)) continue;
    if (keep && (name === keep || name === `${keep}${PART_SUFFIX}`)) continue;
    const full = path.join(dir, name);
    try {
      // An abandoned .part is kept for a while: the user may simply have quit
      // mid-download, and resuming beats re-fetching 90 MB.
      if (name.endsWith(PART_SUFFIX) && !keep) {
        const age = Date.now() - fs.statSync(full).mtimeMs;
        if (age < STALE_PART_MS) continue;
      }
      fs.unlinkSync(full);
    } catch { /* locked by a scanner; it will be retried on the next prune */ }
  }
}

function existingInstaller(app, version) {
  const file = installerPath(app, version);
  try {
    const stat = fs.statSync(file);
    if (stat.isFile() && stat.size > 0) return { path: file, size: stat.size };
  } catch { /* not downloaded yet */ }
  return null;
}

module.exports = { updatesDir, installerName, installerPath, prune, existingInstaller, FOLDER_NAME };
