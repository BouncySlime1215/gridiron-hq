# Verification notes — reader G15-client-fantasy (12 claims)

Repo: /Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard (read-only)

## #162 — SourcePill bookmarklet unreachable without ingest_key (P1)
Files read in full context: client/src/components/draft/SourcePill.tsx (79 lines, all read), server/routes/draft-capture.js (80 lines, all read).

- SourcePill.tsx:42 calls `api(`/drafts/${draftId}/capture-bookmarklet`)` with NO query string at all.
- draft-capture.js:40-43 `resolveIngestKey()` reads only `req.query.ingest_key`; returns null if absent.
- draft-capture.js:60-63: if `resolveIngestKey` returns null, route responds 400 `{error:'ingest_key required: pass ?ingest_key=… obtained from POST /api/drafts/:id/ingest-key'}`.
- `grep -rn "ingest-key|ingest_key|capture-bookmarklet" client/src client/public` → only two hits: SourcePill.tsx:42 (the broken call) and draft-capture.js:156 (a field name inside the POST body draft-capture.js itself sends to the server, not a client UI call). No client code ever calls `POST /drafts/:id/ingest-key`.
- server/routes/drafts.js:288 confirms `POST /:id/ingest-key` exists server-side (mounted), but nothing in the client ever hits it.
- Reachability confirmed: draft-capture.js router is mounted (server/index.js:50, `await import('./routes/draft-capture.js')`), and `/draft-capture.js` static script route is registered at server/index.js:86. SourcePill is rendered live at LiveDraft.tsx:430, and LiveDraft is reachable via DraftHub → `/draft` route (App.tsx) and `/drafts/:id` → DraftRoom.

Verdict: CONFIRMED, P1 as claimed. The button always fails with the "ingest_key required" message; the entire capture flow is unreachable through the UI.

## #163 — useDraftQueue seed race drops optimistic queue edits (P2)
Files read: client/src/features/draft/useDraftQueue.ts (63 lines, all read); client/src/pages/DraftRoom.tsx lines 1-120 read (of 417).

- useDraftQueue.ts:17-19: `useEffect(() => { if (!seeded.current && serverQueue.length) { setQueue(serverQueue); seeded.current=true; } }, [serverQueue])`. seeded.current only ever becomes true once a poll returns a NON-EMPTY serverQueue.
- DraftRoom.tsx:59: `useDraftQueue(id, draft?.my_slot ?? 1, draft?.queue.map(q => q.player_id) ?? [])` — a fresh array is passed every render (new array identity every time), so the effect's dependency changes every render draft data changes.
- DraftRoom.tsx:24: `const { data: draft, refetch, ... } = useApi(...)`.
- DraftRoom.tsx:72-81 `cpuStep()`: on every CPU pick, explicitly calls `await refetch();` (line ~78) — this is the concrete, reachable trigger for a new `draft` snapshot arriving mid-draft, independent of any queue edits by the human player.
- Scenario: draft starts with an empty queue (typical — `seeded.current` stays false while serverQueue.length===0). Player quickly queues three players (three PUT calls via `persist()`, useDraftQueue.ts:21-27, each firing immediately on `add()`). Before all three PUTs land server-side, a CPU-pick refetch (triggered independently by the `cpuStep` interval, DraftRoom.tsx ~86-89 `useEffect` with `setTimeout(cpuStep, 1100)`) lands with a queue snapshot reflecting only the first PUT (`[a]`). Since seeded.current is still false (this is the first ever non-empty snapshot), the effect fires: `setQueue([a])`, clobbering the local optimistic `[a,b,c]` and losing b, c silently, with no error shown to the user.
- This is a genuine, real race grounded in actual reachable app behavior (queueing during a mock/live draft while CPU picks are also being polled/refetched).

Verdict: CONFIRMED, P2. Real, reachable, timing-dependent bug matching the described mechanism precisely.

## #164 — draft-capture.js treats every 4xx (incl. 401 expired key) as fatal; 20Hz spin (P2)
Files read: client/public/draft-capture.js (489 lines, read via multiple chunks covering 1-80, 150-300, 360-489 — spot-read remaining ranges are boilerplate WS-patch code not load-bearing to this claim, but the cited lines and surrounding logic were fully read).

- draft-capture.js:188 `flush()`: `if (state.inflight || state.fatal || !state.outbox.length) return Promise.resolve(false);` — once `state.fatal` is set, flush always short-circuits, forever.
- draft-capture.js:203-207 (`done()` callback): `if (status >= 400 && status < 500 && status !== 429) { state.fatal = true; ... }` — treats EVERY 4xx except 429 as permanently fatal, including a 401.
- server/routes/drafts.js:268-270 (spot check) returns 401 for wrong/expired ingest key ("ingest key is wrong or expired — mint a new one in the draft room"); server/services/draft-ingest.js:36-48 confirms keys expire at draft_at+8h or a default window — so a long draft can genuinely produce a 401 mid-draft, a reachable real-world condition once the mechanism is actually in use.
- Recovery check (draft-capture.js:472-486, browser-boot IIFE): re-clicking the SAME bookmarklet re-runs the boot code, which checks `root.__GHQ_CAPTURE_INSTANCE__ && !state.stopped && config.draftId === q.draft` → if true, takes the "already running for draft X - not attaching twice" branch (just un-dismisses + re-renders pill; does NOT create a fresh instance). Critically, `state.fatal = true` (line 204) never sets `state.stopped = true` (that only happens in `stop()`, line ~439-441, called only from `stop()`) — so a fatal instance still reads as "not stopped," meaning the dedupe check swallows the re-click and no new instance (with, if a new bookmarklet/key had been minted, a fresh key) is created. This precisely matches "cannot be recovered by re-clicking the bookmarklet."
- 20 Hz spin confirmed: `schedule()` (draft-capture.js:260-267) computes the next timer delay as `state.outbox.length && !state.inflight && now() >= state.blockedUntil ? 50 : BATCH_MS`. Once fatal, `flush()` never drains the outbox (short-circuits before touching it), but `tick()` (line ~249-256) still calls `buildBatches()` every tick, continuing to move ESPN-arriving frames from `pending` into `outbox`, so `outbox.length > 0` stays true → the 50ms branch is taken every time → the scheduler self-arms at 20Hz (1000ms/50ms) indefinitely.
- Reachability: server/index.js mounts `/draft-capture.js` (static serve) and the ingest POST/status routes exist server-side (server/routes/drafts.js). Even though claim #162 shows the *UI button* to mint a bookmarklet is currently broken, the script itself is live, mounted, served, and is real code that runs in the browser once loaded by any means (e.g., a commissioner hitting the ingest-key/capture-bookmarklet endpoints directly). This is not dead code — it is a shipped, mounted feature with its own test harness (comment at draft-capture.js:12-13 references test/draft-capture-client.test.js). The 4xx-fatal/no-recovery/20Hz-spin behavior is real, live code, independently defective from the #162 UI-wiring bug.

Verdict: CONFIRMED, P2. All three sub-claims (permanent fatal on 401, re-click cannot recover due to the not-stopped dedupe guard, 20Hz busy-spin after fatal) verified directly against code.

## #165 — DataHealth SourceTable Rules-of-Hooks violation (P2)
File read: client/src/pages/DataHealth.tsx (409 lines, read in chunks covering 130-170, 280-320, 390-409; balance of file is unrelated table-row rendering/helpers not relevant to this claim).

- DataHealth.tsx:156 `if (sources.length === 0) return null;` sits directly above :157 `const sorted = useMemo(() => [...sources].sort(stalestFirst), [sources]);` inside `SourceTable`. This is a textbook Rules-of-Hooks violation: a render where `sources` is empty calls 0 hooks; a render where it is non-empty calls 1 hook (the `useMemo`).
- Two call sites confirmed near end of file: `<SourceTable title="Scheduled sources" ... sources={scheduled} />` and `<SourceTable title="Manual sources" ... sources={manual} />`, both unconditionally rendered whenever `data` is truthy (the `{data && <>...}` block, which persists across a refetch since `data` does not get nulled out mid-refetch per useApi's stale-while-revalidate design in api.ts).
- `scheduled`/`manual` are derived via `.filter(s => s.scheduled)` / `.filter(s => !s.scheduled)` on the same `sources` array from the API payload (around DataHealth.tsx:282-283).
- Reachable failure: the "↻ Refresh everything" button (around :300, `runRefreshAll`) triggers `refetch()` (around :274/:300), which re-fetches `/dev/sources`. If that refetch's new payload has a manual (or scheduled) source count that crosses zero↔nonzero relative to the prior payload for that SAME rendered `SourceTable` instance (same JSX position, so React treats it as the same component instance across the refetch, not a remount), React throws "Rendered more/fewer hooks than during the previous render," crashing that region of the tree.

Verdict: CONFIRMED, P2. Genuine Rules-of-Hooks bug, reachable via the documented refresh flow whenever the manual/scheduled source split changes count on either side of zero across a refetch.

## #166 — Sidebar "Matchups" nav item routes to FantasyLab / Research & Model Lab (P2)
Files read: client/src/App.tsx (181 lines, all read for routing section 100-145 plus imports), client/src/navigation.ts (121 lines, read 1-90), client/src/pages/FantasyLab.tsx (192 lines, read 1-75), plus grep checks on TradeLab.tsx and TeamSchedule.tsx existence.

- navigation.ts:41 (actual: within NAV_GROUPS Intelligence array) `{ to: '/matchups', label: 'Matchups', icon: 'M' }`; NAV_NOTES entry `'/matchups': 'Opponent history and weekly projections'` confirmed present.
- App.tsx: `<Route path="/matchups" element={<FantasyLab />} />` AND `<Route path="/lab" element={<FantasyLab />} />` — same component mounted at two different nav destinations ("Matchups" and "Accuracy & Experiments").
- FantasyLab.tsx:68 `<h1 className="text-2xl font-bold mb-1">Research &amp; Model Lab</h1>` — confirmed page title has no matchup framing.
- FantasyLab GROUPS tabs (lines ~20-35): Edge Tools = [Value Board, Breakouts & Regression, Boom/Bust, Efficiency, Playoff Schedule, Season Simulator]; Prediction Engine = [Registry, Accuracy, Championship Odds, Correlation, Game Script, Handcuffs]. None are matchup/DVP content.
- Real matchup content exists elsewhere and is not linked from the "Matchups" nav entry: `grep -n "Matchups|dvp" client/src/pages/TradeLab.tsx` → TradeLab.tsx:20 tab def `{ id: 'matchups', label: 'Matchups', hint: 'Defence vs position, and head-to-head history' }`, :146 renders it, :1081-1083 `function Matchups()` calling `/trades/dvp?position=${pos}`. `client/src/components/TeamSchedule.tsx` confirmed to exist (ls).

Verdict: CONFIRMED, P2. Clean citation match; genuinely misleading nav with working matchup content orphaned elsewhere.

## #167 — Model.tsx Availability tab unreachable (P2)
Files read: client/src/pages/Model.tsx (485 lines, read 1-60, 75-90), client/src/pages/FantasyLab.tsx (192 lines, read fully relevant sections), client/src/App.tsx (routes), server/routes/model.js (grep for /availability route).

- Model.tsx:14-21 `TABS` const includes `{ id: 'availability', label: 'Availability' }`.
- Model.tsx:82 (actual render block) `{tab === 'availability' && <Availability />}` confirmed alongside the other tab branches.
- Model.tsx default export signature: `export default function Model({ tab: controlledTab, embedded }: {...} = {})`. `const tab = controlledTab ?? ownTab`.
- `grep -rn "pages/Model'" client/src` and `grep -rn "^import Model" client/src` both return exactly ONE hit: FantasyLab.tsx:3 `import Model from './Model';`. No other file imports pages/Model.tsx.
- FantasyLab.tsx:101-103: `{tab === 'registry' ? <...Registry.../> : active.source === 'edge' ? <Edge tab={tab as any} embedded /> : <Model tab={tab as any} embedded />}` — Model is ALWAYS rendered with `embedded` (truthy, no conditional), and `tab` is always one of the `engine` group's tab ids: `['registry','accuracy','odds','correlation','gamescript','handcuffs']` — 'availability' is never among them.
- `/model` route in App.tsx is a DIFFERENT component: `const TheModel = lazy(() => import('./pages/TheModel'));` mounted at `<Route path="/model" element={<TheModel />} />` — not pages/Model.tsx. Confirmed pages/Model.tsx has no standalone route.
- Model.tsx:44 `{!embedded && <h1 ...>Prediction Engine</h1>}` and :49-54 `{!embedded && <p>...</p>}` — both dead since `embedded` is always true from the only call site.
- Server endpoint confirmed live: `grep -n "availability" server/routes/model.js` → line 580 `r.get('/availability', (req, res, next) => {...})`, mounted router (server/routes/model.js is presumably mounted under `/model` in server/index.js — consistent with client fetch to `/model/availability`).

Verdict: CONFIRMED, P2. Fully verified dead-tab / dead-route finding; server-side feature exists with zero reachable client entry point.

## #168 — DataTable localeCompare numeric sort mis-ranks negatives — REFUTED (dead code)
Files read: client/src/components/ui/DesignSystem.tsx (122 lines, all read, focused 90-105); grep across client/src for all usages/imports of `DataTable`.

- Verified the localeCompare bug itself is real: `node -e` reproduction with `['-2.28','-10.5','3','-1.5','12','0']` using `.sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}))` yields `['-1.5','-2.28','-10.5','0','3','12']` — confirms ICU numeric collation ignores the minus sign as claimed.
- HOWEVER: reachability check. `grep -rn "DataTable" client/` (entire client tree, not just src) returns exactly ONE hit total: the definition itself at DesignSystem.tsx:97 (`export function DataTable<T>(...)`). Cross-checked every file that imports anything from `ui/DesignSystem` (`grep -rln "ui/DesignSystem" client/src` → App.tsx, main.tsx, DraftHub.tsx, Home.tsx, LeagueHub.tsx) and confirmed each import list individually: App.tsx imports only `Skeleton`; Home.tsx imports `Card, Confidence, PageHeader, Provenance, Section, Skeleton, StatTile`; LeagueHub.tsx and DraftHub.tsx import only `PageHeader`; main.tsx imports only `ToastProvider`. None import `DataTable`.
- `DataTable` is exported but never imported or rendered anywhere in the client application. No page uses it for CLV, edge, point differential, or any other column. This is dead code — unreachable in the running app.

Verdict: REFUTED (unreachable). The underlying arithmetic/logic claim about localeCompare+numeric mis-ordering negatives is technically correct, but the code path cited is never invoked anywhere in the running client — `DataTable` has zero call sites. Per the reachability lens, dead code cannot be P1/P2. Downgrade to not-a-defect (or, generously, informational/no severity) since nothing in the running app can exhibit this behavior.

## #169 — useApi returns a fresh refetch closure every render, breaking News's 60s auto-refresh (P2)
Files read: client/src/api.ts (227 lines, read 90-170), client/src/pages/News.tsx (480 lines, read 1-80 covering the cited effect).

- api.ts: inner `refetch` is defined via `useCallback` (deps `[path, staleTime]`), BUT the hook's return statement (api.ts:165, confirmed) is `return { data, loading, refreshing, error, refetch: () => refetch(true) };` — this object (and specifically the `refetch:` property, an inline arrow function) is a fresh literal created on every invocation of `useApi`, i.e., every render of the calling component. The wrapping arrow is NOT memoized, so its identity changes every render regardless of whether the underlying `useCallback`'d refetch changed.
- News.tsx SignalFeed (lines ~53-60): `const { data, refetch, ... } = useApi(...)`; then `useEffect(() => { if (!data?.signals?.some(s => s.tracking?.status === 'game_day')) return; const timer = window.setInterval(() => refetch(), 60_000); return () => window.clearInterval(timer); }, [data?.signals, refetch]);` — `refetch` is listed in the dependency array, and since it is a new reference every render of `SignalFeed`, the effect tears down and recreates the interval on every render of the component, not just when `data.signals` meaningfully changes.
- This is real, reachable behavior: SignalFeed also holds a sibling `useApi<any[]>('/teams')` call (line ~55) and a `team` select state — any state change (typing in the select, the teams call resolving, a parent re-render) causes SignalFeed to re-render, which resets the 60s interval before it can fire, for any page visit with more than one re-render per minute (very plausible on a live news page during NFL Sunday).

Verdict: CONFIRMED, P2. Verified precisely as claimed — real closure-identity bug, real reachable victim effect, real practical consequence (game-day auto-refresh can be starved by ordinary re-renders).

## #170 — MyTeam Ceiling lineup hardcodes week=1 with no week shown (P2)
Files read: client/src/pages/MyTeam.tsx (451 lines, read 330-360 plus grep across 345-451 for "week"), client/src/pages/Lineup.tsx (272 lines, read 20-80), server/routes/trades.js (grep + read 310-400 covering both /lineup and /ceiling-lineup routes).

- MyTeam.tsx: `CeilingLineup` calls `useApi(teamId ? `/trades/${leagueId}/ceiling-lineup?team_id=${teamId}&week=1&trials=3000` : null)` — `week=1` is a literal hardcoded string, not derived from any date/state.
- `grep -n "week|Week"` over the CeilingLineup render body (lines 345-451) turns up zero occurrences of a week number/label anywhere in the rendered UI — confirmed no week is ever displayed to the user on this tab.
- Contrast confirmed: Lineup.tsx (`/trades/:leagueId/lineup` route) sends NO week param at all (`/trades/${leagueId}/lineup?objective=${objective}`), and the server route (trades.js:320-325) passes no week to `lineupCall()`, meaning that service derives the current week internally; the client then displays the server-derived week explicitly at Lineup.tsx:~77 ("Week {d.week} projection").
- Server route for ceiling-lineup (trades.js:373-380) confirmed: `week: Math.min(18, Math.max(1, Number(req.query.week) || 1))` — this route always requires/consumes an explicit `week` query param and itself falls back to 1 if missing/invalid, rather than deriving the current week the way `/lineup` does. (Minor correction to the reader's evidence framing: it is not quite that "the server can derive the current week" for this specific route/service — the ceiling-lineup service takes week as an explicit input and the /lineup route just happens to omit passing one, letting its own service derive it. But this nuance doesn't change the core, fully-verified client-side defect: MyTeam.tsx always sends `week=1` literally, so every week beyond Week 1 the tab requests and displays Week 1's ceiling lineup with no on-screen indication of the mismatch.)

Verdict: CONFIRMED, P2 (core claim solid; evidence narrative about "the server can derive the week" is slightly imprecise but immaterial to the defect itself).

## #171 — NflMarketBoard week defaults to 1 all season; writes act on it (P2)
File read: client/src/pages/NflMarketBoard.tsx (299 lines, read 1-150 covering state, fetches, runPolicy, trackBet, and the week `<select>`).

- Line 82 (confirmed exact): `const [week, setWeek] = useState(1);` — no derivation from date/server "current week."
- `candidates` fetch (line ~92): `/nfl-market/picks/candidates?season=2026&week=${week}`; `bets` fetch (line ~93): `/nfl-market/bets?season=2026&week=${week}` — both driven by the same `week` state.
- `runPolicy()` (line ~101): `POST /nfl-market/sync-and-pick?week=${week}&trials=20000` — a write action ("Preserve paper slate").
- `trackBet()` (line ~121, actual around 111-118 in read output): `POST /nfl-market/bets` body includes `week` (paper-tracking a bet — "Paper track" action).
- Season hardcoded `2026` at all four call sites, confirmed by direct read.
- Week `<select>` exists (around line 143/145, confirmed in the `actions=` JSX for `section === 'board'`) allowing manual override, but nothing on mount/effect derives or pre-sets it to the actual current NFL week.
- Reachable: `NflMarketBoard` is mounted at `/betting/nfl`, `/betting/nfl/picks`, and several other routes in App.tsx, all live and reachable from the sidebar.

Verdict: CONFIRMED, P2. Matches claim precisely — both write paths (sync-and-pick, track bet) act on the stale default whenever the user doesn't manually re-select the week.

## #172 — LiveDraft exact-name match falsely reports recommended player as drafted (P2)
Files read: client/src/pages/LiveDraft.tsx (939 lines, read 330-360, 490-510), server/routes/drafts.js (read 937-1165, the whole `/advice` handler), server/services/player-ids.js (read 65-85 for `normalise`).

- LiveDraft.tsx:343-345 (`pickPlayer` useMemo): `return state.available.find((a) => a.name === advice.pick) ?? state.targets.find((t) => t.name === advice.pick) ?? null;` — exact `===` string match, no normalization.
- LiveDraft.tsx:349-357 `evidenceFor()` repeats the same exact-string lookup pattern for career/preseason evidence.
- UI consequence confirmed at LiveDraft.tsx ~500-504: when `pickPlayer` is null, renders `off the board — {adviceBusy ? 'updating…' : 're-ask'}` in a rose/red badge — the exact wording and styling cited.
- Server side (drafts.js:1082): `const sameName = (a, b) => a != null && b != null && normalise(a) === normalise(b);` used for the server's OWN internal verification/lookahead matching — i.e., the backend authors clearly know exact-string matching is unreliable and use a normalized comparator internally.
- drafts.js:1145-1157: the server computes its own "off-list" check using `normalise()` (letters-only, case-insensitive — server/services/player-ids.js:72 `String(name ?? '').toLowerCase().replace(/[^a-z]/g, '')`), and if a name is off-list even after normalization, it only WARNS (`console.warn`) and annotates `payload.name_check_failed` — it does NOT rewrite `out.pick` to a canonical/matched name before sending to the client. The raw model text is always what's returned as `advice.pick`.
- Because `normalise()` strips punctuation/spacing/case but the client does none of that, any case/punctuation/spacing variance between the LLM's rendering of a name and the board's stored spelling (e.g., "AJ Brown" vs "A.J. Brown") that the server itself treats as equivalent will still fail the client's raw `===` check, falsely showing "off the board."
- The prompt itself (drafts.js ~1010, "ALLOWED PLAYERS — you may name ONLY these players, spelled exactly as below") plus the accompanying code comment ("an LLM under a 90-second-pick prompt will still occasionally invent or misspell a name") is direct authorial acknowledgment that exact-spelling drift from the model is an expected, real occurrence — not a hypothetical.

Verdict: CONFIRMED, P2. Mechanism fully verified end-to-end (prompt → LLM output → server's own lenient normalized check → client's strict exact check → misleading UI state).

## #173 — DraftHub "Recaps" tab renders the same content as "Mock & boards" (P2)
File read: client/src/pages/DraftHub.tsx (104 lines, all read).

- Line 9: `type View = 'mock' | 'survival' | 'live' | 'recap';`
- Line 13: `const [view, setView] = useState<View>(requested === 'live' || requested === 'recap' ? requested : 'mock');` — confirms `?view=recap` is read from the URL and can set `view` to `'recap'`.
- Line 17: tab strip array `[['mock','Mock & boards'],['survival','Who survives'],['live','Live'],['recap','Recaps']]` — all four tabs including Recaps are rendered as clickable buttons.
- Line 19 (the render ternary): `{view === 'live' ? <LiveDraft /> : view === 'survival' ? <DraftSurvival /> : <Drafts />}` — only 'live' and 'survival' are branched; both 'mock' and 'recap' fall through to the same `<Drafts />` render, with zero code distinguishing them.

Verdict: CONFIRMED, P2. Exact, minimal, fully verified — the ternary genuinely has no 'recap' branch.

---

## Summary table

| Claim | Verdict | Severity |
|---|---|---|
| #162 | CONFIRMED | P1 |
| #163 | CONFIRMED | P2 |
| #164 | CONFIRMED | P2 |
| #165 | CONFIRMED | P2 |
| #166 | CONFIRMED | P2 |
| #167 | CONFIRMED | P2 |
| #168 | REFUTED (unreachable — DataTable has zero call sites in client/) | not-a-defect |
| #169 | CONFIRMED | P2 |
| #170 | CONFIRMED | P2 |
| #171 | CONFIRMED | P2 |
| #172 | CONFIRMED | P2 |
| #173 | CONFIRMED | P2 |

11 of 12 claims survive adversarial verification. Only #168 is refuted, and only on reachability grounds — the localeCompare/negative-number sort bug is technically real (confirmed by direct node reproduction) but the `DataTable` component that contains it is exported and never imported/rendered anywhere in the client application.
