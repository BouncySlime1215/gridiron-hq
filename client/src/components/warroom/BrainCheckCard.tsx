import type { BrainReport, Field, NumberHealth, NumberHealthCheck } from './types';
import { NOT_COMPUTED } from './format';

/** Plain names for E1-E7 (WAR-ROOM-UI.md 3.7), used when the report omits a check. Statuses come from `brain_report`. */
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

/** Is the brain working? `brain_report` E1-E7 statuses + the number-health dot. Never green by default. */
export default function BrainCheckCard({ brain, health, big }: {
  brain: Field<BrainReport> | undefined; health: Field<NumberHealth> | undefined; big: boolean;
}) {
  const byId = new Map((brain?.status === 'ok' && brain.value ? brain.value.checks : []).map(c => [c.id, c]));
  return (
    <>
      <div className={`wr-echk${big ? ' wr-echk-big' : ''}`}>
        {CHECKS.map(([id, name]) => {
          const c = byId.get(id);
          const [cls, text] = c ? PILL[c.status] ?? ['', c.status] : ['', NOT_COMPUTED];
          return (
            <div key={id} title={c ? `${c.name}. Bar: ${c.bar}` : name}>
              <span className="wr-id">{id}</span>
              {big && <span className="wr-echk-name">{c?.name ?? name}</span>}
              <span className={`wr-pill ${cls}`}>{text}</span>
              {big && c?.result && <span className="wr-muted"> {c.result}</span>}
            </div>
          );
        })}
      </div>
      {brain?.status !== 'ok' && <p className="wr-sub wr-reason">{brain?.status === 'failed' ? 'Brain check failed: ' : ''}{brain?.reason ?? `Brain check ${NOT_COMPUTED}.`}</p>}
      {brain?.status === 'ok' && brain.value?.blocks.map((b, i) => <p key={i} className="wr-sub wr-red">{b}</p>)}
      {brain?.status === 'ok' && brain.value?.fell_back_to && <p className="wr-sub wr-amber">The brain check is not passing, so the plan runs in Balanced mode.</p>}
      <div className="wr-health"><BrainDot brain={brain} /> <HealthDot health={health} /></div>
    </>
  );
}

const BRAIN_WORDS: Record<string, string> = { passing: 'passing', failing: 'failing', not_enough_data: 'not enough data yet' };

/**
 * The brain dot reads the report's `overall` (passing / failing / not_enough_data), not the
 * field's `status`: an ok field with not_enough_data says so instead of looking uncomputed.
 */
export function BrainDot({ brain, compact }: { brain: Field<BrainReport> | undefined; compact?: boolean }) {
  const o = brain?.status === 'ok' && brain.value && BRAIN_WORDS[brain.value.overall] ? brain.value.overall : null;
  const color = o === 'failing' ? 'red' : o === 'passing' ? 'green' : 'grey';
  const text = o ? BRAIN_WORDS[o] : brain?.status === 'failed' ? 'brain check failed' : `brain check ${NOT_COMPUTED}`;
  return (
    <span className="wr-dotwrap" data-brain={o ?? brain?.status ?? 'unknown'}
      title={o ? `Brain check: ${text}` : brain?.reason ?? text}>
      <span className={`wr-dot wr-dot-${color}`} />{compact ? null : <><b>Brain:</b> {text}</>}
    </span>
  );
}

const HEALTH_COLOR: Record<string, string> = { ok: 'green', warn: 'amber', broken: 'red' };
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** The contract value, or null when the field is not ok or the value is not the contract's shape. */
function healthValue(health: Field<NumberHealth> | undefined): NumberHealth | null {
  const v = health?.status === 'ok' ? health.value : undefined;
  return v && HEALTH_COLOR[v.overall] && Array.isArray(v.checks) ? v : null;
}

/** "1 broken, 2 warnings" / "all 11 checks pass", from the counts the producer wrote. */
function healthText(v: NumberHealth) {
  if (v.overall === 'ok') return `all ${v.ok} checks pass`;
  return [v.broken > 0 && `${v.broken} broken`, v.warn > 0 && plural(v.warn, 'warning')].filter(Boolean).join(', ');
}

/** The checks that are not ok, broken first. */
const openChecks = (v: NumberHealth): NumberHealthCheck[] =>
  [...v.checks.filter(c => c.status === 'broken'), ...v.checks.filter(c => c.status === 'warn')];

/**
 * Number health (BROKEN-01): the contract's number_health (plans-schema.js) — `overall`
 * ok / warn / broken is green / amber / red with the broken and warn counts; the open
 * checks' names are on hover and, in the full dot, in a list. Grey with its reason until
 * the audit exists; never green by default.
 */
export function HealthDot({ health, compact }: { health: Field<NumberHealth> | undefined; compact?: boolean }) {
  const v = healthValue(health);
  const color = v ? HEALTH_COLOR[v.overall] : 'grey';
  const open = v ? openChecks(v) : [];
  const text = v ? healthText(v)
    : health?.status === 'failed' ? 'number check failed'
      : health?.status === 'ok' ? 'number check not readable' : `number check ${NOT_COMPUTED}`;
  const title = v
    ? (open.length ? open.map(c => `${c.status === 'broken' ? 'Broken' : 'Warning'}: ${c.title}`).join('\n') : `Numbers: ${text}`)
    : health?.reason ?? (health?.status === 'ok' ? 'The number audit is not in the contract shape.' : text);
  return (
    <>
      <span className="wr-dotwrap" title={title} data-health={color} data-overall={v?.overall ?? health?.status ?? 'unknown'}
        data-broken={v?.broken} data-warn={v?.warn}>
        <span className={`wr-dot wr-dot-${color}`} />{compact ? null : <><b>Numbers:</b> {text}</>}
      </span>
      {!compact && open.length > 0 && (
        <ul className="wr-sub wr-health-open">
          {open.map(c => (
            <li key={c.check_id} data-check={c.check_id} className={c.status === 'broken' ? 'wr-red' : 'wr-amber'}>
              {c.title}{c.detail && <span className="wr-muted"> {c.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
