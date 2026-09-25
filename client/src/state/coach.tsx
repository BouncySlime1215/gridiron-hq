import { createContext, useContext } from 'react';
import type { WarRoomView } from '../components/warroom/types';

/**
 * The app-wide Coach (components/AppCoach.tsx): one drawer on every area, opened from the
 * header or from a page ("Ask Coach about this"). `view` is the active league's War Room
 * view when the server serves one (it carries title odds and the health reports the header
 * shows), else null. `loading` is true while that view is still on its way (the header and
 * Today draw placeholders at their final size instead of popping in).
 */
export interface CoachApi {
  enabled: boolean;
  open: (question?: string) => void;
  openHealth: () => void;
  view: WarRoomView | null;
  loading?: boolean;
}
export const CoachContext = createContext<CoachApi>({ enabled: false, open() {}, openHealth() {}, view: null });
export const useCoach = () => useContext(CoachContext);
