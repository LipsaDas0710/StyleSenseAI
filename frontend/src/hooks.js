import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Loads data with `loader()` whenever `deps` change. Returns { data, error, loading, reload }.
 * `pollMs` re-fetches quietly in the background so the console reflects opens/replies as they happen.
 */
export function useApi(loader, deps, { pollMs } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const loaderRef = useRef(loader);
  useEffect(() => {
    loaderRef.current = loader; // keep the latest closure without re-triggering loads
  });

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await loaderRef.current();
      setState({ data, error: null, loading: false });
    } catch (error) {
      setState((s) => ({ data: quiet ? s.data : null, error, loading: false }));
    }
  }, []);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    if (!pollMs) return undefined;
    const timer = setInterval(() => load(true), pollMs);
    return () => clearInterval(timer);
  }, [pollMs, load]);

  return { ...state, reload: load };
}

/** Wraps an async action with pending/error state for buttons and forms. */
export function useAction(action) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);
  const run = useCallback(async (...args) => {
    setPending(true);
    setError(null);
    try {
      return await action(...args);
    } catch (err) {
      setError(err);
      return undefined;
    } finally {
      setPending(false);
    }
  }, [action]);
  return { run, pending, error, clearError: () => setError(null) };
}

export function useDebounced(value, ms = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}
