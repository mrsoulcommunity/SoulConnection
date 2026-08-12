// Shared shape + formatting for measured latency.
//
// An entry in App's `pings` map is one of:
//   undefined                          never measured
//   { status: 'measuring', prev }      in flight ('prev' keeps the last good
//                                     value on screen so the row doesn't jump)
//   { status: 'ok',   ms, min, max, avg, jitter, loss, samples, method, ip, at }
//   { status: 'fail', message, at }
//
// `ms` is the MEDIAN of real samples, and `method` says how it was taken:
// 'tunnel' = a full request out to the internet and back through the live
// tunnel, 'tcp' = repeated handshakes to the server with DNS excluded.

export function isMeasuring(entry) {
  return !!entry && entry.status === 'measuring';
}

// The number, or null when there isn't one. Everything that sorts, compares or
// aggregates latency goes through here.
export function pingMs(entry) {
  if (!entry) return null;
  if (entry.status === 'ok' && typeof entry.ms === 'number' && entry.ms >= 0) return entry.ms;
  if (entry.status === 'measuring' && typeof entry.prev === 'number') return entry.prev;
  return null;
}

// Four tiers rather than three: on a real measurement the sub-60ms range is
// common enough (nearby servers, tunnels over a CDN edge) to be worth calling
// out separately from "fine".
export function pingTone(entry) {
  if (isMeasuring(entry)) return 'busy';
  if (!entry) return 'na';
  if (entry.status === 'fail') return 'bad';
  const ms = pingMs(entry);
  if (ms == null) return 'na';
  if (ms < 60) return 'great';
  if (ms < 140) return 'good';
  if (ms < 300) return 'mid';
  return 'bad';
}

// Tone for a bare number (group "best ping" chips, which aggregate rather than
// hold an entry of their own). This is THE latency scale -- nothing anywhere
// else in the app is allowed to invent its own thresholds.
export function toneForMs(ms) {
  if (ms == null) return 'na';
  if (ms < 0) return 'bad';
  if (ms < 60) return 'great';
  if (ms < 140) return 'good';
  if (ms < 300) return 'mid';
  return 'bad';
}

// The same scale, plus the words and the bar count that go with it.
//
// The status rail and the tunnel panel sit one above the other and describe
// the SAME measurement, so they have to agree by construction. They used to
// each carry their own thresholds (150/400 and 80/160/320), which is how 350ms
// came to be amber "متوسط" in the rail and red "ضعیف" in the panel at the same
// instant.
const QUALITY_LABEL = { great: 'عالی', good: 'خوب', mid: 'متوسط', bad: 'ضعیف', na: '—' };
const QUALITY_BARS = { great: 4, good: 3, mid: 2, bad: 1, na: 0 };

export function qualityForMs(ms) {
  const tone = toneForMs(ms);
  // A negative reading is a non-answer, not a very slow answer: it earns the
  // bad tone but no bars and its own wording.
  const noAnswer = typeof ms === 'number' && ms < 0;
  return {
    tone,
    label: noAnswer ? 'بدون پاسخ' : QUALITY_LABEL[tone],
    bars: noAnswer ? 0 : QUALITY_BARS[tone],
  };
}

const AGE = (at) => {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 5) return 'همین الان';
  if (s < 60) return `${s} ثانیه پیش`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} دقیقه پیش` : `${Math.round(m / 60)} ساعت پیش`;
};

// Hover detail. Everything here is measured; nothing is inferred.
export function pingTitle(entry) {
  if (isMeasuring(entry)) return 'در حال اندازه‌گیری پینگ واقعی…';
  if (!entry) return 'برای اندازه‌گیری پینگ واقعی کلیک کن';
  if (entry.status === 'fail') {
    return `${entry.message || 'سرور پاسخی نداد'} — برای تلاش دوباره کلیک کن`;
  }

  const lines = [];
  lines.push(entry.method === 'tunnel'
    ? 'پینگ واقعی از داخل تونل (رفت‌وبرگشت کامل به اینترنت)'
    : 'پینگ واقعی TCP به سرور (بدون زمان DNS)');
  lines.push(`میانه ${entry.ms}ms`);
  if (entry.min != null && entry.max != null) lines.push(`کمینه ${entry.min}ms · بیشینه ${entry.max}ms`);
  if (entry.avg != null) lines.push(`میانگین ${entry.avg}ms`);
  if (entry.jitter != null) lines.push(`نوسان ${entry.jitter}ms`);
  if (entry.loss) lines.push(`اتلاف بسته ${entry.loss}٪`);
  if (Array.isArray(entry.samples)) lines.push(`${entry.samples.length} نمونه`);
  if (entry.ip && entry.ip !== entry.address) lines.push(`IP سرور ${entry.ip}`);
  if (entry.at) lines.push(AGE(entry.at));
  return lines.join('\n');
}

// Turns a raw ping:test reply into an entry. Main answers with ms = -1 when
// nothing responded, which is a failure, not a latency of minus one.
export function toEntry(result) {
  if (!result || typeof result.ms !== 'number' || result.ms < 0) {
    return {
      status: 'fail',
      message: result?.dnsError || result?.message || 'سرور به هیچ‌کدام از نمونه‌ها پاسخ نداد',
      at: Date.now(),
    };
  }
  return { status: 'ok', ...result, at: Date.now() };
}
