/* Port of legacy public/assets/emotion-icons.js (VeloraEmotions.svg) — glass/gradient faces, levels 1..5 */
import React, { useId } from 'react';

const GRADS: [string, string][] = [
  ['#FF6B6B', '#B91C1C'], ['#FFA24D', '#C2410C'], ['#F5C84C', '#B45309'], ['#7BD88A', '#4D7C0F'], ['#4CD3A6', '#047857'],
];

export function EmotionIcon({ level, size = 34 }: { level: number; size?: number }) {
  const lv = Math.max(1, Math.min(5, Number(level) || 3));
  const id = 'veg' + useId().replace(/:/g, '');
  const [g, d] = GRADS[lv - 1];
  let face: React.ReactNode;
  if (lv === 1) face = (<>
    <path d="M21 26l5 2.6M43 26l5-2.6" stroke="#fff" strokeWidth="2.2" fill="none" strokeLinecap="round" />
    <circle cx="25" cy="34" r="3" fill="#fff" /><circle cx="39" cy="34" r="3" fill="#fff" />
    <path d="M25 45q7-3.5 14 0" stroke="#fff" strokeWidth="2.6" fill="none" strokeLinecap="round" />
    <path d="M22 36c1.8 2.8 1.8 4.4 0 5.6-1.8-1.2-1.8-2.8 0-5.6z" fill="#BFDBFE" />
  </>);
  else if (lv === 2) face = (<>
    <circle cx="25" cy="34" r="3" fill="#fff" /><circle cx="39" cy="34" r="3" fill="#fff" />
    <path d="M25 45q7-3 14 0" stroke="#fff" strokeWidth="2.6" fill="none" strokeLinecap="round" />
  </>);
  else if (lv === 3) face = (<>
    <circle cx="25" cy="34" r="2.8" fill="#fff" /><circle cx="39" cy="34" r="2.8" fill="#fff" />
    <path d="M27 43h10" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
  </>);
  else if (lv === 4) face = (<>
    <circle cx="25" cy="33" r="3" fill="#fff" /><circle cx="39" cy="33" r="3" fill="#fff" />
    <path d="M25 42q7 5 14 0" stroke="#fff" strokeWidth="2.6" fill="none" strokeLinecap="round" />
  </>);
  else face = (<>
    <path d="M20 29q4-4 8 0M36 29q4-4 8 0" stroke="#fff" strokeWidth="2.6" fill="none" strokeLinecap="round" />
    <path d="M23 41q9 9 18 0" stroke="#fff" strokeWidth="3" fill="none" strokeLinecap="round" />
    <circle cx="16" cy="37" r="3.4" fill="rgba(255,255,255,.35)" /><circle cx="48" cy="37" r="3.4" fill="rgba(255,255,255,.35)" />
  </>);
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" style={{ display: 'inline-block', verticalAlign: 'middle', flexShrink: 0 }}>
      <defs><linearGradient id={id} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor={g} /><stop offset="1" stopColor={d} /></linearGradient></defs>
      <circle cx="32" cy="32" r="30" fill={`url(#${id})`} />
      <ellipse cx="24" cy="20" rx="14" ry="10" fill="rgba(255,255,255,.30)" />
      <circle cx="32" cy="32" r="30" fill="none" stroke="rgba(255,255,255,.35)" strokeWidth="1.5" />
      {face}
    </svg>
  );
}
