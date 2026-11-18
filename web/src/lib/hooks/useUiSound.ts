'use client';
import { useCallback, useEffect, useState } from 'react';
const KEY = 'velora_ui_sounds'; // same key as legacy velora-ui-sound.js
function read() { try { return localStorage.getItem(KEY) !== 'off'; } catch { return true; } }
/** UI-sound preference (persisted like legacy; playback itself is not ported — see migration map). */
export function useUiSound() {
  const [enabled, setEnabled] = useState(true);
  useEffect(() => { setEnabled(read()); }, []);
  const toggle = useCallback(() => {
    const next = !read();
    try { localStorage.setItem(KEY, next ? 'on' : 'off'); } catch { /* ignore */ }
    document.documentElement.dataset.veloraSounds = next ? 'on' : 'off';
    setEnabled(next);
  }, []);
  return { enabled, toggle };
}
