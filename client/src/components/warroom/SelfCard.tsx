import type { BiasFlag, GuardedReoffer, SelfKind, SelfRegret, SelfView } from './types';
import { FieldBlock } from './FieldState';
import { pct } from './format';

/**
 * SELF-01b: the follow / ignore card. Per call kind, how often Nick followed or skipped
 * what the app showed him, and the habits that have earned a flag: each one called his
 * own later weeks better than the base rate (server/services/engine/self-bias.js).
 * Habits that did not pass are a count only. It formats what the server wrote and
 * computes nothing (WAR-ROOM-UI.md 2.1).
 */
const kindLine = (k: SelfKind) => {
  const aside = [k.no_action ? `no move ${k.no_action}` : '', k.open ? `open ${k.open}` : ''].filter(Boolean).join(' · ');
  return `followed ${k.follow} · skipped ${k.ignore}${aside ? ` · ${aside}` : ''}`;
};
const record = (f: BiasFlag) =>
  `right ${f.forward.hits} of ${f.forward.n} later calls (${pct(f.forward.precision)}), base ${pct(f.forward.base_rate)}`;

const regretLine = (r: SelfRegret) => {
  const settled = r.scored
    ? `${r.regrets} of ${r.scored} settled choices went better the other way (net ${r.realised_regret} pts)`
    : 'none settled yet';
  return `${r.choices} choices · ${settled} · ${r.open} still open`;
};
const weekOf = (period: number) => `wk ${period % 100}`;
const guardLine = (g: GuardedReoffer) =>
  `${weekOf(g.period)}: gave ${g.concession.toFixed(1)} pts/wk more, your norm ${g.norm.toFixed(1)}`;

export default function SelfCard({ view, big }: { view: SelfView | null | undefined; big: boolean }) {
  if (!view) return <div className="wr-state" role="status" data-state="unknown">Your record is loading.</div>;
  if (!view.enabled) return <div className="wr-state" role="status" data-state="unknown">This card is off.</div>;
  const held = view.held ?? 0;
  return (
    <>
      <div className="wr-cap">Habits</div>
      <FieldBlock f={view.flags} label="Bias flags">
        {flags => (flags.length ? (
          <ul className="wr-self-flags">
            {flags.map(f => (
              <li key={f.category} data-bias={f.bias}>
                <b>{f.label}</b>
                <div className="wr-sub wr-muted">{record(f)}</div>
              </li>
            ))}
          </ul>
        ) : <div className="wr-sub">No habit has earned a flag yet.</div>)}
      </FieldBlock>
      {held > 0 && <div className="wr-hint">{held} more held back: not yet borne out on your later weeks.</div>}

      <div className="wr-cap">Followed or skipped</div>
      <FieldBlock f={view.follow} label="Follow record">
        {v => (
          <ul className="wr-self-kinds">
            {v.kinds.map(k => (
              <li key={k.kind} className="wr-row">
                <span>{k.label}</span><span className="wr-sp" />
                <span className="wr-num">{kindLine(k)}</span>
              </li>
            ))}
          </ul>
        )}
      </FieldBlock>
      <div className="wr-cap">Regret ledger</div>
      <FieldBlock f={view.regret} label="Regret ledger">
        {r => <div className="wr-sub">{regretLine(r)}</div>}
      </FieldBlock>

      <div className="wr-cap">Re-offer guard</div>
      <FieldBlock f={view.guard} label="Re-offer guard">
        {g => (
          <ul className="wr-self-flags">
            {g.reoffers.map(r => <li key={`${r.period}-${r.concession}`}>{guardLine(r)}</li>)}
          </ul>
        )}
      </FieldBlock>

      <div className="wr-cap">Clone</div>
      <FieldBlock f={view.clone} label="Clone">{() => null}</FieldBlock>
      {big && view.note && <div className="wr-hint">{view.note}</div>}
    </>
  );
}
