import type { BrainCheck, Field, NumberHealth } from './types';
import { NOT_COMPUTED } from './format';

/** Plain names for E1-E7 (WAR-ROOM-UI.md 3.7). Labels only; statuses come from EVAL-01. */
export const CHECKS = [
  ['E1', 'Does 40% mean 40%? (chance he says yes)'],
  ['E2', 'Are our offers priced right?'],
  ['E3', 'Does 20% title odds mean 20%?'],
  ['E4', 'Does the planner beat simple moves?'],
  ['E5', 'Did each step really help?'],
  ['E6', 'Following the brain vs ignoring it'],
  ['E7', 'Luck vs decisions (Mondays)'],
] as const;

const PILL: Record<string, [string, string]> = {
  passing: ['wr-pill-next', 'passing'], failing: ['wr-pill-warn', 'failing'], running: ['wr-pill-run', 'running'],
  not_enough_data: ['', 'not enough data'], not_run: ['', 'not run'],
};

/** Is the brain working? E1-E7 statuses + the number-health dot. Never green by default. */
export default function BrainCheckCard({ brain, health, big }: {
  brain: Field<BrainCheck> | undefined; health: Field<NumberHealth> | undefined; big: boolean;
}) {
  const byId = new Map((brain?.status === 'ok' && brain.value ? brain.value.checks : []).map(c => [c.id, c]));
  return (
    <>
      <div className={`wr-echk${big ? ' wr-echk-big' : ''}`}>
        {CHECKS.map(([id, name]) => {
          const c = byId.get(id);
          const [cls, text] = c ? PILL[c.status] ?? ['', c.status] : ['', NOT_COMPUTED];
          return (
            <div key={id} title={name}>
              <span className="wr-id">{id}</span>
              {big && <span className="wr-echk-name">{name}</span>}
              <span className={`wr-pill ${cls}`}>{text}</span>
            </div>
          );
        })}
      </div>
      {brain?.status !== 'ok' && <p className="wr-sub wr-reason">{brain?.status === 'failed' ? 'Brain check failed: ' : ''}{brain?.reason ?? `Brain check ${NOT_COMPUTED}.`}</p>}
      {brain?.status === 'ok' && brain.value?.blocks.map((b, i) => <p key={i} className="wr-sub wr-red">{b}</p>)}
      <div className="wr-health"><HealthDot health={health} /></div>
    </>
  );
}

/** Number health (BROKEN-01): grey until the audit exists; never green by default. */
export function HealthDot({ health, compact }: { health: Field<NumberHealth> | undefined; compact?: boolean }) {
  const s = health?.status === 'ok' && health.value ? health.value.status : null;
  const color = s === 'broken' ? 'red' : s === 'warn' ? 'amber' : s === 'ok' ? 'green' : 'grey';
  const text = s === 'broken' ? 'numbers broken' : s === 'warn' ? `${health?.value?.open.length ?? 0} warning(s)` : s === 'ok' ? 'numbers checked'
    : health?.status === 'failed' ? 'number check failed' : `number check ${NOT_COMPUTED}`;
  return (
    <span className="wr-dotwrap" title={health?.reason ?? text} data-health={color}>
      <span className={`wr-dot wr-dot-${color}`} />{compact ? null : <><b>Numbers:</b> {text}</>}
    </span>
  );
}
