import React from 'react';
/** Legacy profile `.sound-toggle` switch (gold ON state). */
export function ToggleSwitch({ on, label, onClick, id }: { on: boolean; label: string; onClick: () => void; id?: string }) {
  return <button id={id} className={`sound-toggle${on ? ' on' : ''}`} type="button" role="switch" aria-checked={on} aria-label={label} onClick={onClick}><i /></button>;
}
