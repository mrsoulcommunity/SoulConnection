'use strict';
const fs = require('fs');
const { EventEmitter } = require('events');
const { shell } = require('electron');

const feed = require('./feed.cjs');
const paths = require('./paths.cjs');
const { Download } = require('./download.cjs');
const { spawnInstaller } = require('./installer.cjs');

// ---------------------------------------------------------------------------
// The update protocol, end to end.
//
// One object owns the whole thing: what version is out there, what is on disk,
// what is being fetched right now, and when -- if ever -- to hand over to the
// installer. The renderer never drives any of that; it receives one immutable
// status snapshot per change and renders it. That is what keeps the UI and the
// real state from ever disagreeing.
//
// The states, in the order they normally occur:
//
//   idle -> checking -> available -> downloading -> verifying -> ready
//                    -> not-available                        -> installing
//
// `error` can replace any of them and always leaves a way forward (retry, or
// the file that is already on disk).
//
// Three policies, chosen by the user in Settings:
//
//   auto      download as soon as a release appears, then install it after a
//             short, clearly visible, cancellable countdown. The default: the
//             user asked for an update system that needs nothing from them.
//   download  fetch it, park it in the Updates folder, install when told.
//   notify    do nothing until asked.
//
// Whatever the policy, the downloaded installer is a real, named file in a
// folder next to the app -- so "I'd rather do it myself later" is always a
// supported ending, not a dead end.
// ---------------------------------------------------------------------------

const FIRST_CHECK_DELAY_MS = 8000;
const CHECK_INTERVAL_MS = 6 * 3600 * 1000;
const AUTO_INSTALL_DELAY_MS = 15000;
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [1500, 4000];

const MODES = new Set(['auto', 'download', 'notify']);

class UpdateManager extends EventEmitter {
  constructor() {
    super();
    this.app = null;
    this.getMode = () => 'auto';
    this.notify = null;
    this.beforeInstall = null;
    this.log = () => {};

    this.state = {
      status: 'idle',
      currentVersion: '',
      version: null,
      notes: '',
      releaseDate: null,
      size: null,
      transferred: 0,
      total: 0,
      percent: 0,
      bytesPerSecond: 0,
      etaSeconds: null,
      filePath: null,
      folder: null,
      canInstall: false,
      autoInstallAt: null,
      autoInstallDelayMs: AUTO_INSTALL_DELAY_MS,
      checkedAt: null,
      error: null,
    };

    this.manifest = null;
    this._checkInFlight = null;
    this._download = null;
    this._downloading = false;
    this._installWhenReady = false;
    this._autoInstallTimer = null;
    this._checkTimer = null;
    this._firstCheckTimer = null;
    this._installing = false;
    // Set when the user cancels the countdown: that decision has to survive
    // until the next release, including the install-on-quit path.
    this._declinedVersion = null;
  }

  configure({ app, getMode, notify, beforeInstall, log }) {
    this.app = app;
    if (getMode) this.getMode = getMode;
    this.notify = notify || null;
    this.beforeInstall = beforeInstall || null;
    if (log) this.log = log;

    // A portable build has no installer to run and a development build must
    // never overwrite itself, so both can download but not install.
    const portable = !!process.env.PORTABLE_EXECUTABLE_DIR;
    this._patch({
      currentVersion: app.getVersion(),
      canInstall: app.isPackaged && !portable,
      folder: paths.updatesDir(app),
    });
  }

  // ---- state ---------------------------------------------------------------

  _patch(partial) {
    this.state = { ...this.state, ...partial };
    this.emit('status', this.getState());
  }

  getState() {
    return { ...this.state };
  }

  mode() {
    const value = this.getMode();
    return MODES.has(value) ? value : 'auto';
  }

  // ---- lifecycle -----------------------------------------------------------

  start() {
    // Sweep leftovers from previous runs before anything else: a .part from a
    // download that was abandoned weeks ago is just occupied disk.
    try { paths.prune(this.app, null); } catch { /* housekeeping is never fatal */ }

    this._firstCheckTimer = setTimeout(() => {
      this.check({ manual: false }).catch(() => {});
    }, FIRST_CHECK_DELAY_MS);

    this._checkTimer = setInterval(() => {
      this.check({ manual: false }).catch(() => {});
    }, CHECK_INTERVAL_MS);
  }

  stop() {
    clearTimeout(this._firstCheckTimer);
    clearInterval(this._checkTimer);
    this._clearAutoInstall();
  }

  // ---- checking ------------------------------------------------------------

  check({ manual = true } = {}) {
    // A manual click while a check is already running should feel like it did
    // something, but must not fire a second request.
    if (this._checkInFlight) return this._checkInFlight;
    if (this._downloading || this._installing) return Promise.resolve(this.getState());

    this._patch({ status: 'checking', error: null });

    this._checkInFlight = (async () => {
      try {
        const manifest = await feed.fetchManifest();
        const newer = feed.compareVersions(this.state.currentVersion, manifest.version) < 0;
        this._patch({ checkedAt: Date.now() });

        if (!newer) {
          this.manifest = null;
          this._patch({
            status: 'not-available',
            version: null,
            notes: '',
            size: null,
            filePath: null,
            autoInstallAt: null,
          });
          return this.getState();
        }

        // A release the user already declined stays declined -- re-arming the
        // countdown every six hours would be nagging, not helping. A *newer*
        // release than the declined one is a fresh decision.
        if (this._declinedVersion && this._declinedVersion !== manifest.version) {
          this._declinedVersion = null;
        }

        this.manifest = manifest;
        const onDisk = paths.existingInstaller(this.app, manifest.version);
        this._patch({
          status: 'available',
          version: manifest.version,
          releaseDate: manifest.releaseDate,
          size: manifest.size,
          total: manifest.size || 0,
          transferred: 0,
          percent: 0,
          bytesPerSecond: 0,
          etaSeconds: null,
          filePath: onDisk ? onDisk.path : null,
          error: null,
        });

        // Notes arrive after the decision is already made, so they never delay
        // the offer -- they just fill in once they land.
        feed.fetchNotes().then(({ notes }) => {
          if (notes && this.manifest && this.manifest.version === manifest.version) {
            this._patch({ notes });
          }
        });

        if (manual === false && this.notify) {
          this.notify(manifest.version);
        }

        const mode = this.mode();
        if (mode === 'auto' || mode === 'download') {
          // Fire and forget: the status stream is how the outcome is reported.
          this.download({ install: mode === 'auto' && this._declinedVersion !== manifest.version })
            .catch(() => {});
        }

        return this.getState();
      } catch (err) {
        this._patch({
          status: 'error',
          error: { message: err.message || String(err), phase: 'check' },
        });
        return this.getState();
      } finally {
        this._checkInFlight = null;
      }
    })();

    return this._checkInFlight;
  }

  // ---- downloading ---------------------------------------------------------

  async download({ install = false } = {}) {
    if (!this.manifest) {
      // "Download" pressed before anything is known: check first, and let the
      // policy in check() take it from there.
      await this.check({ manual: true });
      if (!this.manifest) return this.getState();
    }
    if (this._installing) return this.getState();

    if (this._downloading) {
      // Already running: the only thing a second call can change is whether
      // the finished file should be installed.
      if (install) this._installWhenReady = true;
      return this.getState();
    }

    this._downloading = true;
    this._installWhenReady = !!install;
    const manifest = this.manifest;
    const destPath = paths.installerPath(this.app, manifest.version);

    this._patch({
      status: 'downloading',
      version: manifest.version,
      size: manifest.size,
      total: manifest.size || 0,
      transferred: 0,
      percent: 0,
      bytesPerSecond: 0,
      etaSeconds: null,
      filePath: null,
      autoInstallAt: null,
      error: null,
    });

    let lastError = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const dl = new Download({
        url: manifest.url,
        destPath,
        size: manifest.size,
        sha512: manifest.sha512,
      });
      this._download = dl;

      dl.on('progress', (p) => {
        if (this.state.status !== 'downloading') return;
        this._patch({
          transferred: p.transferred,
          total: p.total,
          percent: p.percent,
          bytesPerSecond: p.bytesPerSecond,
          etaSeconds: p.etaSeconds,
        });
      });
      dl.on('verifying', () => {
        if (this.state.status === 'downloading') this._patch({ status: 'verifying' });
      });

      try {
        const result = await dl.start();
        this._download = null;
        this._downloading = false;
        try { paths.prune(this.app, manifest.version); } catch { /* non-fatal */ }
        this._onReady(result.path, manifest);
        return this.getState();
      } catch (err) {
        this._download = null;
        lastError = err;

        // A cancel is not a failure: the partial file stays on disk and the
        // offer goes back to how it looked before the user pressed download.
        if (err.cancelled) {
          this._downloading = false;
          this._patch({ status: 'available', bytesPerSecond: 0, etaSeconds: null });
          return this.getState();
        }
        if (!err.retriable || attempt === MAX_ATTEMPTS) break;

        this.log(`[update] attempt ${attempt} failed (${err.message}); retrying`);
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS[attempt - 1] || 4000));
      }
    }

    this._downloading = false;
    this._patch({
      status: 'error',
      bytesPerSecond: 0,
      etaSeconds: null,
      error: { message: (lastError && lastError.message) || 'دانلود ناموفق بود', phase: 'download' },
    });
    return this.getState();
  }

  cancelDownload() {
    if (this._download) this._download.cancel();
    this._installWhenReady = false;
    return this.getState();
  }

  _onReady(filePath, manifest) {
    this._patch({
      status: 'ready',
      version: manifest.version,
      filePath,
      percent: 100,
      bytesPerSecond: 0,
      etaSeconds: null,
      error: null,
    });

    if (!this.state.canInstall) return;

    if (this._installWhenReady && this._declinedVersion !== manifest.version) {
      this._armAutoInstall();
    }
  }

  // ---- installing ----------------------------------------------------------

  // The countdown is the whole reason auto-install is safe to have on by
  // default: the app never disappears out from under someone without saying
  // so first, and cancelling is one click.
  _armAutoInstall() {
    this._clearAutoInstall();
    const at = Date.now() + AUTO_INSTALL_DELAY_MS;
    // The window length travels with the deadline so the UI can draw a bar
    // that drains accurately without hard-coding the same number twice.
    this._patch({ autoInstallAt: at, autoInstallDelayMs: AUTO_INSTALL_DELAY_MS });
    this._autoInstallTimer = setTimeout(() => {
      this._autoInstallTimer = null;
      this.install({ auto: true }).catch(() => {});
    }, AUTO_INSTALL_DELAY_MS);
  }

  _clearAutoInstall() {
    if (this._autoInstallTimer) {
      clearTimeout(this._autoInstallTimer);
      this._autoInstallTimer = null;
    }
  }

  cancelAutoInstall() {
    this._clearAutoInstall();
    this._installWhenReady = false;
    this._declinedVersion = this.state.version;
    this._patch({ autoInstallAt: null });
    return this.getState();
  }

  async install({ auto = false } = {}) {
    if (this._installing) return this.getState();
    if (!this.state.canInstall) {
      // Portable / development: the honest outcome is "here is the file".
      this.openFolder();
      return this.getState();
    }

    const filePath = this.state.filePath;
    if (!filePath || !fs.existsSync(filePath)) {
      // Ready-state without a file means it was moved or cleaned up under us.
      this._patch({ status: 'available', filePath: null });
      return this.download({ install: true });
    }

    this._installing = true;
    this._clearAutoInstall();
    this._patch({ status: 'installing', autoInstallAt: null, error: null });

    try {
      // main.cjs tears the tunnel down, restores the system proxy and flushes
      // the store here. The installer replaces the app's files and restarts
      // it, so anything still live at that moment would outlive its owner.
      if (this.beforeInstall) await this.beforeInstall({ auto });
      spawnInstaller(filePath, { silent: true, relaunch: true });
      this.emit('handoff');
      return this.getState();
    } catch (err) {
      this._installing = false;
      this._patch({
        status: 'ready',
        error: { message: err.message || String(err), phase: 'install' },
      });
      return this.getState();
    }
  }

  // Called from the real quit path. An update that is sitting ready and was
  // never declined installs itself while the user is walking away -- the least
  // disruptive moment there is. No relaunch: they asked to close the app.
  installOnQuit() {
    if (!this.state.canInstall) return false;
    if (this.mode() !== 'auto') return false;
    if (this.state.status !== 'ready') return false;
    if (this._installing) return false;
    if (this._declinedVersion === this.state.version) return false;
    const filePath = this.state.filePath;
    if (!filePath || !fs.existsSync(filePath)) return false;

    try {
      spawnInstaller(filePath, { silent: true, relaunch: false });
      this.log('[update] installing on quit');
      return true;
    } catch (err) {
      this.log(`[update] install-on-quit failed: ${err.message}`);
      return false;
    }
  }

  openFolder() {
    const dir = paths.updatesDir(this.app);
    // Reveal the installer itself when there is one -- the user's next action
    // is to run that file, not to browse a folder.
    if (this.state.filePath && fs.existsSync(this.state.filePath)) {
      shell.showItemInFolder(this.state.filePath);
    } else {
      shell.openPath(dir);
    }
    return dir;
  }
}

module.exports = { UpdateManager, MODES };
