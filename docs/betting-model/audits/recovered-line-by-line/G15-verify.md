# Verification notes — G15-client-fantasy claims #162-173

Repo: /Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard (read-only)

## #162 SourcePill / ingest_key — CONFIRMED, not refuted
- client/src/components/draft/SourcePill.tsx:42 calls `/drafts/${draftId}/capture-bookmarklet` with no query params.
- server/routes/draft-capture.js:40-43 `resolveIngestKey` reads ONLY `req.query.ingest_key`; :60-63 returns 400 if absent.
- `grep -rn "ingest-key|ingest_key" client/src client/public` → only two hits: SourcePill.tsx:42 (no key attached) and draft-capture.js (the in-browser capture script's outgoing POST body field, not a minting call). No client code anywhere calls `POST /drafts/:id/ingest-key`.
- Confirmed SourcePill is used exactly once, LiveDraft.tsx:430, with no ingestKey prop threading from anywhere.
- Verdict: TRUE as stated. The button always 400s. Whole WS-capture path (489-line draft-capture.js, draft-ingest.js, capture/ingest-status routes) is unreachable via UI. Board still works via 4s poll per claim's own concession. P1 stands — this is a fully-documented, memory-noted (Nick's "draft-night setup") feature that cannot be turned on from the app at all.

## #163 useDraftQueue seeding — CONFIRMED, not refuted
- client/src/features/draft/useDraftQueue.ts:17-19 confirmed verbatim.
- DraftRoom.tsx:59 `useDraftQueue(id, draft?.my_slot ?? 1, draft?.queue.map(q => q.player_id) ?? [])` — new array literal every render via `.map`, so the `[serverQueue]` effect re-checks every render (reference inequality every time).
- Mechanism verified: seeded.current only flips true once serverQueue.length > 0. A draft starts with an empty queue, so it stays unseeded through the whole early phase. If a user queues 3 players (3 sequential PUT calls, cumulative snapshots) and a refetch (e.g. after a CPU pick, DraftRoom.tsx:74-82 `cpuStep`→`refetch()`) lands between PUT #1 and PUT #2/#3, the server queue seen is `[a]`; the effect fires, seeds, and `setQueue([a])` clobbers local `[a,b,c]`. Worse: since local queue state is now wrong, a subsequent `add()` computes `next` from the now-incorrect local state and PUTs an array that permanently overwrites the correct server value once it's sent — real, permanent data loss of queued players, not just a transient display glitch.
- Verdict: TRUE, real bug, P2 as claimed (arguably could be argued higher given permanent-loss follow-on, but P2 is defensible).

## #164 draft-capture.js fatal/4xx unrecoverable — CONFIRMED, not refuted
- client/public/draft-capture.js:203-207 confirmed: any 4xx except 429 sets `state.fatal = true` permanently; `flush()` (:188) short-circuits forever once fatal.
- BATCH_MS=2000 (:21) but schedule() (:260-268) uses a 50ms delay whenever `state.outbox.length && !state.inflight && now() >= state.blockedUntil` — true forever once fatal, because `tick()` (:249-257)'s heartbeat-push condition doesn't check `state.fatal`, so once one heartbeat batch sits unflushed in the outbox (length stays ≥1 since flush() bails without shifting), the 50ms (20 Hz) branch is permanent. Confirmed 20 Hz spin claim exactly.
- Re-click recovery: bottom of file (:466-478) — the boot guard checks `!root.__GHQ_CAPTURE_INSTANCE__.state.stopped` (NOT `.fatal`) to decide whether a new script load is "already running... not attaching twice". `stop()` only sets `state.stopped`, never called on fatal. So a `state.fatal=true` instance still reports `stopped===false`, and re-running the bookmarklet hits the "already running" branch, reuses the dead fatal instance, and never resets `fatal`. Recovery via re-click is genuinely blocked, exactly as claimed.
- server/routes/drafts.js:268-270 confirmed 401 return for wrong-or-expired key with that exact message.
- Verdict: TRUE, real and precisely evidenced bug. P2 as claimed (compounds with #162's unreachability, but stands independently as a real code defect that would bite the moment #162 is ever worked around, e.g. via manual curl-minted key for testing).

## #165 DataHealth SourceTable Rules-of-Hooks — REFUTED for practical impact, downgrade to P3
- DataHealth.tsx:156-157 confirmed verbatim: `if (sources.length === 0) return null;` before `useMemo` at :157. This is a genuine Rules-of-Hooks violation as written.
- BUT: traced the actual data source. `/dev/sources` (server/routes/dev.js:68-71) calls `allSources()` (server/services/source-registry.js:279-284), which does `Object.entries(SCHEDULED_JOBS)` and `Object.entries(MANUAL_SOURCES)` — both are static, module-level `const` objects (scheduler.js:725 `export const JOBS = {...}`; source-registry.js:39 `export const MANUAL_SOURCES = {...}`), populated with many hard-coded keys, never conditionally built, never filtered by runtime state/feature flags.
- Consequence: `scheduled.length` and `manual.length` (DataHealth.tsx:279-280) are IDENTICAL on every single call to `/dev/sources` for the life of the running server process — they cannot go from 0 to non-zero (or vice versa) across a refetch, because the same fixed key lists are enumerated every time. Also neither list is ever empty to begin with (both have multiple entries), so the `sources.length === 0` branch is dead code entirely for both invocations (`scheduled` and `manual` at DataHealth.tsx:404-405).
- The claim's precise triggering scenario ("press Refresh, list gains an entry it lacked, count changes, hook-count mismatch, crash") cannot occur given this code — a server restart would be required to change the registries, and even then the component would fully remount (not the same fiber), avoiding the mismatch.
- Verdict: the underlying code smell is real (a linter would flag it, and it would bite if the registries were ever changed to be conditional) but the CLAIMED user-facing crash on "↻ Refresh everything" cannot happen with the current, effectively-static registries. Per the impact lens, this changes nothing a user sees today. Downgrade to P3 ("real latent defect, not observable"), refute the P2 crash-on-refresh framing.

## #166 /matchups routes to FantasyLab — CONFIRMED, not refuted
- App.tsx:130 confirmed verbatim; App.tsx:134 confirms `/lab` mounts the same `<FantasyLab/>`.
- navigation.ts:41 confirms `{to:'/matchups', label:'Matchups'}` under Intelligence group; navigation.ts:69 confirms the note "Opponent history and weekly projections" for `/matchups`.
- FantasyLab.tsx GROUPS (lines 20-34) confirmed: tabs are vor/movers/volatility/efficiency/schedule/sim (Edge Tools) and registry/accuracy/odds/correlation/gamescript/handcuffs (Prediction Engine) — no matchup content anywhere. FantasyLab.tsx:68 confirms `<h1>Research & Model Lab</h1>`.
- TradeLab.tsx:20 confirms a real `'matchups'` tab (label "Matchups"), :1081-1083 confirms `Matchups()` reads `/trades/dvp?position=`, i.e. real matchup content exists elsewhere and is not linked from the sidebar's "Matchups" entry.
- Verdict: TRUE exactly as claimed. P2 stands.

## #167 Model.tsx Availability tab unreachable — CONFIRMED, not refuted
- Model.tsx:19 confirmed `{ id: 'availability', label: 'Availability' }` in TABS; Model.tsx:82 (actually verified at the render block) renders `{tab === 'availability' && <Availability />}`.
- `grep -rn "from '.*pages/Model'"` / `import Model from './Model'` in client/src → only ONE hit: FantasyLab.tsx:3. FantasyLab.tsx:103 confirmed `<Model tab={tab as any} embedded />` — `embedded` is always `true` from this only call site.
- Model.tsx: `!embedded && (<div>...TABS...)` — the internal tab-strip UI (the only way to set `ownTab`) is hidden whenever `embedded` is true, and `tab = controlledTab ?? ownTab` uses FantasyLab's own `tab` state, which is constrained to FantasyLab's `engine` group tab ids (registry/accuracy/odds/correlation/gamescript/handcuffs) — 'availability' is never one of the ids FantasyLab's tab-switcher can set.
- Confirmed a separate, unrelated page `TheModel.tsx` is mounted at `/model` (App.tsx) — different component, does not reference Availability.
- server/routes/model.js:580 confirmed `/model/availability` endpoint exists and is live; contingency.js's `weeklyAvailability`/`availability` are imported at model.js:18.
- Verdict: TRUE exactly as claimed — Model.tsx's own `<h1>`, blurb, and the whole TABS-driven standalone view (including Availability) are 100% dead code; no URL or click reaches them. P2 as claimed (real lost-capability finding, per Nick's memory-recorded "fantasy over betting" priority).

## #168 DataTable numeric sort ignores minus sign — TRUE as a code bug, REFUTED for impact (downgrade to P3)
- DesignSystem.tsx:101 confirmed verbatim.
- Verified in node: `['-2.28','-10.5','3','-1.5','12','0'].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}))` → `['-1.5','-2.28','-10.5','0','3','12']`, exactly matching the claim's evidence; true numeric order would put -10.5 first. The bug is 100% real.
- BUT: `grep -rn "DataTable" client/src` → the ONLY occurrence in the entire client tree is the export/definition itself (DesignSystem.tsx:97). No page, component, or feature anywhere imports or renders `<DataTable>`. It is completely unused, dead exported code.
- Consequence: the claimed impact ("CLV, edge, point differential... silently mis-ranked... a user sorting worst-CLV-first gets -1.5 above -10.5") describes a scenario that cannot occur anywhere in the shipped app, because no screen uses this component. Nick can never see this mis-sort.
- Verdict: refute the P2 impact claim; this is real but unreachable dead code. Downgrade to P3.

## #169 useApi refetch closure identity / News 60s auto-refresh — PARTIALLY TRUE, overstated impact — REFUTE the "kills" framing, downgrade to P3
- api.ts:165 confirmed `return { data, loading, refreshing, error, refetch: () => refetch(true) };` — fresh arrow literal every call to `useApi` (i.e., every render of the calling component), independent of the inner `useCallback`-memoized `refetch` (api.ts:111-160, deps `[path, staleTime]`).
- News.tsx:52-59 (SignalFeed) confirmed: `useEffect(() => { if (!data?.signals?.some(...'game_day')) return; const timer = setInterval(() => refetch(), 60_000); return () => clearInterval(timer); }, [data?.signals, refetch]);` — `refetch` in the dep array is indeed the unstable wrapper.
- Traced whether this actually defeats the 60s cadence in the realistic "leave the tab open on Sunday" scenario: `data` itself is a brand-new object/array on every successful fetch (JSON response), so `data?.signals` ALREADY changes reference on every refetch regardless of the closure bug — the effect would tear down/rebuild every 60s anyway by design; that part is intended and harmless.
- The bug only bites on renders of `SignalFeed` that do NOT come from new data — i.e., unrelated re-renders. Traced SignalFeed's inputs: local `team` state (only changes via the same component's own select, which itself intentionally changes the fetch path/data — not "incidental"), a sibling `useApi('/teams')` call (resolves once, one extra re-render early on, not periodic), and nothing else. `News()`'s other state (aiText/date/teamFilter/pulling — used by the sibling 'log' tab, not 'signals') doesn't affect `SignalFeed` unless the user is on that tab. No app-wide ticking context (`PageExplainContext`) is consumed by News.tsx (confirmed via grep — zero hits for `usePageExplain` in News.tsx), so App-level `pageInfo` churn doesn't cascade into a re-render of the mounted News/SignalFeed tree while parked on this page.
- Conclusion: in the passive "watching the live feed during a game" scenario the claim is built around, SignalFeed does not experience the kind of extraneous re-render needed to actually break the 60s cadence — the interval largely does fire as intended, because the only things that re-render SignalFeed also change `data.signals` (which would rebuild the interval by design anyway) or happen once. The claim that "every render tears down and recreates the interval" is true as a mechanism, but "the live game-day model check never refreshes" is not an accurate characterization of steady-state behavior; it would only manifest if a user is actively toggling the team filter or some other state in a tight loop, not from passive viewing.
- Verdict: real code smell (should be `useCallback` in api.ts), but refute the specific "kills the auto-refresh" / "never refreshes" claim as overstated for the realistic use case. Downgrade to P3.

## #170 MyTeam.tsx Ceiling lineup hard-codes week=1 — CONFIRMED, not refuted
- MyTeam.tsx:346-347 confirmed verbatim: `/trades/${leagueId}/ceiling-lineup?team_id=${teamId}&week=1&trials=3000`.
- server/routes/trades.js:373-383 (`/:leagueId/ceiling-lineup`) confirmed: `week: Math.min(18, Math.max(1, Number(req.query.week) || 1))` — server has NO current-week derivation for this route; it trusts the query param and falls back to 1 if absent/invalid. So the client's explicit `week=1` really does pin every call to Week 1 forever.
- Contrast confirmed: Lineup.tsx:30-31 calls `/trades/${leagueId}/lineup?objective=${objective}` with no week param; server/routes/trades.js:320-327 (`/:leagueId/lineup`) confirmed — `lineupCall(lg.id, {...})` takes no week argument at all, meaning the underlying service derives the current week server-side. This proves the server CAN derive current week; the ceiling-lineup route/client combo simply never asked it to. Lineup.tsx:77 area confirmed to display "Week {d.week} projection" from the derived response.
- Confirmed CeilingLineup's render (MyTeam.tsx:357-420) never displays any week number anywhere in the UI (no "Week N" label, unlike Lineup.tsx).
- Verdict: TRUE exactly as claimed. P2 stands — a real, dated-data-integrity issue that will silently misinform Nick starting Week 2 with zero on-screen indication.

## #171 NflMarketBoard week defaults to 1 forever — CONFIRMED, not refuted
- NflMarketBoard.tsx:82 confirmed `const [week, setWeek] = useState(1);` with no initialization logic, no effect deriving current week from server/date anywhere in the file (grep for setWeek/current_week/currentWeek found only the `useState` declaration and the `<select onChange>` handler).
- Confirmed week drives `candidates` (:92-93 area), `bets` fetch, `runPolicy()`'s `POST /nfl-market/sync-and-pick?week=${week}` (:98-101), and `trackBet()`'s POST body `week` field (:118-121). Season hardcoded `2026` in the same calls.
- Verdict: TRUE exactly as claimed. This is a genuinely serious P2 (arguably candidate for P1 given it silently writes paper-ledger rows against the wrong week with a real forward-ledger integrity purpose) — not refuted, keep P2 as given (reasonable, could argue higher but not lower).

## #172 LiveDraft advice/board exact-name-match — CONFIRMED, not refuted, and additional corroborating evidence found
- LiveDraft.tsx:340-344 confirmed verbatim: `state.available.find((a: any) => a.name === advice.pick) ?? state.targets.find((t: any) => t.name === advice.pick) ?? null;` — pure strict `===` string equality, no normalization on the client at all.
- LiveDraft.tsx:498-503 confirmed the "off the board — see the list below or re-ask" badge shown when `!pickPlayer`, with a code comment directly above asserting this state means "Sniped between the advice and the clock... can no longer be drafted" — i.e. the code's own author intent confirms this UI state is read by users as "already taken."
- Went further into server/routes/drafts.js:1017-1157 (the advice-generation route) and found strong corroborating evidence the mismatch is a known, real, and specifically anticipated failure mode server-side: the prompt explicitly demands an ALLOWED PLAYERS closed list "spelled exactly as below" (comment at :1016-1020 explicitly says "an LLM under a 90-second-pick prompt will still occasionally invent or misspell a name"); the server maintains its own `normalise()`/`sameName()` comparison (:1071) used for its OWN verification/lookahead logic and for detecting `offBoard` violations (:1150-1157, logged via `console.warn('[draft-advice] off-list name(s)...')` and surfaced only as a `name_check_failed` field on the payload) — but critically, the server does NOT correct `out.pick` to the canonical matched name when this happens, and the client (`grep -n "name_check_failed|normalise|normalize" LiveDraft.tsx` → zero hits) never reads `name_check_failed` nor applies any fuzzy/normalized matching of its own.
- This means: exactly the failure mode the server's own comments describe as real and "occasional" (a hallucinated/misspelled name from the model) is guaranteed to manifest client-side as this exact false "off the board" state, with zero mitigation on the client.
- Verdict: TRUE, and more solidly evidenced than the original claim even stated — P2 stands, arguably deserves elevated confidence given the server's own documentation of the failure mode it was written to catch but never propagates to the client.

## #173 DraftHub Recaps tab renders Drafts (duplicate of Mock & boards) — CONFIRMED, not refuted
- DraftHub.tsx:9 confirmed `type View = 'mock' | 'survival' | 'live' | 'recap'`; :17 confirms all four tab buttons including `['recap','Recaps']`; :13 confirms `requested === 'live' || requested === 'recap'` is honored from `?view=`.
- DraftHub.tsx:19 confirmed verbatim: `{view === 'live' ? <LiveDraft /> : view === 'survival' ? <DraftSurvival /> : <Drafts />}` — no branch for `'recap'`, so both `'mock'` and `'recap'` fall through to the same `<Drafts />`.
- Verdict: TRUE exactly as claimed. P2 as claimed (misleading duplicate, not lost capability, matching the claim's own honest self-assessment that recap content is reachable another way via DraftRoom's recap modal).

---

## Summary table

| key | claim severity | verdict | corrected severity |
|---|---|---|---|
| #162 | P1 | CONFIRMED | P1 |
| #163 | P2 | CONFIRMED | P2 |
| #164 | P2 | CONFIRMED | P2 |
| #165 | P2 | REFUTED (impact) | P3 |
| #166 | P2 | CONFIRMED | P2 |
| #167 | P2 | CONFIRMED | P2 |
| #168 | P2 | REFUTED (impact — dead code) | P3 |
| #169 | P2 | REFUTED (overstated) | P3 |
| #170 | P2 | CONFIRMED | P2 |
| #171 | P2 | CONFIRMED | P2 |
| #172 | P2 | CONFIRMED (strengthened) | P2 |
| #173 | P2 | CONFIRMED | P2 |
