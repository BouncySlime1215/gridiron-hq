import type { CloneBand, CloneRow, ClonesView, CloneWord } from './types';
import { useContext } from 'react';
import { FieldBlock, SourcesContext, SourceTag, Val } from './FieldState';
import { pct, pts } from './format';
import { usePager } from './Panel';

/**
 * UI-ENG-4: the clone view, one row per league-mate. How he reads (labels), the chance he
 * says yes to a deal that passes our edge test (a band, never a point), the top reasons,
 * who he is in the market for, whether his shop talk holds, and his tells (typed
 * "tells not live" until TELLS-01b is merged).
 *
 * Labels only: nothing here quotes the chat. It formats what the server wrote and
 * computes nothing (WAR-ROOM-UI.md 2.1).
 */
export const WORD_LABEL: Record<CloneWord['label'], string> = {
  credible: 'His shop talk holds',
  mixed: 'His shop talk partly holds',
  cheap_talk: 'His shop talk is cheap',
};
const STANDING_LABEL: Record<CloneRow['standing'], string | null> = {
  active: 'active', normal: null, deprioritised: 'low priority', excluded: 'left out',
};

export const band = (b: CloneBand) => `${pct(b.low)}–${pct(b.high)}`;
const wordText = (w: CloneWord) => `${WORD_LABEL[w.label]}${w.from === 'record' ? ` (${w.held ?? 0} of ${w.n} held)` : ' (profile)'}`;
const effect = (e: number | null) => (e == null ? '' : ` ${pts(e)}`);

function Row({ c, big }: { c: CloneRow; big: boolean }) {
  const standing = STANDING_LABEL[c.standing];
  const wants = c.wants.status === 'ok' ? c.wants.value ?? [] : [];
  return (
    <li className={`wr-clone${c.standing === 'excluded' ? ' wr-clone-out' : ''}`} data-team={c.team}>
      <div className="wr-row">
        <b>{c.label}</b>
        {standing && <span className={`wr-pill${c.standing === 'active' ? ' wr-pill-next' : ' wr-pill-warn'}`}>{standing}</span>}
        <span className="wr-sp" />
        <span className="wr-num" title="Chance he says yes to a deal that passes our edge test">
          <Val f={c.p_accept} fmt={band} />
          {c.p_accept.status === 'ok' && c.p_accept.note && <span className="wr-muted"> · {c.p_accept.note}</span>}
        </span>
        {big && c.p_accept.status === 'ok' && <SourceTag id={c.p_accept.source} />}
      </div>

      {c.nick.length > 0 && <div className="wr-sub">{c.nick.join(' · ')}</div>}

      {wants.length > 0 && (
        <div className="wr-row wr-wants">
          {wants.slice(0, big ? 4 : 1).map(w => (
            <span key={w.player.id} className={`wr-pill${w.state === 'fresh' ? ' wr-pill-run' : ''}`}
              title={`Said ${w.age_days} days ago. Strong for 7 days, fades by day 21.`}>
              wants {w.player.name}{w.state === 'fading' ? ' · fading' : ''}{w.you_have ? ' · you have him' : ''}
            </span>
          ))}
        </div>
      )}

      <div className="wr-sub">
        <Val f={c.credibility} fmt={wordText} showReason={big} />
      </div>

      {big && (
        <>
          <div className="wr-cap">How he reads</div>
          <FieldBlock f={c.profile} label="His profile">
            {p => (p.traits.length
              ? <div className="wr-row wr-wrap">{p.traits.map(t => <span key={t.key} className="wr-pill">{t.label}</span>)}</div>
              : <div className="wr-sub">Read, but no trait stands out.</div>)}
          </FieldBlock>
          <div className="wr-cap">Tells</div>
          <FieldBlock f={c.tells} label="Tells">
            {ts => (ts.length
              ? <div className="wr-row wr-wrap">{ts.map(t => <span key={t.id} className="wr-pill">{t.label} · n={t.n} · {t.grade}</span>)}</div>
              : <div className="wr-sub">No graded tell for him yet.</div>)}
          </FieldBlock>
          <div className="wr-cap">Top reasons</div>
          <FieldBlock f={c.reasons} label="Reasons">
            {rs => (
              <ol className="wr-reasons">
                {rs.map((r, i) => <li key={i}>{r.label}<span className="wr-muted">{effect(r.effect)}</span></li>)}
              </ol>
            )}
          </FieldBlock>
        </>
      )}
      {!big && c.reasons.status === 'ok' && c.reasons.value?.[0] && (
        <div className="wr-hint">Why: {c.reasons.value[0].label}</div>
      )}
    </li>
  );
}

export default function CloneBoard({ view, big }: { view: ClonesView | null | undefined; big: boolean }) {
  const field = view?.clones;
  const list = field?.status === 'ok' && field.value ? field.value : [];
  const pg = usePager(list.length, big ? 4 : 2);
  const outer = useContext(SourcesContext);
  if (!view) return <div className="wr-state" role="status" data-state="unknown">Clone reads loading.</div>;
  return (
    <SourcesContext.Provider value={{ ...outer, ...(view.sources ?? {}) }}>
    <FieldBlock f={field} label="Clone reads">
      {rows => (
        <>
          <div className="wr-row wr-sub">
            <span>Chance he says yes · why · what he wants · does his talk hold</span>
            <span className="wr-sp" />{pg.control}
          </div>
          {view.banner && <div className="wr-hint">{view.banner}</div>}
          <ul className="wr-clones">
            {rows.slice(pg.a, pg.b).map(c => <Row key={c.team} c={c} big={big} />)}
          </ul>
        </>
      )}
    </FieldBlock>
    </SourcesContext.Provider>
  );
}
