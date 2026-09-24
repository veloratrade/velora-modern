"use client";
import { useCallback, useEffect, useRef, useState } from "react";

export function useTimedMessage<T = string>(ms: number) {
  const [value, setValue] = useState<T | null>(null);
  const [visible, setVisible] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const show = useCallback(
    (v: T) => {
      setValue(v);
      setVisible(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setVisible(false), ms);
    },
    [ms],
  );
  const hide = useCallback(() => {
    setVisible(false);
    if (timer.current) clearTimeout(timer.current);
  }, []);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return { value, visible, show, hide };
}

export function useCooldown() {
  const [remaining, setRemaining] = useState(0);
  const [total, setTotal] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval>>(undefined);
  const stop = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
  }, []);
  const start = useCallback(
    (seconds: number) => {
      stop();
      setTotal(seconds);
      setRemaining(seconds);
      timer.current = setInterval(
        () =>
          setRemaining((r) => {
            if (r <= 1) {
              stop();
              return 0;
            }
            return r - 1;
          }),
        1000,
      );
    },
    [stop],
  );
  useEffect(() => stop, [stop]);
  return { remaining, fraction: total ? remaining / total : 0, active: remaining > 0, start };
}
