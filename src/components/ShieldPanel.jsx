import React, { useEffect, useState } from 'react';
import Icon from './Icon.jsx';
import { Section } from './settingsPrimitives.jsx';

// ---- Adaptive Shield (Settings ▸ سپر تطبیقی) -------------------------------
//
// The feature's whole claim is that it *measured* something, so the panel has
// to show the measurement, not just the verdict. A user who is told "we turned
// on fragmentation" learns nothing and has no reason to believe it; a user who
// can see that plain lost every probe and one treatment lost none understands
// exactly what happened to their connection and why.
//
// That is also why failed candidates stay on screen rather than being filtered
// out. On a censored network the row that reads "0 of 5" against the plain
// profile is the single most informative thing here.

export const SHIELD_MODES = [
  { value: 'auto', label: 'خودکار (پیشنهادی)', hint: 'برنامه خودش می‌سنجد این شبکه به چه چیزی نیاز دارد و همان را اعمال می‌کند' },
  { value: 'manual', label: 'دستی', hint: 'یک روش ثابت برای همه‌ی سرورها انتخاب می‌شود' },
  { value: 'off', label: 'خاموش', hint: 'هیچ تغییری روی ترافیک اعمال نمی‌شود' },
];

export const SHIELD_PROFILES = [
  { key: 'off', label: 'بدون تغییر' },
  { key: 'tlshello-fine', label: 'برش ریز TLS' },
  { key: 'tlshello-wide', label: 'برش درشت TLS' },
  { key: 'stream', label: 'برش جریان' },
  { key: 'noise', label: 'تزریق نویز' },
  { key: 'combo', label: 'برش + نویز' },
];

const labelOf = (key) => (SHIELD_PROFILES.find((p) => p.key === key) || {}).label || key;

function toneOf(r) {
  if (!r || !r.ok) return 'bad';
  if (r.loss === 0) return 'good';
  return 'mid';
}

// One measured candidate. The bar is the share of probes that came back, which
// is the number that actually decides the winner.
function ResultRow({ r, winner }) {
  const passed = Math.max(0, Math.min(100, 100 - (r.loss ?? 100)));
  return (
    <div className={`sh-row tone-${toneOf(r)} ${winner ? 'winner' : ''}`}>
      <span className="sh-row-name">
        {winner && <Icon name="check" size={12} />}
        {labelOf(r.key)}
      </span>
      <span className="sh-row-bar" aria-hidden="true">
        <i style={{ width: `${passed}%` }} />
      </span>
      <span className="sh-row-num mono">
        {r.ok ? `${r.latency ?? '—'}ms` : 'رد شد'}
      </span>
      <span className="sh-row-loss mono">{passed}٪</span>
    </div>
  );
}

// `mode` comes from settings rather than from the shield state on purpose: it
// is the one field the user edits here, and reading it back from the main
// process would leave the select showing the old value until some unrelated
// refresh happened to arrive.
export default function ShieldPanel({ shield, mode, progress, onTune, onCancel, onModeChange, onManualKeyChange, onClear }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!progress?.running) return undefined;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [progress?.running]);
  void now;

  const activeMode = mode || shield?.mode || 'auto';
  const running = !!(progress?.running || shield?.running);
  const choice = shield?.choice || null;
  const results = choice?.results || [];
  const active = shield?.activeKey || 'off';
  const applicable = shield?.applicable !== false;

  const headline = (() => {
    if (running) {
      const p = progress || {};
      if (p.phase === 'candidate') return `در حال سنجش «${p.label || labelOf(p.key)}» — ${(p.index ?? 0) + 1} از ${p.total ?? 6}`;
      if (p.phase === 'probe') return `ارسال درخواست آزمایشی… ${p.done}/${p.total}`;
      return 'در حال آماده‌سازی سنجش…';
    }
    if (!applicable) return 'این پروتکل دست‌دادن TLS ندارد و سپر روی آن اثری نمی‌گذارد';
    if (activeMode === 'off') return 'سپر خاموش است — ترافیک بدون تغییر ارسال می‌شود';
    if (activeMode === 'manual') return `روش ثابت: ${labelOf(shield?.manualKey || 'off')}`;
    if (!choice) return 'هنوز سنجشی انجام نشده — برای این شبکه یک بار بسنج';
    if (choice.reason === 'clean-network') return 'این شبکه دست‌کاری نمی‌کند — بدون تغییر، سریع‌ترین حالت است';
    return `بهترین روش برای این شبکه: ${labelOf(choice.key)}`;
  })();

  const tone = running ? 'busy' : !choice || activeMode === 'off' ? 'neutral' : active === 'off' ? 'ok' : 'armed';

  return (
    <Section
      title="سپر تطبیقی"
      icon="shield"
      description="سنجش و خنثی‌سازی خودکار فیلترینگ هوشمند (DPI)"
    >
      <div className={`sh-state tone-${tone}`}>
        <div className="sh-head">
          <span className="sh-glyph">
            {running ? <span className="icon-spinner" aria-hidden="true" /> : <Icon name="shield" size={15} />}
          </span>
          <span className="sh-text">{headline}</span>
          {!running && choice && activeMode === 'auto' && (
            <span className="sh-badge mono">{labelOf(active)}</span>
          )}
        </div>

        {running && (
          <div className="sh-track" role="progressbar" aria-valuemin={0} aria-valuemax={100}>
            <div
              className="sh-fill"
              style={{ width: `${Math.round((((progress?.index ?? 0) + 1) / (progress?.total || 6)) * 100)}%` }}
            />
          </div>
        )}

        {!running && results.length > 0 && (
          <div className="sh-results">
            <div className="sh-results-head">
              <span>نتیجه‌ی سنجش این شبکه</span>
              <span className="mono">{results.length} روش</span>
            </div>
            {results.map((r) => <ResultRow key={r.key} r={r} winner={r.key === choice.key} />)}
          </div>
        )}

        <div className="sh-actions">
          {running ? (
            <button className="btn icon-inline-btn" onClick={onCancel}>
              <Icon name="close" size={14} />
              توقف سنجش
            </button>
          ) : (
            <button className="btn primary icon-inline-btn" onClick={onTune} disabled={!applicable || activeMode === 'off'}>
              <Icon name="radar" size={14} />
              {choice ? 'سنجش دوباره' : 'همین حالا بسنج'}
            </button>
          )}
          {!running && choice && (
            <button className="btn icon-inline-btn" onClick={onClear}>
              <Icon name="trash" size={14} />
              پاک کردن نتایج
            </button>
          )}
        </div>

        {!running && !choice && activeMode === 'auto' && applicable && (
          <p className="sh-note">
            سنجش حدود ۳ ثانیه طول می‌کشد اگر شبکه سالم باشد، و تا حدود یک دقیقه اگر لازم باشد همه‌ی
            روش‌ها امتحان شوند. نتیجه برای همین شبکه ذخیره می‌شود و با تغییر شبکه دوباره سنجیده می‌شود.
          </p>
        )}
      </div>

      <div className="setting-row">
        <div className="setting-text">
          <span className="setting-label">نحوه‌ی کار سپر</span>
          <span className="setting-hint">{SHIELD_MODES.find((m) => m.value === activeMode)?.hint || ''}</span>
        </div>
        <select className="setting-select" value={activeMode} onChange={(e) => onModeChange(e.target.value)}>
          {SHIELD_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
      </div>

      {activeMode === 'manual' && (
        <div className="setting-row">
          <div className="setting-text">
            <span className="setting-label">روش ثابت</span>
            <span className="setting-hint">برای همه‌ی سرورها اعمال می‌شود</span>
          </div>
          <select
            className="setting-select"
            value={shield?.manualKey || 'off'}
            onChange={(e) => onManualKeyChange(e.target.value)}
          >
            {SHIELD_PROFILES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
        </div>
      )}
    </Section>
  );
}
