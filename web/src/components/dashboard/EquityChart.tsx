'use client';
/*
 * Port of legacy dashboard `drawChart(points)`: 600x220 viewBox, PAD 14,
 * Catmull-Rom-ish cubic Bezier through equity points, dash-in animation,
 * gradient area, end dot and nearest-point tooltip (date — currency).
 */
import React, { useMemo, useState } from 'react';
import { useI18n } from '@/i18n/I18nProvider';

export interface EquityPoint { date: string; pnl: string | number; equity: string | number }

const W = 600, H = 220, PAD = 14;

export function EquityChart({ points: input }: { points: EquityPoint[] }) {
  const { dateWall, currency } = useI18n();
  const [tipIdx, setTipIdx] = useState<number | null>(null);

  const { points, coords, line, area, X } = useMemo(() => {
    let points = input;
    if (!points || points.length < 2) points = [{ date: '', pnl: '0', equity: '0' }, { date: '', pnl: '0', equity: '0' }];
    const vals = points.map((p) => Number(p.equity));
    let min = Math.min(...vals), max = Math.max(...vals);
    if (max === min) { max = min + 1; min = min - 1; }
    const rng = max - min;
    const X = (i: number) => PAD + (i / (points.length - 1)) * (W - PAD * 2);
    const Y = (v: number) => H - PAD - ((v - min) / rng) * (H - PAD * 2);
    const coords = points.map((p, i) => ({ x: X(i), y: Y(Number(p.equity)) }));
    let line = 'M' + coords[0].x.toFixed(1) + ',' + coords[0].y.toFixed(1);
    for (let i = 0; i < coords.length - 1; i++) {
      const a = coords[i], b = coords[i + 1];
      const prev = coords[i - 1] || a, next = coords[i + 2] || b;
      const c1x = a.x + (b.x - prev.x) / 6, c1y = a.y + (b.y - prev.y) / 6;
      const c2x = b.x - (next.x - a.x) / 6, c2y = b.y - (next.y - a.y) / 6;
      line += ' C' + c1x.toFixed(1) + ',' + c1y.toFixed(1) + ' ' + c2x.toFixed(1) + ',' + c2y.toFixed(1) + ' ' + b.x.toFixed(1) + ',' + b.y.toFixed(1);
    }
    const area = line + ' L' + X(points.length - 1).toFixed(1) + ',' + (H - PAD) + ' L' + X(0).toFixed(1) + ',' + (H - PAD) + ' Z';
    return { points, coords, line, area, X };
  }, [input]);

  function onMove(ev: React.MouseEvent<SVGSVGElement>) {
    const rect = ev.currentTarget.getBoundingClientRect();
    const mx = (ev.clientX - rect.left) / rect.width * W;
    let best = 0, bd = Infinity;
    points.forEach((_, i) => { const d = Math.abs(X(i) - mx); if (d < bd) { bd = d; best = i; } });
    setTipIdx(best);
  }

  const last = coords[coords.length - 1];
  const tip = tipIdx === null ? null : points[tipIdx];
  return (
    <div className="chart-box">
      <svg id="equityChart" preserveAspectRatio="none" viewBox={`0 0 ${W} ${H}`} onMouseMove={onMove} onMouseLeave={() => setTipIdx(null)}>
        <defs>
          <linearGradient id="lineG" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0" stopColor="#b88d1d" /><stop offset=".5" stopColor="#fce38a" /><stop offset="1" stopColor="#d4af37" />
          </linearGradient>
          <linearGradient id="areaG" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="#d4af37" stopOpacity=".4" /><stop offset="1" stopColor="#d4af37" stopOpacity="0" />
          </linearGradient>
        </defs>
        <g id="chartG">
          <line className="chart-grid-l" x1="0" x2="600" y1="55" y2="55" />
          <line className="chart-grid-l" x1="0" x2="600" y1="110" y2="110" />
          <line className="chart-grid-l" x1="0" x2="600" y1="165" y2="165" />
        </g>
        <path d={area} className="chart-area" />
        <path key={line} d={line} className="chart-line" style={{ strokeDasharray: 900, strokeDashoffset: 900, animation: 'dash 1.6s ease forwards' }} />
        <style>{'@keyframes dash { to { stroke-dashoffset: 0; } }'}</style>
        <circle className="chart-dot" cx={last.x.toFixed(1)} cy={last.y.toFixed(1)} r="4.5" />
      </svg>
      <div
        className="chart-tip"
        id="chartTip"
        style={tip ? { display: 'block', left: (X(tipIdx as number) / W * 100) + '%', top: 10, transform: 'translateX(-50%)' } : { display: 'none' }}
      >
        {tip ? (<><b data-value-type="date">{dateWall(tip.date)}</b> — <span data-value-type="currency">{currency(tip.equity, 'USD')}</span></>) : null}
      </div>
    </div>
  );
}
