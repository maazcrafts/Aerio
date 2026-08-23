import { useEffect, useRef, useState, useCallback } from 'react';

// How long a request has to be in flight before we consider the network
// "slow" and surface the taking-longer-than-usual state. Kept as a single
// constant so every caller in the app agrees on the same threshold.
export const SLOW_REQUEST_MS = 4000;

/**
 * Tracks whether the browser/device currently has a network connection.
 * Backed by navigator.onLine plus the 'online'/'offline' window events,
 * which is the standard, dependency-free way to detect connectivity
 * changes in both the web build and the Capacitor/WebView wrapper.
 */
export function useNetworkStatus() {
  const [isOnline, setIsOnline] = useState(
    typeof navigator === 'undefined' ? true : navigator.onLine
  );

  useEffect(() => {
    const goOnline = () => setIsOnline(true);
    const goOffline = () => setIsOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  return isOnline;
}

/**
 * Small helper for "this specific request is taking a while" UI.
 * Call start() right before firing a request and stop() in a finally
 * block. onSlow fires once if the request is still pending after
 * SLOW_REQUEST_MS.
 */
export function useSlowRequestTimer(onSlow, ms = SLOW_REQUEST_MS) {
  const timerRef = useRef(null);
  const onSlowRef = useRef(onSlow);
  onSlowRef.current = onSlow;

  const start = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      onSlowRef.current?.(true);
    }, ms);
  }, [ms]);

  const stop = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    onSlowRef.current?.(false);
  }, []);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  return { start, stop };
}