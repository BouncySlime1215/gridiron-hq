# UI STANDARD (2026-09-23 ~2:35 AM ET; Nick: "the UI will be VERY VERY VERY good"). Applies to every page change; verified by the ui lens (VERIFICATION-RULES.md E).
1. One system. The C-12 design system (PR #73, verified in phase 0) is the only source of colours, type, spacing and components. No page-local styles.
2. One currency. Title odds first ("6% -> 10%"), then points ("+9 pts/wk in RB2 for 12 weeks"), then the why with its cited number. Deltas carry arrows and intervals; guesses carry the amber "guess" label; thin data says "thin (n=3)".
3. Three lines per card: what / why (cited) / what to do. A tap opens the evidence; a second tap acts. Nothing else on the card.
4. One tap to act, confirm only when irreversible (send an offer, apply a lineup). Undo where the platform allows.
5. Colour means one thing: green = verified gain, amber = guess or thin, red = risk or dead starter, grey = no change. Never colour for decoration.
6. States are designed, not defaulted: loading (skeleton), empty ("no offers yet, here's why"), thin, error (what failed and the retry), stale (age shown).
7. Mobile first (D23): 375 px with no horizontal scroll; thumb-reachable actions; the command center is a phone screen. Desktop adds columns, never new content.
8. Speed: a page paints in under 1 s on cached data; heavy numbers arrive from the DB (engine results), never computed in the request.
9. Words: plain English, no jargon on cards ("chance he plays", not "availability prior"); no walls of text; no file paths; names only in-app.
10. Consistency: the same component shows the same number everywhere (OddsLadder, SignalChip, TagPill, ScenarioCard, ReportCard, ReceiptCard, GuessLabel are shared).
11. Accessibility: keyboard reachable, contrast AA, labels on every control, dark mode.
12. Proof: every page change ships with screenshots of its states (normal, empty, thin, error, mobile, dark) attached to the PR, taken by the ui skeptic against the local server; a UI researcher (R6) benchmarks each surface against the best fantasy tools and files UI units against this standard.
Surfaces (8 tabs unchanged): My team = ladder, scenarios, report card, luck ledger, risk. Trade Brain = target board, offers out, counters in, roadmap tree, regression radar, receipts. Trade Lab = evaluate any deal. Start/Sit = guard, availability chips, floor/ceiling, late-swap windows, live tracker. League Hub = manager reads, streaming board, injury alerts, command center. News = research feed and briefs. Settings = caps, alerts, autopilot scope, model zoo.
