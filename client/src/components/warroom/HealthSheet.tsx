import { useEffect, useRef } from 'react';
import type { WarRoomView } from './types';
import { isOk } from './format';
import BrainCheckCard from './BrainCheckCard';

/** The top bar's health chip: one dot for the brain check and the number audit together (worst wins). */
export function healthTone(view: WarRoomView): { tone: 'green' | 'amber' | 'red' | 'grey'; label: string } {
  const brain = isOk(view.brain_report) ? view.brain_report.value.overall : null;
  const nums = isOk(view.number_health) ? view.number_health.value.overall ?? view.number_health.value.status ?? null : null;
  if (brain === 'failing' || nums === 'broken' || view.brain_report?.status === 'failed' || view.number_health?.status === 'failed') {
    return { tone: 'red', label: nums === 'broken' ? 'Numbers broken' : 'Check failing' };
  }
  if (nums === 'warn') return { tone: 'amber', label: 'Numbers: warnings' };
  if (brain === 'passing' && nums === 'ok') return { tone: 'green', label: 'Healthy' };
  return { tone: 'grey', label: brain === 'not_enough_data' ? 'Brain: not enough data' : 'Health' };
}

/** WAR-ROOM-UI v2: the brain report and number health, in a sheet over the page. */
export default function HealthSheet({ view, open, onClose }: { view: WarRoomView; open: boolean; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { if (open) closeRef.current?.focus?.(); }, [open]);
  if (!open) return null;
  return (
    <>
      <div className="wr-scrim" onClick={onClose} aria-hidden />
      <div className="wr-sheet" role="dialog" aria-modal="true" aria-label="Is the brain working?" data-testid="health-sheet">
        <div className="wr-drawer-h">
          <div><div className="wr-ch-t">Is the brain working?</div>
            <div className="wr-ch-s">Nothing turns green until its check passes.</div></div>
          <span className="wr-sp" />
          <button type="button" className="wr-icon-btn" onClick={onClose} aria-label="Close health" ref={closeRef}>×</button>
        </div>
        <div className="wr-sheet-b" data-panel="brain_report">
          <BrainCheckCard brain={view.brain_report} health={view.number_health} big />
        </div>
      </div>
    </>
  );
}
