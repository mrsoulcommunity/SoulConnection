'use strict';
// ---------------------------------------------------------------------------
// Adaptive Shield: the catalogue of anti-DPI transport treatments.
//
// A censor's DPI does not read the payload -- it cannot -- so it decides from
// the *shape* of the first few packets. The TLS ClientHello is the richest
// target: it arrives in one predictable write, early, and carries the SNI in
// clear text. Slicing that write into pieces means the censor never sees a
// whole ClientHello in a single packet, and a matcher that expects one has
// nothing to match on. Injecting unrelated noise ahead of the handshake
// attacks the same decision from the other side: it pollutes whatever
// statistical fingerprint the classifier accumulated.
//
// Both are already in the xray binary this app ships (Freedom's `fragment` and
// `noises`, reached through sockopt.dialerProxy). Neither has ever been used
// here, and every other client exposes them as a switch the user is expected
// to guess at.
//
// The point of listing them as named profiles is that guessing is exactly what
// we want to stop doing. Which treatment works is a property of the network
// the user is sitting on -- their ISP, that day, that DPI ruleset -- and it is
// measurable. tuner.cjs measures it; this file only says what is on the menu.
//
// Ordering matters. `off` is first because a network that does not need any of
// this should not pay for it: fragmentation costs round trips, and noise costs
// bandwidth. The tuner only prefers a treatment that measurably beats plain.
// ---------------------------------------------------------------------------

// `settings` is spliced verbatim into a Freedom outbound. An empty object
// means "dial normally", which is what makes `off` a real participant in the
// race rather than a special case the tuner has to know about.
const PROFILES = [
  {
    key: 'off',
    label: 'بدون تغییر',
    hint: 'اتصال مستقیم و بدون دستکاری — سریع‌ترین حالت وقتی شبکه سخت‌گیر نیست',
    settings: null,
  },
  {
    key: 'tlshello-fine',
    label: 'برش ریز TLS',
    hint: 'ClientHello به تکه‌های کوچک شکسته می‌شود؛ مؤثرترین حالت مقابل فیلتر SNI',
    settings: {
      fragment: { packets: 'tlshello', length: '10-30', interval: '10-20' },
    },
  },
  {
    key: 'tlshello-wide',
    label: 'برش درشت TLS',
    hint: 'تکه‌های بزرگ‌تر و کندی کمتر؛ وقتی برش ریز اتصال را کُند می‌کند',
    settings: {
      fragment: { packets: 'tlshello', length: '100-200', interval: '10-20' },
    },
  },
  {
    key: 'stream',
    label: 'برش جریان',
    hint: 'سه نوشتِ اول TCP بریده می‌شود — برای شبکه‌هایی که فقط TLS را نمی‌بینند',
    settings: {
      fragment: { packets: '1-3', length: '10-30', interval: '5-15' },
    },
  },
  {
    key: 'noise',
    label: 'تزریق نویز',
    hint: 'بسته‌های تصادفی پیش از دست‌دادن ارسال می‌شود تا الگوی آماری به هم بریزد',
    settings: {
      noises: [{ type: 'rand', packet: '50-100', delay: '10-20' }],
    },
  },
  {
    key: 'combo',
    label: 'برش + نویز',
    hint: 'سنگین‌ترین حالت؛ وقتی DPI هم شکل بسته و هم رفتار جریان را می‌سنجد',
    settings: {
      fragment: { packets: 'tlshello', length: '40-60', interval: '5-10' },
      noises: [{ type: 'rand', packet: '100-200', delay: '5-10' }],
    },
  },
];

const BY_KEY = new Map(PROFILES.map((p) => [p.key, p]));
const DEFAULT_KEY = 'off';

function getProfile(key) {
  return BY_KEY.get(key) || null;
}

function isKnown(key) {
  return BY_KEY.has(key);
}

// The Freedom outbound a shielded connection dials through, or null when the
// profile asks for nothing (so the caller emits no extra outbound at all).
const DIALER_TAG = 'shield-dialer';

function dialerOutbound(key) {
  const profile = getProfile(key);
  if (!profile || !profile.settings) return null;
  return {
    tag: DIALER_TAG,
    protocol: 'freedom',
    settings: { ...profile.settings },
  };
}

// Fragmentation only ever touches the bytes the client writes first, so a
// treatment is meaningless for a transport whose handshake xray does not
// drive as a plain TLS write. Shadowsocks carries no TLS record at all, and
// the `off` profile is always applicable.
function appliesTo(profileObj) {
  if (!profileObj) return false;
  return profileObj.protocol !== 'shadowsocks';
}

module.exports = { PROFILES, DEFAULT_KEY, DIALER_TAG, getProfile, isKnown, dialerOutbound, appliesTo };
