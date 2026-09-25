/**
 * WAR-ROOM-UI v2: which War Room layout Nick sees. The new layout is the default; the
 * "Classic layout" toggle stores 'classic' in this browser (localStorage) so the old
 * dashboard stays one tap away. Storage can be blocked (private window, site data off):
 * then the default stands and the reason is logged, never thrown.
 */
export type WarRoomLayout = 'v2' | 'classic';
export const LAYOUT_KEY = 'gridiron.warroom.layout';

type Store = Pick<Storage, 'getItem' | 'setItem'>;
const browserStore = (): Store | null => (typeof window !== 'undefined' && window.localStorage ? window.localStorage : null);

export function readLayout(store: Store | null = null): WarRoomLayout {
  try {
    return (store ?? browserStore())?.getItem(LAYOUT_KEY) === 'classic' ? 'classic' : 'v2';
  } catch (e) {
    console.warn('War Room: could not read the saved layout; using the new one', e);
    return 'v2';
  }
}

export function writeLayout(layout: WarRoomLayout, store: Store | null = null): boolean {
  try {
    const s = store ?? browserStore();
    if (!s) return false;
    s.setItem(LAYOUT_KEY, layout);
    return true;
  } catch (e) {
    console.warn('War Room: could not save the layout choice', e);
    return false;
  }
}
