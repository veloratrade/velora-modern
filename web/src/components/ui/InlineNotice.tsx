import React from 'react';
/** Legacy `.error-box` / `.ok-box` / `.status` notices: class-driven show/hide, no layout change. */
export function InlineNotice({ kind = 'error', visible, children, id }: { kind?: 'error' | 'ok'; visible: boolean; children?: React.ReactNode; id?: string }) {
  return <div id={id} className={`${kind === 'ok' ? 'ok-box' : 'error-box'}${visible ? ' show' : ''}`}>{children}</div>;
}
