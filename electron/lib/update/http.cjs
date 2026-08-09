'use strict';
const http = require('http');
const https = require('https');

const USER_AGENT = 'SoulConnection-Updater';

// The update path deliberately does NOT reuse lib/fetchText.cjs: that helper
// buffers a whole response into a string, and an installer is ~90 MB. Here we
// need the raw stream, the status code (206 vs 200 decides whether a resume
// was honoured), and a handle on the live request so a cancel can kill it
// mid-flight.
//
// Redirects are followed by hand rather than by a library because a GitHub
// release asset bounces to objects.githubusercontent.com with a signed query
// string, and the Range header has to survive that hop -- otherwise every
// "resume" silently restarts from byte zero.
function openStream(url, { headers = {}, timeoutMs = 20000, redirectsLeft = 6, onRequest } = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      return reject(new Error('نشانی سرور به‌روزرسانی نامعتبر است'));
    }
    if (target.protocol !== 'https:' && target.protocol !== 'http:') {
      return reject(new Error('فقط نشانی http/https پشتیبانی می‌شود'));
    }

    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.get(
      target,
      { headers: { 'User-Agent': USER_AGENT, ...headers }, timeout: timeoutMs },
      (res) => {
        const status = res.statusCode || 0;

        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location && redirectsLeft > 0) {
          res.resume(); // drain, or the socket is never released back to the pool
          const next = new URL(res.headers.location, target).toString();
          openStream(next, { headers, timeoutMs, redirectsLeft: redirectsLeft - 1, onRequest })
            .then(resolve, reject);
          return;
        }

        if (status < 200 || status >= 300) {
          res.resume();
          const err = new Error(`سرور به‌روزرسانی پاسخ ${status} داد`);
          err.statusCode = status;
          return reject(err);
        }

        resolve({ res, status, url: target.toString() });
      }
    );

    // Handed out for every hop, so a caller holding "the current request" can
    // always destroy the one that is actually open.
    if (onRequest) onRequest(req);

    req.on('timeout', () => req.destroy(new Error('اتصال به سرور به‌روزرسانی برقرار نشد')));
    req.on('error', reject);
  });
}

// Small-payload helper for manifests. Capped so a wrong URL that happens to
// serve something enormous can't be read into memory.
async function getText(url, { timeoutMs = 15000, headers, maxBytes = 512 * 1024 } = {}) {
  const { res } = await openStream(url, { timeoutMs, headers });
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    res.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        res.destroy();
        reject(new Error('پاسخ سرور به‌روزرسانی بیش از حد بزرگ بود'));
        return;
      }
      chunks.push(c);
    });
    res.on('error', reject);
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

async function getJson(url, opts = {}) {
  const text = await getText(url, {
    ...opts,
    headers: { Accept: 'application/vnd.github+json', ...(opts.headers || {}) },
  });
  return JSON.parse(text);
}

module.exports = { openStream, getText, getJson, USER_AGENT };
