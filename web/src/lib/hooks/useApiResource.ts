'use client';
import { useCallback, useEffect, useState } from 'react';
import { request } from '@/lib/api/client';

export interface Resource<T> { data: T | null; error: unknown; loading: boolean; reload: () => Promise<void> }

/** Load `path` once (and on demand) and map the unwrapped payload with `select`. */
export function useApiResource<R, T = R>(path: string, select: (raw: R) => T): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    setLoading(true);
    try { setData(select(await request<R>(path))); setError(null); }
    catch (e) { setError(e); }
    finally { setLoading(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);
  useEffect(() => { void reload(); }, [reload]);
  return { data, error, loading, reload };
}
