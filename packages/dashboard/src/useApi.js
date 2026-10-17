import { useCallback, useEffect, useState } from 'react';
import { get } from './api.js';

/** Load a GET endpoint; returns { data, error, loading, reload }. */
export function useApi(path) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const reload = useCallback(() => {
    if (!path) return;
    setState((s) => ({ ...s, loading: true }));
    get(path).then(
      (data) => setState({ data, error: null, loading: false }),
      (error) => setState({ data: null, error, loading: false }),
    );
  }, [path]);
  useEffect(() => {
    reload();
  }, [reload]);
  return { ...state, reload };
}
