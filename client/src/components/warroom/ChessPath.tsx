import { useState } from 'react';
import type { ChessPathItem, ChessStep, Field } from './types';
import { FieldBlock, Val } from './FieldState';
import { isOk, pct, pts, se } from './format';

/**
 * UI-ENG-5: the planner's chess path (trade -> claim -> flip, CHESS-01a) as a stepper.
 * One path at a time ("Path 1 of 4 ‹ ›"). Each step shows its own chance he says yes and
 * your title odds after it; under it, what happens when it fails: what you keep, and the
 * backup branch the search kept for that point. Compact panel: the branch of the selected
 * step only. Big (expanded, or the phone deck): every branch. Numbers are the producer's.
 */
export default function ChessPath({ field, big }: { field: Field<{ note: string; paths: ChessPathItem[] }> | undefined; big: boolean }) {
  const [idx, setIdx] = useState(0);
  const [sel, setSel] = useState(0);
  return (
    <FieldBlock f={field} label="Chess path">
      {cp => {
        const i = Math.min(idx, cp.paths.length - 1);
        const p = cp.paths[i];
        const go = (to: number) => { setIdx(to); setSel(0); };
        return (
          <div className="wr-chess">
            <div className="wr-row wr-sub">
              <b className="wr-ink">{p.kinds}</b>
              <span className="wr-sp" />
              <span className="wr-pg">
                <button type="button" aria-label="Previous path" disabled={i === 0} onClick={() => go(i - 1)}>‹</button>
                Path {p.rank} of {cp.paths.length}
                <button type="button" aria-label="Next path" disabled={i >= cp.paths.length - 1} onClick={() => go(i + 1)}>›</button>
              </span>
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
                <Step key={`${p.rank}-${s.n}`} s={s} last={k === p.steps.length - 1} selected={sel === k}
                  showBranch={big || sel === k} onSelect={() => setSel(k)} big={big} />
              ))}
            </ol>
            {big && <div className="wr-hint">{cp.note}</div>}
          </div>
        );
      }}
    </FieldBlock>
  );
}

function Step({ s, last, selected, showBranch, onSelect, big }: {
  s: ChessStep; last: boolean; selected: boolean; showBranch: boolean; onSelect: () => void; big: boolean;
}) {
  const b = s.if_fails.backup;
  return (
    <li data-step={s.n} className={`wr-step wr-step-${s.kind}${selected ? ' wr-sel' : ''}${last ? ' wr-last' : ''}`}>
      <button type="button" className="wr-step-h" onClick={onSelect} aria-pressed={selected}>
        <span className="wr-n">{s.n}</span>
        <span className={`wr-kind wr-kind-${s.kind}`}>{s.kind_label}</span>
        <span className="wr-lab"><b>{s.line}</b></span>
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
          <span className="wr-k">{s.fail_label}</span>{' '}
          {s.if_fails.keep_text}
          {isOk(s.if_fails.keep) && <> Odds stay <Val f={s.if_fails.keep} fmt={pts} /> vs today.</>}
          <div className="wr-bk">
            <b>Backup</b>{' '}
            {isOk(b) ? (
              <>
                <span className={`wr-kind wr-kind-${b.value.kind}`}>{b.value.kind_label}</span> {b.value.line}
                <span className="wr-muted"> · P(yes) <Val f={b.value.p_yes} fmt={v => pct(v)} /> · after <Val f={b.value.change_after} fmt={pts} /> · from path {b.value.path_rank}</span>
              </>
            ) : <Val f={b} fmt={() => ''} showReason />}
          </div>
        </div>
      )}
    </li>
  );
}
