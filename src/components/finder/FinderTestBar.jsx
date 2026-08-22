import React from 'react';
import Icon from '../Icon.jsx';
import * as engine from '../../finder/testEngine.js';
import { MODES, fmtEta } from './finderShared.js';
import { PRIORITIES } from '../../utils/score.js';

// The launch row and the run readout. Idle: a segmented mode control, the
// scoring priority, and one start button that says exactly how many servers
// it will test. Running: the same row swaps the start button for pause/stop,
// and a slim progress strip appears with the count, the ETA and the two jump
// links (live dashboard, live log). The engine itself is a module store --
// pause/resume/cancel talk to it directly, no prop drilling for actions that
// change no local state here.
export default function FinderTestBar({
  t, running, mode, onModeChange, priority, onPriorityChange,
  filteredCount, onStart, eta, progress, logOpen, onToggleLog, onOpenDash,
}) {
  const modeDesc = MODES.find((m) => m.key === mode)?.desc;
  return (
    <>
      <div className="test-bar">
        <div className="mode-seg" role="radiogroup" aria-label="روش تست">
          {MODES.map((m) => (
            <button
              aria-label={m.desc}
              key={m.key}
              role="radio"
              aria-checked={mode === m.key}
              className={`mode-seg-btn ${mode === m.key ? 'on' : ''}`}
              disabled={running}
              onClick={() => onModeChange(m.key)}
              title={m.desc}
            >
              <Icon name={m.icon} size={14} />
              <span>{m.title}</span>
            </button>
          ))}
        </div>

        <select
          className="finder-select priority-select"
          value={priority}
          onChange={(e) => onPriorityChange(e.target.value)}
          aria-label="اولویت پیشنهاد و امتیازدهی"
          title="اولویت پیشنهاد و امتیازدهی"
        >
          {PRIORITIES.map((p) => <option key={p.key} value={p.key}>اولویت: {p.label}</option>)}
        </select>

        {!running ? (
          <button className="btn primary test-start" onClick={onStart} disabled={!filteredCount} title={modeDesc}>
            <Icon name="play" size={13} />
            تست {filteredCount} سرور
          </button>
        ) : (
          <div className="test-run-controls">
            {t.status === 'paused' ? (
              <button className="icon-btn" onClick={engine.resume} title="ادامه" aria-label="ادامه‌ی تست">
                <Icon name="play" size={14} />
              </button>
            ) : (
              <button className="icon-btn" onClick={engine.pause} title="توقف موقت" aria-label="توقف موقت تست">
                <Icon name="pause" size={14} />
              </button>
            )}
            <button className="icon-btn" onClick={engine.cancelAll} title="لغو" aria-label="لغو تست">
              <Icon name="stop" size={13} />
            </button>
          </div>
        )}
      </div>

      {running && (
        <div className="progress-strip">
          <div
            className="progress-track"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={t.total}
            aria-valuenow={t.done}
            aria-label="پیشرفت تست"
          >
            <div className="progress-fill" style={{ transform: `scaleX(${progress / 100})` }} />
          </div>
          <span className="progress-text mono">{t.done}/{t.total}</span>
          {t.status === 'paused'
            ? <span className="progress-eta">متوقف</span>
            : eta != null && <span className="progress-eta">{fmtEta(eta)} مانده</span>}
          <button className="log-toggle dash-jump" onClick={onOpenDash}>
            <Icon name="gauge" size={11} /> داشبورد زنده
          </button>
          <button className="log-toggle" onClick={onToggleLog} aria-expanded={logOpen}>
            گزارش زنده <Icon name="chevron" size={10} className={logOpen ? 'flip' : ''} />
          </button>
        </div>
      )}
    </>
  );
}
