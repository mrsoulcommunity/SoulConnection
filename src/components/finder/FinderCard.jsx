import React from 'react';
import Icon from '../Icon.jsx';
import { formatBytes, formatSpeed, relativeTime } from '../../utils/format.js';
import { countryOf } from '../../utils/geo.js';
import { healthScore, extractMetrics, qualityEstimates } from '../../utils/score.js';
import { MODES, PHASE_SHORT, fmtMs, fmtPct, mbps, msTone } from './finderShared.js';
import { ScoreRing, Sparkline, Metric } from './FinderWidgets.jsx';

// One result row. React.memo'd because the whole finder re-renders up to once
// per animation frame while a batch runs -- every handler that arrives here
// must be identity-stable and take the profile/id as an argument, or the memo
// is defeated and hundreds of cards re-render on every engine tick.
const FinderCard = React.memo(function FinderCard({
  profile, sub, result, selected, expanded, recommended, isActive, priority,
  engineIdle, onSelect, onExpand, onConnect, onFavorite, onRetest, onContext,
}) {
  const geo = countryOf(profile);
  const m = extractMetrics(result);
  const score = healthScore(result, priority);
  const quality = result?.speed ? qualityEstimates(result) : null;
  const failed = result?.status === 'fail';
  const skipped = result?.status === 'skipped';
  const testing = result?.status === 'testing' || result?.status === 'queued';
  const lastSample = result?.liveSamples?.length
    ? result.liveSamples[result.liveSamples.length - 1]
    : null;

  return (
    <div
      id={`fcard-${profile.id}`}
      role="option"
      aria-selected={selected}
      className={`fcard ${selected ? 'sel' : ''} ${expanded ? 'open' : ''} ${isActive ? 'active' : ''} ${failed ? 'failed' : ''}`}
      onClick={() => { onSelect(profile.id); onExpand(profile.id); }}
      onContextMenu={(e) => onContext(e, profile)}
    >
      <div className="fcard-row">
        <button
          className={`fav-btn ${profile.favorite ? 'on' : ''}`}
          title={profile.favorite ? 'حذف از موردعلاقه‌ها' : 'افزودن به موردعلاقه‌ها'}
          aria-label={profile.favorite ? 'حذف از موردعلاقه‌ها' : 'افزودن به موردعلاقه‌ها'}
          aria-pressed={!!profile.favorite}
          onClick={(e) => { e.stopPropagation(); onFavorite(profile); }}
        >
          <Icon name="star" size={14} />
        </button>
        <span className="flag" title={geo?.label}>{geo?.flag || '🌐'}</span>
        <div className="fcard-info">
          <div className="fcard-name">
            {profile.name || profile.address}
            {recommended && <span className="badge-rec"><Icon name="check" size={10} />پیشنهاد</span>}
            {isActive && <span className="badge-live">متصل</span>}
          </div>
          <div className="fcard-meta">
            {geo && <span>{geo.label}</span>}
            <span>{sub ? sub.name : 'دستی'}</span>
            <span className="mono proto">{profile.protocol}</span>
            {result?.status === 'ok' && result.testedAt && (
              <span className="tested-at">تست: {relativeTime(result.testedAt)}</span>
            )}
          </div>
        </div>

        {testing ? (
          <div className="fcard-testing">
            <span className="spin" aria-hidden="true" />
            <span>{result?.phase ? PHASE_SHORT[result.phase] || 'در حال تست…' : 'در حال تست…'}</span>
            {lastSample != null && lastSample > 0 && <span className="mono live-ms">{lastSample}ms</span>}
          </div>
        ) : failed ? (
          <div className="fcard-status">
            <span className="fcard-fail" title={result.error}>ناموفق</span>
            <button
              className="fcard-retry"
              disabled={!engineIdle}
              title="تست دوباره"
              aria-label="تست دوباره"
              onClick={(e) => { e.stopPropagation(); onRetest(profile.id); }}
            >
              <Icon name="refresh" size={12} />
            </button>
          </div>
        ) : skipped ? (
          <div className="fcard-status">
            <span className="fcard-skip">ردشده</span>
          </div>
        ) : (
          <div className="fcard-metrics mono">
            <span className={`fm tone-${msTone(m.latency)}`} title="تاخیر">{fmtMs(m.latency)}</span>
            {m.down != null && <span className="fm tone-good" title="دانلود">↓{mbps(m.down)}</span>}
            {m.up != null && <span className="fm tone-idle" title="آپلود">↑{mbps(m.up)}</span>}
            {m.loss != null && m.loss > 0 && <span className="fm tone-bad" title="از‌دست‌رفت">{m.loss}٪</span>}
          </div>
        )}

        <ScoreRing score={score} />

        <button
          className="fcard-connect"
          onClick={(e) => { e.stopPropagation(); onConnect(profile.id); }}
          disabled={isActive}
        >
          {isActive ? 'متصل' : 'اتصال'}
        </button>
      </div>

      {expanded && (
        <div className="fcard-detail" onClick={(e) => e.stopPropagation()}>
          <div className="detail-grid mono">
            <Metric label="پینگ شبکه" value={fmtMs(result?.ping?.avg)} tone={msTone(result?.ping?.avg)} />
            <Metric label="پینگ واقعی" value={fmtMs(result?.real?.avg)} tone={msTone(result?.real?.avg)} />
            <Metric label="کمینه / بیشینه" value={m.latency != null ? `${(result?.real?.min ?? result?.ping?.min) ?? '–'} / ${(result?.real?.max ?? result?.ping?.max) ?? '–'}` : '—'} />
            <Metric label="جیتر" value={fmtMs(m.jitter)} />
            <Metric label="از‌دست‌رفت" value={fmtPct(m.loss)} tone={m.loss > 5 ? 'bad' : m.loss > 0 ? 'mid' : 'na'} />
            <Metric label="برقراری تونل" value={fmtMs(m.boot)} />
            <Metric label="دست‌دادن TLS" value={fmtMs(result?.real?.handshakeMs)} />
            <Metric label="دانلود" value={m.down != null ? formatSpeed(m.down) : '—'} tone={m.down ? 'good' : 'na'} />
            <Metric label="آپلود" value={m.up != null ? formatSpeed(m.up) : '—'} />
            <Metric label="پایداری" value={fmtPct(m.stability)} tone={m.stability >= 75 ? 'good' : m.stability != null ? 'mid' : 'na'} />
            <Metric label="حجم مصرفی" value={profile.totalBytes ? formatBytes(profile.totalBytes) : '—'} />
            <Metric label="آدرس" value={`${profile.address}:${profile.port}`} ltr />
          </div>

          {(result?.real?.samples?.length > 1 || result?.ping?.samples?.length > 1) && (
            <div className="detail-spark">
              <span className="detail-spark-label">نمونه‌های تاخیر</span>
              <Sparkline values={result?.real?.samples || result?.ping?.samples} tone={msTone(m.latency)} />
            </div>
          )}

          {quality && quality.length > 0 && (
            <div className="quality-row">
              {quality.map((q) => (
                <span key={q.key} className={`q-badge tone-${q.tone}`}>{q.title}: {q.label}</span>
              ))}
            </div>
          )}

          <div className="detail-actions">
            {MODES.map((mode) => (
              <button
                key={mode.key}
                className="btn mini"
                disabled={!engineIdle}
                title={mode.desc}
                onClick={() => onRetest(profile.id, mode.key)}
              >
                <Icon name={mode.icon} size={12} />
                {mode.title}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
});

export default FinderCard;
