/**
 * MOBILE-PWA (plan item 59). The server adds <link rel="manifest"> to index.html only while
 * GRIDIRON_PWA is on (server/platform/pwa.js), so that link is the switch: present, register the
 * shell worker; absent, remove any worker a phone installed while it was on. Dev (Vite) never
 * has the link, so nothing registers there.
 */
export type PwaAction = 'unsupported' | 'register' | 'unregister';

export function initPwa(win: Window = window): PwaAction {
  const sw = win.navigator.serviceWorker;
  if (!sw) return 'unsupported';
  if (win.document.querySelector('link[rel="manifest"]')) {
    win.addEventListener('load', () => {
      sw.register('/sw.js', { scope: '/' }).catch((err: unknown) => {
        console.warn('App shell worker did not register; the app still works online.', err);
      });
    });
    return 'register';
  }
  // Same prefix as server/platform/pwa.js CACHE_PREFIX; only this app's shell caches go.
  const store = win.caches;
  sw.getRegistrations()
    .then((regs) => Promise.all(regs.map((r) => r.unregister())))
    .then(() => (store ? store.keys() : []))
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('gridiron-shell-')).map((k) => store.delete(k))))
    .catch((err: unknown) => console.warn('Could not remove the app shell worker.', err));
  return 'unregister';
}
