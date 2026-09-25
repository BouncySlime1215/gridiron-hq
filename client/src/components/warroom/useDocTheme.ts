import { useEffect, useState } from 'react';

/**
 * The War Room follows the app's light/dark (state/theme.tsx, on <html data-theme>) and its
 * menu's "Dark mode / Light mode" item flips the app's choice. Events, not an import, so the
 * War Room folder still compiles on its own in the test harness (test/helpers/warroom-tsx.mjs).
 */
type Theme = 'light' | 'dark';
// Guarded: the War Room also renders under test DOM stubs that have no <html> element.
const read = (): Theme => (typeof document !== 'undefined' && document.documentElement?.dataset?.theme === 'dark' ? 'dark' : 'light');
const canListen = () => typeof window !== 'undefined' && typeof window.addEventListener === 'function';

export function useDocTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(read);
  useEffect(() => {
    if (!canListen()) return;
    const on = (e: Event) => { const d = (e as CustomEvent).detail; setTheme(d === 'dark' ? 'dark' : 'light'); };
    window.addEventListener('gridiron:theme-changed', on);
    setTheme(read());
    return () => window.removeEventListener('gridiron:theme-changed', on);
  }, []);
  const toggle = () => canListen() && window.dispatchEvent(new CustomEvent('gridiron:set-theme', { detail: theme === 'dark' ? 'light' : 'dark' }));
  return [theme, toggle];
}
