import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

/**
 * App-wide light/dark. The choice is 'system' (the default: follow the OS), 'light' or 'dark',
 * kept per browser in localStorage. The resolved theme lives on <html data-theme>, which
 * tokens.css and the Tailwind palette (tailwind.config.js) read; index.html sets it before the
 * first paint with the same rule, so a dark system never flashes light.
 */
export type ThemePref = 'system' | 'light' | 'dark';
export type Theme = 'light' | 'dark';
export const THEME_KEY = 'gridiron:theme';

const media = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null);
export function readThemePref(): ThemePref {
  try { const v = window.localStorage.getItem(THEME_KEY); return v === 'light' || v === 'dark' ? v : 'system'; }
  catch { return 'system'; }
}
export const resolveTheme = (pref: ThemePref): Theme => (pref === 'system' ? (media()?.matches ? 'dark' : 'light') : pref);
function apply(theme: Theme) {
  const el = document.documentElement;
  if (el.dataset.theme !== theme) el.dataset.theme = theme;
}

const ThemeContext = createContext<{ pref: ThemePref; theme: Theme; setPref: (p: ThemePref) => void }>({
  pref: 'system', theme: 'light', setPref: () => {}
});
export const useTheme = () => useContext(ThemeContext);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [pref, setPrefState] = useState<ThemePref>(readThemePref);
  const [theme, setTheme] = useState<Theme>(() => resolveTheme(readThemePref()));
  const setPref = useCallback((p: ThemePref) => {
    try { if (p === 'system') window.localStorage.removeItem(THEME_KEY); else window.localStorage.setItem(THEME_KEY, p); } catch { /* private window: this sitting only */ }
    setPrefState(p);
  }, []);
  useEffect(() => {
    const next = resolveTheme(pref); setTheme(next); apply(next);
    if (pref !== 'system') return;
    const m = media(); if (!m) return;
    const onChange = () => { const t = resolveTheme('system'); setTheme(t); apply(t); };
    m.addEventListener('change', onChange);
    return () => m.removeEventListener('change', onChange);
  }, [pref]);
  return <ThemeContext.Provider value={{ pref, theme, setPref }}>{children}</ThemeContext.Provider>;
}
