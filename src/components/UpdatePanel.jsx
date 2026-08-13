import React, { useEffect, useState } from 'react';
import Icon from './Icon.jsx';
import { Section } from './settingsPrimitives.jsx';
import { formatBytes } from '../utils/format.js';
import {
  formatSpeed, formatEta, formatProgress, updatePercent, countdownSeconds,
  isUpdateBusy, UPDATE_MODE_OPTIONS,
} from '../utils/updateFormat.js';

// ---- Update panel (Settings ▸ درباره) --------------------------------------
//
// The full account of the update system: which version is installed, what is
// available, exactly where the downloaded installer is sitting, and how much of
// the process the user wants done for them.
//
// The folder row is not decoration. The whole design rests on the downloaded
// installer being a real, findable file: if someone declines the automatic
// install, nothing is lost or hidden -- the setup file is right there, named
// after its version, and one click reveals it.

// The accent stays on from the moment a release is offered until it is
// installed, so the panel reads as one continuous process rather than lighting
// up, going grey mid-download, and lighting up again.
function toneOf(status) {
  if (status === 'error') return 'bad';
  if (status === 'ready') return 'ready';
  if (['available', 'downloading', 'verifying', 'installing'].includes(status)) return 'offer';
  if (status === 'not-available') return 'ok';
  return 'neutral';
}

function Stat({ label, value }) {
  return (
    <div className="up-stat">
      <span className="up-stat-label">{label}</span>
      <span className="up-stat-value mono">{value}</span>
    </div>
  );
}

// Release notes arrive as GitHub-flavoured markdown. Rendering a full markdown
// tree here would be a lot of machinery for something read once, so this keeps
// exactly what carries meaning in a changelog: headings, and the shape of a
// bullet list.
function Notes({ text }) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 40);
  if (!lines.length) return null;
  return (
    <div className="up-notes">
      {lines.map((line, i) => {
        if (/^#{1,6}\s/.test(line)) {
          return <strong key={i} className="up-notes-head">{line.replace(/^#{1,6}\s*/, '')}</strong>;
        }
        if (/^[-*+]\s/.test(line)) {
          return (
            <span key={i} className="up-notes-item">
              <i aria-hidden="true" />
              {line.replace(/^[-*+]\s*/, '')}
            </span>
          );
        }
        return <span key={i} className="up-notes-line">{line}</span>;
      })}
    </div>
  );
}

export default function UpdatePanel({
  appInfo, update, mode,
  onCheck, onDownload, onDownloadAndInstall, onInstallNow,
  onCancelDownload, onCancelAuto, onOpenFolder, onModeChange,
}) {
  const [now, setNow] = useState(Date.now());
  const [notesOpen, setNotesOpen] = useState(false);

  useEffect(() => {
    if (!update?.autoInstallAt) return undefined;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [update?.autoInstallAt]);

  const status = update?.status || 'idle';
  const busy = isUpdateBusy(update);
  const seconds = countdownSeconds(update, now);
  const armed = seconds !== null;
  const pct = updatePercent(update);
  const downloading = status === 'downloading';
  const ready = status === 'ready';
  const failed = status === 'error';
  const hasOffer = ['available', 'downloading', 'verifying', 'ready', 'installing'].includes(status);
  const canInstall = update?.canInstall !== false;

  const headline = (() => {
    switch (status) {
      case 'checking': return 'در حال بررسی به‌روزرسانی…';
      case 'available': return `نسخه‌ی ${update.version} منتشر شده است`;
      case 'downloading': return `در حال دانلود نسخه‌ی ${update.version}`;
      case 'verifying': return 'در حال بررسی سلامت فایل دانلودشده';
      case 'ready': return armed
        ? `نصب خودکار نسخه‌ی ${update.version} تا ${seconds} ثانیه‌ی دیگر`
        : `نسخه‌ی ${update.version} دانلود شد و آماده‌ی نصب است`;
      case 'installing': return 'در حال نصب — برنامه بسته و دوباره باز می‌شود';
      case 'not-available': return 'شما از آخرین نسخه استفاده می‌کنید';
      case 'error': return update.error?.message || 'به‌روزرسانی ناموفق بود';
      default: return 'برای بررسی نسخه‌ی جدید کلیک کنید';
    }
  })();

  return (
    <Section title="درباره و به‌روزرسانی" icon="info" description="نسخه‌ی نصب‌شده و مدیریت به‌روزرسانی">
      <div className="setting-row">
        <div className="setting-text">
          <span className="setting-label">Soul Connection</span>
          <span className="setting-hint mono">نسخه {appInfo?.version || update?.currentVersion || '—'}</span>
        </div>
        <button className="btn icon-inline-btn" onClick={onCheck} disabled={busy}>
          {status === 'checking'
            ? <span className="icon-spinner" aria-hidden="true" />
            : <Icon name="refresh" size={14} />}
          بررسی نسخه‌ی جدید
        </button>
      </div>

      <div className={`up-state tone-${toneOf(status)}`}>
        <div className="up-state-head">
          <span className="up-state-glyph">
            {busy
              ? <span className="icon-spinner" aria-hidden="true" />
              : <Icon
                  name={failed ? 'info' : ready ? 'check' : hasOffer ? 'download' : status === 'not-available' ? 'check' : 'refresh'}
                  size={15}
                />}
          </span>
          <span className="up-state-text">{headline}</span>
          {update?.size > 0 && hasOffer && (
            <span className="up-state-size mono">{formatBytes(update.size)}</span>
          )}
        </div>

        {(downloading || status === 'verifying' || armed) && (
          <div
            className={`up-track ${status === 'verifying' ? 'sweep' : ''} ${armed ? 'countdown' : ''}`}
            role="progressbar"
            aria-valuenow={status === 'verifying' ? undefined : pct}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            {/* scaleX, not width: the bar is updated five times a second while
                a download runs, and animating width re-runs layout on every
                one of those frames. The element is always full width and only
                its transform moves. */}
            <div
              className="up-fill"
              style={{
                transform: `scaleX(${status === 'verifying'
                  ? 1
                  : armed
                    ? seconds / ((update.autoInstallDelayMs || 15000) / 1000)
                    : pct / 100})`,
              }}
            />
          </div>
        )}

        {downloading && (
          <div className="up-stats">
            <Stat label="سرعت دانلود" value={formatSpeed(update.bytesPerSecond)} />
            <Stat label="دریافت‌شده" value={formatProgress(update)} />
            <Stat label="پیشرفت" value={`${pct}٪`} />
            <Stat label="زمان باقی‌مانده" value={formatEta(update.etaSeconds) || '—'} />
          </div>
        )}

        <div className="up-actions">
          {downloading && (
            <button className="btn icon-inline-btn" onClick={onCancelDownload}>
              <Icon name="close" size={14} />
              انصراف از دانلود
            </button>
          )}

          {status === 'available' && (
            <>
              <button className="btn primary icon-inline-btn" onClick={onDownloadAndInstall}>
                <Icon name="download" size={14} />
                {canInstall ? 'دانلود و نصب خودکار' : 'دانلود نسخه‌ی جدید'}
              </button>
              {canInstall && (
                <button className="btn icon-inline-btn" onClick={onDownload}>
                  <Icon name="folder" size={14} />
                  فقط دانلود کن
                </button>
              )}
            </>
          )}

          {ready && (
            <>
              {canInstall && (
                <button className="btn primary icon-inline-btn" onClick={onInstallNow}>
                  <Icon name="refresh" size={14} />
                  نصب و راه‌اندازی مجدد
                </button>
              )}
              {armed && (
                <button className="btn icon-inline-btn" onClick={onCancelAuto}>
                  <Icon name="pause" size={14} />
                  فعلاً نصب نکن
                </button>
              )}
              <button className="btn icon-inline-btn" onClick={onOpenFolder}>
                <Icon name="folder" size={14} />
                نمایش فایل نصب
              </button>
            </>
          )}

          {failed && (
            <button className="btn primary icon-inline-btn" onClick={onDownloadAndInstall}>
              <Icon name="refresh" size={14} />
              تلاش دوباره
            </button>
          )}

          {!!update?.notes && (
            <button className="btn icon-inline-btn" onClick={() => setNotesOpen((v) => !v)}>
              <Icon name="info" size={14} />
              {notesOpen ? 'بستن تغییرات' : 'تغییرات این نسخه'}
            </button>
          )}
        </div>

        {notesOpen && !!update?.notes && <Notes text={update.notes} />}

        {!canInstall && hasOffer && (
          <p className="up-note">
            این نسخه‌ی قابل حمل (Portable) است و خودش را نصب نمی‌کند — فایل دانلودشده در پوشه‌ی
            به‌روزرسانی می‌ماند تا خودتان اجرا کنید.
          </p>
        )}
      </div>

      <div className="setting-row">
        <div className="setting-text">
          <span className="setting-label">نحوه‌ی به‌روزرسانی</span>
          <span className="setting-hint">
            {UPDATE_MODE_OPTIONS.find((o) => o.value === mode)?.hint || ''}
          </span>
        </div>
        <select
          className="setting-select"
          value={mode}
          onChange={(e) => onModeChange(e.target.value)}
        >
          {UPDATE_MODE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>

      <div className="setting-row">
        <div className="setting-text">
          <span className="setting-label">پوشه‌ی به‌روزرسانی</span>
          <span className="setting-hint mono up-path" title={update?.folder || ''}>
            {update?.folder || '—'}
          </span>
        </div>
        <button className="btn icon-inline-btn" onClick={onOpenFolder}>
          <Icon name="folder" size={14} />
          باز کردن
        </button>
      </div>
    </Section>
  );
}
