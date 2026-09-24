import { useState } from 'react';
import type { Chess, ChessMove, ChessStep, Field } from './types';
import { namer, teamLabel } from './types';
import { FieldBlock, Val } from './FieldState';
import { isOk, pct, pts, se } from './format';

/** Until CHESS-01-b passes, the panel says this instead of drawing a path (ENGINE-SPECS UI-ENG-5). */
export const CHESS_FALLBACK = 'Path search is off: it has not beaten single trades in the replay test yet (CHESS-01-b).';

const KIND_LABEL = { trade: 'Trade', claim: 'Claim', flip: 'Flip' } as const;

type Names = ReturnType<typeof namer>;

/** The words for one move, from its ids and the league's names. */
function moveLine(n: Names, m: ChessMove): string {
  if (m.kind === 'claim') {
    const get = n.text(m.get);
    return m.give.length ? `Claim ${get}, drop ${n.text(m.give)}` : `Claim ${get} into an open spot`;
  }
  return `${teamLabel(m.partner)}: ${m.kind === 'flip' ? 'pass on' : 'give'} ${n.text(m.give)} for ${n.text(m.get)}`;
}

/**
 * UI-ENG-5: the producer's chess paths (CHESS-01a, the contract's `chess` section) as a
 * stepper. One path at a time ("Path 1 of 4 ‹ ›"). Each step shows its week, its own chance
 * he says yes and your title odds after it; a step whose change sits inside 2 SE is greyed.
 * Under a step: what you keep if it fails, and the backup branch the search kept for that
 * point. No step after the trade deadline is in the section. Until CHESS-01-b's pass flag is
 * set, only the fallback line shows. Compact: the selected step's branch; big: all branches.
 */
export default function ChessPath({ field, names, big }: {
  field: Field<Chess> | undefined; names: Record<string, string> | undefined; big: boolean;
}) {
  const [idx, setIdx] = useState(0);
  const [sel, setSel] = useState(0);
  const n = namer(names);
  return (
    <FieldBlock f={field} label="Chess path">
      {cp => {
        if (!cp.replay_passed) return <div className="wr-state" role="status" data-state="off">{CHESS_FALLBACK}</div>;
        const i = Math.min(idx, cp.paths.length - 1);
        const p = cp.paths[i];
        const go = (to: number) => { setIdx(to); setSel(0); };
        return (
          <div className="wr-chess">
            <div className="wr-row wr-sub">
              <b className="wr-ink">{p.steps.map(s => KIND_LABEL[s.kind]).join(' → ')}</b>
              <span className="wr-sp" />
              <span className="wr-pg">
                <button type="button" aria-label="Previous path" disabled={i === 0} onClick={() => go(i - 1)}>‹</button>
                Path {p.rank} of {cp.paths.length}
                <button type="button" aria-label="Next path" disabled={i >= cp.paths.length - 1} onClick={() => go(i + 1)}>›</button>
              </span>
            </div>
            <div className="wr-sub wr-deadline">
              Trade deadline: {cp.deadline_week == null ? 'unknown' : `week ${cp.deadline_week}`}
              {p.cut_at_deadline > 0 && <> · {p.cut_at_deadline} step{p.cut_at_deadline > 1 ? 's' : ''} after the trade deadline dropped</>}
            </div>
            <div className="wr-tiles">
              <div className="wr-tile"><div className="wr-l">P(all land)</div><div className="wr-v"><Val f={p.p_complete} fmt={v => pct(v)} /></div></div>
              <div className="wr-tile"><div className="wr-l">Expected</div><div className="wr-v"><Val f={p.expected} fmt={pts} /></div></div>
              <div className="wr-tile"><div className="wr-l">If all land</div><div className="wr-v"><Val f={p.full} fmt={pts} /></div>
                {big && isOk(p.full) && typeof p.full.se === 'number' && <div className="wr-s">{se(p.full.se)}</div>}</div>
            </div>
            {p.vs_single && (
              <div className="wr-sub">vs the best single offer: <Val f={p.vs_single.full} fmt={pts} showSe /> if all land, <Val f={p.vs_single.expected} fmt={pts} /> expected</div>
            )}
            <ol className="wr-steps" aria-label={`Path ${p.rank} steps`}>
              {p.steps.map((s, k) => (
                <Step key={`${p.rank}-${s.n}`} n={n} s={s} prev={k > 0 ? p.steps[k - 1] : null} last={k === p.steps.length - 1}
                  selected={sel === k} showBranch={big || sel === k} onSelect={() => setSel(k)} big={big} />
              ))}
            </ol>
            <div className="wr-sub wr-argument">
              {isOk(p.argument)
                ? <><b>Argument.</b> {p.argument.value.believes} {p.argument.value.why_yes} {p.argument.value.could_go_wrong} {p.argument.value.would_change}</>
                : <>Argument: <Val f={p.argument} fmt={() => ''} showReason /></>}
            </div>
            {big && <div className="wr-hint">Searched paths, best expected gain first. The chance you finish multiplies the steps' chances; a claim is assumed to clear. One step a week from now.</div>}
          </div>
        );
      }}
    </FieldBlock>
  );
}

function Step({ n, s, prev, last, selected, showBranch, onSelect, big }: {
  n: Names; s: ChessStep; prev: ChessStep | null; last: boolean; selected: boolean; showBranch: boolean; onSelect: () => void; big: boolean;
}) {
  const b = s.backup;
  const grey = isOk(s.change_after) && s.change_after.clears_2se !== true;
  const keepText = s.n === 1 ? 'You keep today\'s roster and odds.' : s.n === 2 ? 'You keep step 1.' : `You keep steps 1-${s.n - 1}.`;
  return (
    <li data-step={s.n} className={`wr-step wr-step-${s.kind}${selected ? ' wr-sel' : ''}${last ? ' wr-last' : ''}${grey ? ' wr-grey' : ''}`}>
      <button type="button" className="wr-step-h" onClick={onSelect} aria-pressed={selected}>
        <span className="wr-n">{s.n}</span>
        <span className={`wr-kind wr-kind-${s.kind}`}>{KIND_LABEL[s.kind]}</span>
        <span className="wr-lab"><b>{moveLine(n, s)}</b></span>
        {s.week != null && <span className="wr-muted wr-wk">Week {s.week}</span>}
      </button>
      <div className="wr-step-v wr-sub">
        P(yes){' '}
        {s.kind === 'claim' && s.p_yes.status === 'unknown'
          ? <b className="wr-muted" title={s.p_yes.reason}>not modelled (rival claims)</b>
          : <b className="wr-ink"><Val f={s.p_yes} fmt={v => pct(v)} showReason={big} /></b>}
        {' · '}title odds after <b className="wr-ink"><Val f={s.change_after} fmt={pts} showSe={big} /></b> vs today
        {isOk(s.title_after) && <> (<Val f={s.title_after} fmt={v => pct(v, 1)} />)</>}
      </div>
      {showBranch && (
        <div className="wr-branch" data-branch={s.n}>
          <span className="wr-k">{s.kind === 'claim' ? 'If the claim fails' : 'If he says no'}</span>{' '}
          {keepText}
          {prev && isOk(prev.change_after) && <> Odds stay <Val f={prev.change_after} fmt={pts} /> vs today.</>}
          <div className="wr-bk">
            <b>Backup</b>{' '}
            {isOk(b) ? (
              <>
                <span className={`wr-kind wr-kind-${b.value.kind}`}>{KIND_LABEL[b.value.kind]}</span> {moveLine(n, b.value)}
                <span className="wr-muted"> · P(yes) <Val f={b.value.p_yes} fmt={v => pct(v)} /> · after <Val f={b.value.change_after} fmt={pts} /> · from path {b.value.path_rank}</span>
              </>
            ) : <Val f={b} fmt={() => ''} showReason />}
          </div>
        </div>
      )}
    </li>
  );
}
