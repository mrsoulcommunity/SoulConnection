import React, { useEffect, useState } from 'react';
import Icon from './Icon.jsx';
import {
  formatSpeed, formatEta, formatProgress, updatePercent, countdownSeconds,
} from '../utils/updateFormat.js';

// ---- Update card ----------------------------------------------------------
//
// Pinned to the bottom of the sidebar, just above "افزودن کانفیگ". Settings has
// the full panel, but a release has to reach someone who never opens Settings,
// so it surfaces here -- in the corner the eye already returns to.
//
// The card is the same object all the way through: it starts as an offer, turns
// into a live progress readout, then into a countdown, then into a handoff. It
// never swaps itself for a different element and never asks a second question,
// which is what makes the whole update feel like one continuous motion rather
// than a sequence of dialogs.
//
// While downloading it shows the three numbers that actually answer "how long
// is this going to take": current speed, how much has landed, and the estimate.
// The speed is measured over a short sliding window in the main process, so it
// tracks the connection in real time instead of averaging away every stall.

function StatCell({ label, value, wide }) {
  return (
    <div className={`uc-stat ${wide ? 'wide' : ''}`}>
      <span className="uc-stat-label">{label}</span>
      <span className="uc-stat-value mono">{value}</span>
    </div>
  );
}

function UpdateCard({ update, onDownload, onInstall, onCancelDownload, onCancelAuto, onDismiss }) {
  const [now, setNow] = useState(Date.now());
  const seconds = countdownSeconds(update, now);
  const armed = seconds !== null;

  // Only ticks while a countdown is on screen.
  useEffect(() => {
    if (!update?.autoInstallAt) return undefined;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [update?.autoInstallAt]);

  if (!update) return null;

  const { status, version } = update;
  const pct = updatePercent(update);
  const downloading = status === 'downloading';
  const verifying = status === 'verifying';
  const installing = status === 'installing';
  const ready = status === 'ready';
  const failed = status === 'error';
  const busy = downloading || verifying || installing;

  const tone = failed ? 'failed' : ready ? 'ready' : busy ? 'busy' : 'offer';

  return (
    <div className={`update-card ${tone}`}>
      <div className="uc-head">
        <span className="uc-glyph">
          {installing || verifying
            ? <span className="icon-spinner" aria-hidden="true" />
            : <Icon name={failed ? 'info' : ready ? 'check' : 'download'} size={15} />}
        </span>

        <div className="uc-title-wrap">
          <span className="uc-title">
            {failed ? 'به‌روزرسانی ناموفق بود' : `نسخه‌ی ${version || ''}`}
          </span>
          <span className="uc-sub">
            {failed && (update.error?.message || 'دوباره تلاش کنید')}
            {!failed && installing && 'در حال نصب… برنامه بسته و دوباره باز می‌شود'}
            {!failed && verifying && 'بررسی سلامت فایل…'}
            {!failed && downloading && 'در حال دانلود نسخه‌ی جدید'}
            {!failed && ready && (armed
              ? `نصب خودکار تا ${seconds} ثانیه‌ی دیگر`
              : 'آماده‌ی نصب — هر وقت خواستید')}
            {!failed && !busy && !ready && 'آماده‌ی دانلود و نصب خودکار'}
          </span>
        </div>

        {!busy && !armed && (
          <button className="uc-dismiss" onClick={onDismiss} title="بعداً یادآوری کن" type="button">
            <Icon name="close" size={12} />
          </button>
        )}
      </div>

      {/* One bar, three meanings: measured progress while bytes are arriving,
          an indeterminate sweep while the hash is being checked, and a
          draining countdown while auto-install is pending. */}
      {(downloading || verifying || armed) && (
        <div
          className={`uc-track ${verifying ? 'sweep' : ''} ${armed ? 'countdown' : ''}`}
          role="progressbar"
          aria-valuenow={verifying ? undefined : pct}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          {/* scaleX rather than width -- see the note on .uc-fill in index.css. */}
          <div
            className="uc-fill"
            style={{
              transform: `scaleX(${verifying
                ? 1
                : armed
                  ? seconds / ((update.autoInstallDelayMs || 15000) / 1000)
                  : pct / 100})`,
            }}
          />
        </div>
      )}

      {downloading && (
        <div className="uc-stats">
          <StatCell label="سرعت" value={formatSpeed(update.bytesPerSecond)} />
          <StatCell label="دریافت‌شده" value={formatProgress(update)} wide />
          <StatCell label="زمان باقی‌مانده" value={formatEta(update.etaSeconds) || '—'} />
        </div>
      )}

      <div className="uc-actions">
        {downloading && (
          <>
            <span className="uc-pct mono">{pct}٪</span>
            <button className="uc-btn ghost" onClick={onCancelDownload} type="button">انصراف</button>
          </>
        )}

        {ready && armed && (
          <>
            <button className="uc-btn primary" onClick={onInstall} type="button">همین حالا نصب کن</button>
            <button className="uc-btn ghost" onClick={onCancelAuto} type="button">بعداً</button>
          </>
        )}

        {ready && !armed && (
          <button className="uc-btn primary" onClick={onInstall} type="button">
            <Icon name="refresh" size={13} />
            نصب و راه‌اندازی مجدد
          </button>
        )}

        {failed && (
          <button className="uc-btn primary" onClick={onDownload} type="button">
            <Icon name="refresh" size={13} />
            تلاش دوباره
          </button>
        )}

        {!busy && !ready && !failed && (
          <button className="uc-btn primary" onClick={onDownload} type="button">
            <Icon name="download" size={13} />
            دانلود و نصب
          </button>
        )}
      </div>
    </div>
  );
}

// Sits in the sidebar for the whole life of an offer, through every unrelated
// re-render App does. Its own progress arrives on `update`, so anything that
// leaves that prop untouched has nothing to say to this card.
export default React.memo(UpdateCard);
