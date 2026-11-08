import { useEffect, useState } from 'react';
import { commands, type ServerInfo } from './api';

/** The current time, refreshed every second while `active` (for live timers). */
export function useNow(active: boolean, everyMs = 1000): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(timer);
  }, [active, everyMs]);
  return now;
}

export function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatches(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return matches;
}

/** Whether the user can see this window: the tab is visible and the window has the focus. */
export function windowActive(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus();
}

export function useWindowActive(): boolean {
  const [active, setActive] = useState(windowActive);
  useEffect(() => {
    // Checked a tick later: during a blur the focus may only be moving into a frame of this page.
    const on = () => window.setTimeout(() => setActive(windowActive()), 0);
    window.addEventListener('focus', on);
    window.addEventListener('blur', on);
    document.addEventListener('visibilitychange', on);
    return () => {
      window.removeEventListener('focus', on);
      window.removeEventListener('blur', on);
      document.removeEventListener('visibilitychange', on);
    };
  }, []);
  return active;
}

/** The server's `/api/info` (fetched once and shared), or null until it arrives. */
export function useServerInfo(): ServerInfo | null {
  const [info, setInfo] = useState<ServerInfo | null>(null);
  useEffect(() => {
    let live = true;
    commands
      .info()
      .then((i) => live && setInfo(i))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return info;
}

/** Whether two folder paths are the same (case-insensitive on Windows, like the server). */
export function sameFolder(a: string, b: string, platform: string | undefined): boolean {
  const norm = (p: string) => {
    const trimmed = p.trim().replace(/[\\/]+$/, '');
    return platform === 'win32' ? trimmed.replace(/\//g, '\\').toLowerCase() : trimmed;
  };
  return norm(a) === norm(b);
}
