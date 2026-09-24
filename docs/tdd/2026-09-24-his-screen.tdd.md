# HIS-SCREEN: an offer as the partner sees it (2026-09-24)

Source: `docs/handoff/local/WAR-ROOM-UI.md` v3, new mode 2 ("preview the offer the
way he sees it, so every offer is fair on his screen"), and the deck card's
"fair on HIS screen" check; COACH-ANCHOR.md job 5 ("open his screen"). Branched
from `claude/cloud-fix-03` (d7736fe). Target league: `leagues.id` 4.

## 0. Audit (extend or build)

- "His screen" already meant one thing in this code: `paths.js#screenPct`, what
  he gets minus what he gives over what he gives, with the finder's window
  `SCREEN_WINDOW` (-12% to +18%). Reused, not redefined.
- "His clone's value view" is the counterparty layer: `counterparty-pricing.js#readDeal`
  (package, capped +/-15%) and `#playerValuation` (per player). The same functions
  price every step in the producer (`league-adapter.mjs#priceStep` / `#priceOf`),
  so the badge and the plan cannot disagree. No new valuation.
- His title-odds change is `season-sim.js#tradeImpact(...).them`, the one paired
  sim every title-odds surface reads (same seed, same runs). No new sim.
- Decision: **build** one module, `server/services/campaign/his-screen.js`
  (pure `buildHisScreen` + DB wrapper `hisScreenFor`), one route
  (`GET /api/trades/:leagueId/his-screen`), one component
  (`client/src/components/warroom/HisScreen.tsx`), mounted as a "His screen" toggle
  on `TradeCard` so it is reachable before the War Room page lands (FIX-04 can mount
  `HisScreenView` / `FairBadge` on the deck card). No migration.

## 1. Tests (RED first)

`test/campaign-his-screen.test.js` (11 tests).

RED (commit `2f02c11`, implementation absent):

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../server/services/campaign/his-screen.js'
```

GREEN: `# pass 11 # fail 0`.

What they pin:
- roster before/after, leaves/arrives, position counts, `fills_need` from his needs read;
- the badge reads the clone's %, not market (a fixture where market says fair and his
  clone says short);
- no clone -> `fair` and `value_view` are `unknown` with a reason; the market % is still
  shown and labelled market;
- window edges inclusive; his title odds typed with SE and the 2-SE check; sim failure is
  a sentence;
- the wrapper hands `readDeal` HIS side (he gives what Nick gets) and `tradeImpact` Nick's
  side; bad offers are refused with the reason;
- flag: off -> `{ enabled: false, reason }`; `GRIDIRON_HIS_SCREEN=1` on; preview on with
  `preview: true` + `preview_reason`; an explicit `enabled: false` beats preview;
- every `source` on the output is in `plans-schema.js#SOURCE_IDS`.

## 2. Flag

Site flag `GRIDIRON_HIS_SCREEN` (default off). `preview-mode.js#previewUnconfirmed()`
turns it on locally; the response then carries `preview: true` and the default-off
reason, and the component prints it. `preview-mode.js` stays the only reader of
`GRIDIRON_PREVIEW_UNCONFIRMED`.

## 3. Not confirmed

- Real-data numbers on league 4 (clone coverage, how often the badge is `fair` for
  finder deals, sim latency per offer) need the local DB:
  `node scripts/campaign/his-screen-probe.mjs --league 4 --partners 3`.
- Whether "fair on his screen" predicts a yes is E1/E2's question; this unit only
  shows his clone's view.
