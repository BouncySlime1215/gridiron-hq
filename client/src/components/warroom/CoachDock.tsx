/**
 * The docked Coach panel: a placeholder until WR-COACH fills it (typed UI actions, the
 * action log, confirm-gated plan changes). It reserves the column so the grid does not
 * move when Coach lands. Coach never sends an offer.
 */
export default function CoachDock({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <aside className={`wr-coach${open ? ' wr-open' : ''}`} aria-label="Coach">
      <div className="wr-ch" onClick={onToggle} role="button" tabIndex={0}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') onToggle(); }}>
        <div>
          <div className="wr-ch-t">Coach</div>
          <div className="wr-ch-s">Changes this screen for you. Never sends an offer.</div>
        </div>
        <span className="wr-tog" aria-hidden>{open ? '▼' : '▲'}</span>
      </div>
      <div className="wr-chat">
        <div className="wr-state">
          Coach docks here next (WR-COACH): ask it to show a panel, filter, pin a player, add a card from an engine field,
          or change the plan with the trade-off shown first. Not built yet.
        </div>
      </div>
      <form className="wr-ask" onSubmit={e => e.preventDefault()}>
        <input disabled placeholder="Coach turns on with WR-COACH" aria-label="Ask Coach" />
        <button type="submit" className="wr-btn wr-primary" disabled>Ask</button>
      </form>
    </aside>
  );
}
