'use strict';
const fs = require('fs');
const { spawn } = require('child_process');

// ---------------------------------------------------------------------------
// Handing off to the installer.
//
// The NSIS package electron-builder produces understands three switches that
// together make an update completely hands-free:
//
//   --updated    tells the installer it is replacing an existing install, so
//                it skips the first-run niceties (shortcut prompts, etc.)
//   /S           silent: no window, no clicks, no wizard
//   --force-run  relaunch the app once the files are in place
//
// The child is detached and fully unparented on purpose: it has to outlive the
// process it is about to overwrite. Windows itself keeps the running exe
// locked, which is why the caller quits immediately after this returns.
// ---------------------------------------------------------------------------

function spawnInstaller(filePath, { silent = true, relaunch = true } = {}) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error('فایل نصب پیدا نشد — دوباره دانلود کنید');
  }

  const args = ['--updated'];
  if (silent) args.push('/S');
  if (relaunch) args.push('--force-run');

  const child = spawn(filePath, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return child;
}

module.exports = { spawnInstaller };
