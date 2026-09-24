import type { CatchUpItem, Field, Num, SpeedPoint } from './types';
import { FieldBlock, Val } from './FieldState';
import { pts } from './format';
import { usePager } from './Panel';

/**
 * Catch-up list (cheapest way back first) and the speed curve (arrive by week N at net
 * gain X). The curve draws producer points and computes nothing: x is the point's slot,
 * y is its value scaled to the box.
 */
export default function CatchUp({ catchUp, speed, groundLost, big }: {
  catchUp: Field<CatchUpItem[]> | undefined; speed: Field<SpeedPoint[]> | undefined; groundLost: Num | undefined; big: boolean;
}) {
  const items = catchUp?.status === 'ok' && catchUp.value ? catchUp.value : [];
  const pg = usePager(items.length, big ? 5 : 2);
  return (
    <>
      <div className="wr-sub">Ground lost vs plan: <Val f={groundLost} fmt={pts} /></div>
      <FieldBlock f={catchUp} label="Catch-up list">
        {list => (
          <>
            <div className="wr-row"><span className="wr-sp" />{pg.control}</div>
            <ol className="wr-list">
              {list.slice(pg.a, pg.b).map((c, i) => (
                <li key={i}><b>{c.text}</b> <span className="wr-muted"><Val f={c.gain} fmt={pts} />{c.steps ? `, ${c.steps} step${c.steps > 1 ? 's' : ''}` : ', no trade'}</span></li>
              ))}
            </ol>
          </>
        )}
      </FieldBlock>
      <div className="wr-cap">Arrive by (net gain)</div>
      <FieldBlock f={speed} label="Speed curve">
        {pts_ => <SpeedChart points={pts_} big={big} />}
      </FieldBlock>
    </>
  );
}

function SpeedChart({ points, big }: { points: SpeedPoint[]; big: boolean }) {
  const W = big ? 300 : 200, H = big ? 90 : 54;
  const vals = points.map(p => (p.net.status === 'ok' && typeof p.net.value === 'number' ? p.net.value : null));
  const known = vals.filter((v): v is number => v != null);
  if (!known.length) return <div className="wr-state">Speed curve not computed yet.</div>;
  const max = Math.max(...known), min = Math.min(0, ...known);
  const sx = (i: number) => 14 + (i * (W - 28)) / Math.max(1, points.length - 1);
  const sy = (v: number) => H - 14 - ((v - min) / Math.max(1e-9, max - min)) * (H - 24);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="Speed curve: net gain by arrival week">
      <line x1={8} y1={H - 14} x2={W - 6} y2={H - 14} stroke="var(--wr-line)" />
      {points.map((p, i) => {
        const v = vals[i];
        return (
          <g key={p.arrive_by}>
            {v != null && <circle cx={sx(i)} cy={sy(v)} r={p.picked ? 4 : 2.5} fill={p.picked ? 'var(--wr-ink)' : 'var(--wr-muted)'} />}
            <text x={sx(i)} y={H - 3} textAnchor="middle">wk {p.arrive_by}</text>
          </g>
        );
      })}
    </svg>
  );
}
