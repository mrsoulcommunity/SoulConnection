'use strict';
const { getText, getJson } = require('./http.cjs');

// ---------------------------------------------------------------------------
// Where an update comes from.
//
// electron-builder already publishes `latest.yml` next to every release
// artifact -- it carries the version, the artifact filename, its exact byte
// size and its SHA-512. That file is the manifest this updater reads, so the
// release pipeline stays exactly as it is (`npm run dist:publish`) and there
// is nothing extra to maintain by hand.
//
// Every URL is built off `releases/latest/download/...` rather than a version
// tag. The tag naming convention is then not something this code has to be
// right about, and the manifest and the binary are guaranteed to come from the
// same release -- if a newer one lands between the two requests, the SHA-512
// check catches the mismatch and the download simply restarts.
// ---------------------------------------------------------------------------

const FALLBACK_REPO = { owner: 'mrsoulcommunity', repo: 'SoulConnection' };

// package.json is always inside the asar, so the publish target stays a single
// source of truth shared with electron-builder instead of being duplicated.
function publishTarget() {
  try {
    const pkg = require('../../../package.json');
    const publish = pkg && pkg.build && pkg.build.publish;
    const list = Array.isArray(publish) ? publish : publish ? [publish] : [];
    const gh = list.find((p) => p && p.provider === 'github' && p.owner && p.repo);
    if (gh) return { owner: gh.owner, repo: gh.repo };
  } catch { /* fall through to the constant below */ }
  return FALLBACK_REPO;
}

function releaseBase() {
  const { owner, repo } = publishTarget();
  return `https://github.com/${owner}/${repo}/releases/latest/download`;
}

function apiLatestUrl() {
  const { owner, repo } = publishTarget();
  return `https://api.github.com/repos/${owner}/${repo}/releases/latest`;
}

// ---- version comparison ----------------------------------------------------

// Semver-shaped comparison, minus the parts a Windows desktop app never uses.
// A prerelease sorts below its own release (1.2.0-beta < 1.2.0) so a user on a
// beta is still offered the final build.
function parseVersion(value) {
  const m = String(value || '').trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!m) return null;
  return {
    parts: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] ? m[4].split('.') : null,
  };
}

function comparePre(a, b) {
  if (!a && !b) return 0;
  if (!a) return 1;  // a release outranks any prerelease
  if (!b) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x) ? Number(x) : null;
    const ny = /^\d+$/.test(y) ? Number(y) : null;
    if (nx !== null && ny !== null) {
      if (nx !== ny) return nx < ny ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0; // unparseable -> "not newer", never offer a mystery build
  for (let i = 0; i < 3; i += 1) {
    if (pa.parts[i] !== pb.parts[i]) return pa.parts[i] < pb.parts[i] ? -1 : 1;
  }
  return comparePre(pa.pre, pb.pre);
}

// ---- latest.yml ------------------------------------------------------------

function stripQuotes(v) {
  const s = String(v).trim();
  if (s.length >= 2 && ((s[0] === "'" && s.endsWith("'")) || (s[0] === '"' && s.endsWith('"')))) {
    return s.slice(1, -1);
  }
  return s;
}

// A deliberately tiny parser for the exact shape electron-builder emits:
//
//   version: 1.2.0
//   files:
//     - url: setup.exe
//       sha512: <base64>
//       size: 94371840
//   path: setup.exe
//   sha512: <base64>
//   releaseDate: '2026-01-01T00:00:00.000Z'
//
// Pulling in a YAML dependency to read five scalars would be a far larger
// surface than the file it parses.
function parseLatestYml(text) {
  const top = {};
  const files = [];
  let inFiles = false;
  let current = null;

  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    let line = raw.trim();

    if (indent === 0) {
      inFiles = false;
      current = null;
      if (line === 'files:') { inFiles = true; continue; }
      const m = line.match(/^([\w-]+):\s*(.*)$/);
      if (m) top[m[1]] = stripQuotes(m[2]);
      continue;
    }

    if (!inFiles) continue;
    if (line.startsWith('- ')) {
      current = {};
      files.push(current);
      line = line.slice(2).trim();
    }
    if (!current) continue;
    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (m) current[m[1]] = stripQuotes(m[2]);
  }

  top.files = files;
  return top;
}

function buildManifest(yml) {
  const version = stripQuotes(yml.version || '');
  if (!parseVersion(version)) throw new Error('اطلاعات نسخه‌ی جدید ناقص بود');

  // Prefer the entry in `files` (it is the one carrying size + hash); fall back
  // to the legacy top-level `path` for older manifests.
  const file = (yml.files || []).find((f) => f && /\.exe$/i.test(f.url || '')) || null;
  const assetName = (file && file.url) || yml.path;
  if (!assetName) throw new Error('فایل نصب نسخه‌ی جدید در سرور پیدا نشد');

  const size = Number((file && file.size) || 0) || null;
  const sha512 = (file && file.sha512) || yml.sha512 || null;

  return {
    version,
    assetName: decodeURIComponent(assetName),
    // `assetName` is already percent-encoded in the manifest, so it is used
    // verbatim in the URL.
    url: `${releaseBase()}/${assetName}`,
    size,
    sha512,
    releaseDate: yml.releaseDate || null,
    notes: '',
  };
}

// Release notes are a nice-to-have on top of a manifest that is already
// complete, so they are fetched separately and a failure (rate limit, offline
// API, private repo) never blocks an update.
async function fetchNotes() {
  try {
    const release = await getJson(apiLatestUrl(), { timeoutMs: 8000 });
    return {
      notes: typeof release.body === 'string' ? release.body.trim().slice(0, 4000) : '',
      publishedAt: release.published_at || null,
      title: release.name || '',
    };
  } catch {
    return { notes: '', publishedAt: null, title: '' };
  }
}

async function fetchManifest({ timeoutMs = 15000 } = {}) {
  const text = await getText(`${releaseBase()}/latest.yml`, { timeoutMs });
  return buildManifest(parseLatestYml(text));
}

module.exports = {
  fetchManifest,
  fetchNotes,
  compareVersions,
  parseVersion,
  parseLatestYml,
  buildManifest,
  publishTarget,
};
