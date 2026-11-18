import React from 'react';
/** Three-up KPI cards used by markets/news/performance/wallet (legacy `.grid > .card`). */
export interface StatCard { label: string; value: React.ReactNode; color?: string }
export function StatCards({ cards }: { cards: StatCard[] }) {
  return (
    <section className="grid">
      {cards.map((c, i) => <div className="card" key={i}><small>{c.label}</small><b style={c.color ? { color: c.color } : undefined}>{c.value}</b></div>)}
    </section>
  );
}
/** Titled glass panel below the stat cards. */
export function ShowcasePanel({ title, children, gap = 10 }: { title: string; children: React.ReactNode; gap?: number }) {
  return (
    <section className="card panel" style={{ marginTop: 16 }}>
      <b style={{ fontSize: 16, color: '#fce38a' }}>{title}</b>
      <div style={{ marginTop: 14, display: 'grid', gap }}>{children}</div>
    </section>
  );
}
