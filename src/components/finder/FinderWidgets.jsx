import React from 'react';
import { scoreTone } from '../../utils/score.js';

// The small SVG readouts the result cards are built from. Kept separate from
// FinderCard so the card file stays about layout, not geometry.

export function ScoreRing({ score }) {
  const tone = scoreTone(score);
  const C = 2 * Math.PI * 13;
  const off = score == null ? C : C * (1 - score / 100);
  return (
    <div className={`score-ring tone-${tone}`} title="امتیاز سلامت (۰ تا ۱۰۰)">
      <svg viewBox="0 0 32 32" aria-hidden="true">
        <circle className="ring-bg" cx="16" cy="16" r="13" />
        <circle className="ring-val" cx="16" cy="16" r="13" strokeDasharray={C} strokeDashoffset={off} />
      </svg>
      <span className="mono">{score == null ? '–' : score}</span>
    </div>
  );
}

export function Sparkline({ values, tone = 'good', width = 200, height = 36 }) {
  if (!values || values.length < 2) return null;
  const ok = values.map((v) => (v > 0 ? v : null));
  const max = Math.max(...ok.filter((v) => v != null), 1);
  const step = width / (values.length - 1);
  const pts = ok.map((v, i) => (v == null ? null : `${(i * step).toFixed(1)},${(height - 3 - (v / max) * (height - 8)).toFixed(1)}`));
  const path = pts.filter(Boolean).join(' ');
  return (
    <svg className={`sparkline tone-${tone}`} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <polyline points={path} />
      {ok.map((v, i) => (v == null
        ? <circle key={i} className="miss" cx={i * step} cy={height - 6} r="2.5" />
        : null))}
    </svg>
  );
}

export function Metric({ label, value, tone = 'na', ltr }) {
  return (
    <div className="metric">
      <span className="metric-label">{label}</span>
      <span className={`metric-value tone-${tone} ${ltr ? 'mono' : ''}`}>{value}</span>
    </div>
  );
}
