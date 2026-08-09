'use strict';
const fs = require('fs');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { openStream } = require('./http.cjs');

// ---------------------------------------------------------------------------
// The download itself: resumable, verified, and honest about its speed.
//
// Three properties matter here and none of them come for free:
//
//   * Resume. The file lands as "<name>.part" and is only renamed to its real
//     name once the SHA-512 matches. A quit, a crash or a dropped connection
//     therefore costs nothing -- the next attempt sends a Range header and
//     continues from the byte it stopped on.
//   * Verification. The hash from latest.yml is checked before the file is
//     ever presented as installable. A truncated or tampered installer is
//     deleted rather than handed to the user.
//   * Real speed. Progress is sampled on a fixed timer over a short sliding
//     window, not derived from "bytes so far / time since start". The average
//     since start is a lie the moment the connection changes pace, and it can
//     never fall back to zero when a transfer stalls.
// ---------------------------------------------------------------------------

const PROGRESS_INTERVAL_MS = 200;
const SPEED_WINDOW_MS = 3000;
const IDLE_TIMEOUT_MS = 35000;
const CONNECT_TIMEOUT_MS = 25000;

// Sliding-window rate meter. Samples are pushed by the progress timer (not by
// the data events) so a stalled transfer decays towards zero instead of
// freezing at whatever it was doing when the bytes stopped.
class SpeedMeter {
  constructor(windowMs = SPEED_WINDOW_MS) {
    this.windowMs = windowMs;
    this.samples = [];
  }

  push(totalBytes, now = Date.now()) {
    this.samples.push({ t: now, b: totalBytes });
    const cutoff = now - this.windowMs;
    while (this.samples.length > 2 && this.samples[0].t < cutoff) this.samples.shift();
  }

  rate() {
    if (this.samples.length < 2) return 0;
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const seconds = (last.t - first.t) / 1000;
    if (seconds <= 0.05) return 0;
    return Math.max(0, (last.b - first.b) / seconds);
  }
}

function unlinkQuietly(file) {
  try { fs.unlinkSync(file); } catch { /* already gone, or locked by a scanner */ }
}

function fileSize(file) {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() ? stat.size : 0;
  } catch {
    return 0;
  }
}

// Hashes a file that is already on disk. Used both to fold a resumed .part
// into the running hash and to re-verify an installer left over from a
// previous session before offering it as ready to install.
function hashFile(file, hash) {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
}

async function verifyFile(file, { size, sha512 }) {
  if (size && fileSize(file) !== size) return false;
  if (!sha512) return fileSize(file) > 0;
  const hash = crypto.createHash('sha512');
  try {
    await hashFile(file, hash);
  } catch {
    return false;
  }
  return hash.digest('base64') === sha512;
}

class Download extends EventEmitter {
  constructor({ url, destPath, size = null, sha512 = null }) {
    super();
    this.url = url;
    this.destPath = destPath;
    this.partPath = `${destPath}.part`;
    this.expectedSize = size;
    this.sha512 = sha512;

    this.cancelled = false;
    this.transferred = 0;
    this.total = size || 0;
    this.meter = new SpeedMeter();

    this._req = null;
    this._res = null;
    this._out = null;
    this._timer = null;
    this._idleAt = 0;
  }

  cancel() {
    if (this.cancelled) return;
    this.cancelled = true;
    this._stopTimer();
    // The .part file is deliberately left behind -- a cancel is "not now",
    // not "throw away the 60 MB you already have".
    try { if (this._req) this._req.destroy(); } catch { /* already closed */ }
    try { if (this._res) this._res.destroy(); } catch { /* already closed */ }
    try { if (this._out) this._out.destroy(); } catch { /* already closed */ }
    // Settle here rather than waiting for a stream event: destroying a
    // response mid-body emits 'close', never 'end', so the pipe would never
    // finish the write stream and the promise would hang forever.
    this._settleCancelled();
  }

  _emitProgress(force = false) {
    const now = Date.now();
    this.meter.push(this.transferred, now);
    const bytesPerSecond = Math.round(this.meter.rate());
    const total = this.total || this.expectedSize || 0;
    const remaining = total ? Math.max(0, total - this.transferred) : 0;
    this.emit('progress', {
      transferred: this.transferred,
      total,
      percent: total ? Math.min(100, (this.transferred / total) * 100) : 0,
      bytesPerSecond,
      // Only claim an ETA once the rate has settled enough to mean something.
      etaSeconds: bytesPerSecond > 1024 && remaining ? Math.round(remaining / bytesPerSecond) : null,
      force,
    });
  }

  _startTimer() {
    this._stopTimer();
    this._idleAt = Date.now();
    this._timer = setInterval(() => {
      this._emitProgress();
      if (Date.now() - this._idleAt > IDLE_TIMEOUT_MS) {
        const err = new Error('دانلود متوقف شد — پاسخی از سرور نرسید');
        err.retriable = true;
        this._fail(err);
      }
    }, PROGRESS_INTERVAL_MS);
  }

  _stopTimer() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  _fail(err) {
    this._stopTimer();
    try { if (this._req) this._req.destroy(); } catch { /* already closed */ }
    try { if (this._res) this._res.destroy(); } catch { /* already closed */ }
    if (this._reject) {
      const reject = this._reject;
      this._resolve = null;
      this._reject = null;
      reject(err);
    }
  }

  // Resolves with { path, resumedFrom, reused } or rejects. `reused` means the
  // bytes were already on disk and nothing had to be fetched.
  async start() {
    // A finished installer from an earlier session is worth far more than a
    // fresh download -- but only once it has been proven intact.
    if (fileSize(this.destPath) > 0) {
      this.emit('verifying');
      if (await verifyFile(this.destPath, { size: this.expectedSize, sha512: this.sha512 })) {
        this.transferred = fileSize(this.destPath);
        this.total = this.transferred;
        this._emitProgress(true);
        return { path: this.destPath, resumedFrom: 0, reused: true };
      }
      unlinkQuietly(this.destPath);
    }
    if (this.cancelled) throw Object.assign(new Error('لغو شد'), { cancelled: true });

    const hash = crypto.createHash('sha512');
    let resumeFrom = fileSize(this.partPath);

    // A .part bigger than the finished file can only be junk from a different
    // release that happened to share the name.
    if (this.expectedSize && resumeFrom >= this.expectedSize) {
      unlinkQuietly(this.partPath);
      resumeFrom = 0;
    }
    if (resumeFrom > 0) {
      try {
        await hashFile(this.partPath, hash);
      } catch {
        unlinkQuietly(this.partPath);
        resumeFrom = 0;
      }
    }

    return this._run(hash, resumeFrom);
  }

  _run(hash, resumeFromInput) {
    let resumeFrom = resumeFromInput;

    return new Promise((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;

      const headers = resumeFrom > 0 ? { Range: `bytes=${resumeFrom}-` } : {};

      openStream(this.url, {
        headers,
        timeoutMs: CONNECT_TIMEOUT_MS,
        onRequest: (req) => { this._req = req; },
      }).then(({ res, status }) => {
        if (this.cancelled) {
          res.destroy();
          return this._settleCancelled();
        }

        // Asked to resume and got a fresh 200 instead of a 206: the server
        // ignored the Range header, so the body starts at byte zero and the
        // partial hash is now meaningless.
        if (resumeFrom > 0 && status !== 206) {
          hash = crypto.createHash('sha512');
          resumeFrom = 0;
          unlinkQuietly(this.partPath);
        }

        const contentLength = Number(res.headers['content-length'] || 0);
        this.total = this.expectedSize || (contentLength ? resumeFrom + contentLength : 0);
        this.transferred = resumeFrom;
        this._res = res;

        // Seed the meter at the resume point so the first samples measure this
        // session's throughput, not a jump of however many bytes were already
        // on disk.
        this.meter = new SpeedMeter();
        this._emitProgress(true);
        this._startTimer();

        const out = fs.createWriteStream(this.partPath, { flags: resumeFrom > 0 ? 'a' : 'w' });
        this._out = out;

        res.on('data', (chunk) => {
          this.transferred += chunk.length;
          this._idleAt = Date.now();
          hash.update(chunk);
        });

        res.on('error', (err) => {
          out.destroy();
          if (this.cancelled) return this._settleCancelled();
          this._fail(Object.assign(err, { retriable: true }));
        });

        // A connection that dies without an error event still has to be caught:
        // `res.complete` is false when the body stopped short of Content-Length,
        // and the bytes already written are perfectly good to resume from.
        res.on('close', () => {
          if (this.cancelled || res.complete) return;
          out.destroy();
          this._fail(Object.assign(new Error('اتصال در میانه‌ی دانلود قطع شد'), { retriable: true }));
        });

        out.on('error', (err) => {
          res.destroy();
          this._fail(new Error(`نوشتن فایل به‌روزرسانی ممکن نبود: ${err.message}`));
        });

        out.on('close', async () => {
          this._stopTimer();
          if (this.cancelled) return this._settleCancelled();
          if (!this._reject) return; // already failed and settled

          try {
            const written = fileSize(this.partPath);

            // A stream that ends early looks exactly like a successful finish
            // at this layer, so the size is the first thing checked.
            if (this.expectedSize && written !== this.expectedSize) {
              throw Object.assign(
                new Error('دانلود ناقص بود'),
                { retriable: true }
              );
            }
            if (this.sha512 && hash.digest('base64') !== this.sha512) {
              // A corrupt body poisons every resume attempt after it, so the
              // partial file has to go.
              unlinkQuietly(this.partPath);
              throw Object.assign(
                new Error('فایل دانلودشده معتبر نبود'),
                { retriable: true }
              );
            }

            this.emit('verifying');
            unlinkQuietly(this.destPath);
            fs.renameSync(this.partPath, this.destPath);
            this.transferred = written;
            this.total = written;
            this._emitProgress(true);

            const done = this._resolve;
            this._resolve = null;
            this._reject = null;
            done({ path: this.destPath, resumedFrom: resumeFrom, reused: false });
          } catch (err) {
            this._fail(err);
          }
        });

        res.pipe(out);
      }).catch((err) => {
        if (this.cancelled) return this._settleCancelled();
        // Anything short of "the server told us this file does not exist" is
        // worth another attempt.
        this._fail(Object.assign(err, { retriable: err.statusCode !== 404 }));
      });
    });
  }

  _settleCancelled() {
    this._stopTimer();
    if (this._reject) {
      const reject = this._reject;
      this._resolve = null;
      this._reject = null;
      reject(Object.assign(new Error('لغو شد'), { cancelled: true }));
    }
  }
}

module.exports = { Download, verifyFile, SpeedMeter };
