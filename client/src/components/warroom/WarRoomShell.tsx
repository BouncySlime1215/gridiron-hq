import { useState, type ComponentProps } from 'react';
import WarRoom from './WarRoom';
import WarRoomV2 from './WarRoomV2';
import { readLayout, writeLayout, type WarRoomLayout } from './layoutPref';

/**
 * WAR-ROOM-UI v2: the War Room as Trades → Next move mounts it. The new layout (WarRoomV2: hero
 * next move, one Details disclosure, Coach drawer) is the default; "Classic layout" swaps
 * in the old one-screen dashboard (WarRoom.tsx, unchanged) and "New layout" swaps back.
 * The choice is kept in this browser (layoutPref.ts).
 */
export default function WarRoomShell(props: ComponentProps<typeof WarRoom>) {
  const [layout, setLayout] = useState<WarRoomLayout>(() => readLayout());
  const choose = (l: WarRoomLayout) => { writeLayout(l); setLayout(l); };
  if (layout === 'classic') {
    return <WarRoom {...props} layoutToggle={
      <button type="button" className="wr-chip" data-testid="layout-toggle" onClick={() => choose('v2')}>New layout</button>} />;
  }
  return <WarRoomV2 {...props} onClassic={() => choose('classic')} />;
}
