# route-no-caller: rank it, then stop it lying

RED `f3f56d5` · GREEN — this commit · `test/wiring-map.test.js` cases 34-42

## The five questions

- **Is it well built?** The gate is one-directional by construction: it can only
  suppress a finding, never invent one. The ranking is deliberately crude and
  deliberately explainable — imported names called, tables named, cost of the
  modules behind those names.
- **Is it based on stats, or made up?** Measured on this repository, not argued:
  462 rows before, 405 after, 57 dropped, each one checked below.
- **How do we know?** Every rule here has an injection that was run and shown to
  fail. A test that no mutation can fail proves nothing.
- **Should this point anywhere else on the platform?** Yes — `route-no-caller`
  is the rule the feature-audit thread was working around by hand. Its stated
  method ("a route is a finding only when its own distinctive literal is absent
  from the entire client tree") is now the rule itself.
- **How does it unify?** One definition of "called" for the map and for the
  audit, instead of the map's parsed-call inventory and a person's grep.

## The problem

`route-no-caller` reported **462 routes** and reported them identically. Two of
them were genuinely dead and carried real work behind them:

- `GET /api/decision-inbox` — two engines write to the table it reads.
- `GET /api/trades/:leagueId/trends` — a 324-line join.

Both were named by the map, and both were found by hand instead. A rule that
produces 462 undifferentiated rows is, in practice, a rule that reports nothing.
That is the map's problem, not the reader's.

Worse, some of the 462 were wrong. `clientCalls()` reads inline string literals
only, and this client builds paths in variables:

```
post-draft-plan    client hits: 1
rosters            client hits: 50
inbox              client hits: 0
decision-inbox     client hits: 0
/trends            client hits: 0
```

## The gate

`routeLiteralAbsent(routePath, clientText)` — a route is a finding only when its
distinctive literal appears nowhere in the client text. The distinctive literal
is the **longest run of consecutive non-parameter segments**, ties going to the
longer fragment. Anchored to a separator on the left and a segment end on the
right, so `/trends` never matches `/trending`.

Two weaker versions were built and measured before this one, and both were wrong
in ways only the numbers showed:

1. **Last literal segment.** Dropped 139 rows — too many. `GET /api/betting/status`
   judged on `status` alone is suppressed by any unrelated `/status` in the
   client. Five endpoints under `/api/betting` and `/api/edge` vanished that way.
2. **Longest run, later wins a tie.** Dropped 57, correct count, wrong on
   `POST /api/decision-inbox/:id/resolve`: two one-segment runs, judged on
   `resolve`, suppressed — while its own sibling `GET /api/decision-inbox/summary`
   stayed a finding. Two answers about one endpoint is the tell.

## Injections (run, and shown to fail)

| Injection | Result |
|---|---|
| `frag = esc(best[best.length - 1])` (last segment only) | `not ok 40` |
| `if (r.length === best.length) best = r` (later wins, ignore length) | `not ok 40` |
| handler body scanned to the next route instead of brace-matched | `not ok 36` |
| `callee_cost` dropped from `weight` | `not ok 35` |

Each was applied to the working file, `node --test test/wiring-map.test.js` run,
the failure recorded, and the file restored. 53/53 green before and after.

## Measured effect

```
route-no-caller  before 462  after 405  dropped 57
total findings   before 2203  after 2148
```

The three endpoints that must survive, do:

```
FINDING    GET /api/decision-inbox
FINDING    POST /api/decision-inbox/:id/resolve
FINDING    GET /api/trades/:leagueId/trends
suppressed GET /api/trades/:leagueId/post-draft-plan
suppressed GET /api/trades/:leagueId/rosters
suppressed GET /api/betting/status
```

All 57 dropped rows were listed and read. They are ordinary live endpoints —
`/api/teams`, `/api/players/:id/gamelog`, `/api/model/status`,
`/api/trades/:leagueId/rosters` — reached by paths the client assembles rather
than writes inline.

## The ranking did not do what the ranking was for

`routeWorkload` was built so the expensive orphans float to the top. Measured
against the two endpoints that motivated the whole exercise, it does not:

```
rank 225 of 405  weight 22   GET /api/decision-inbox
rank 102 of 405  weight 43   POST /api/decision-inbox/:id/resolve
rank 205 of 405  weight 24   GET /api/trades/:leagueId/trends
```

The top of the list is `/api/mlb/auto-picks` (w315) and four `/api/nfl-betting`
sync routes. They are heavy, they are real, and they are betting — out of scope
for work. Weight ranks honestly and ranks the wrong axis.

**Scope is the lever.** 405 rows split 27 fantasy / 54 shared / **324 betting**:
80% of this rule is scope Nick has ruled out. The in-scope remainder is 81 rows,
and `GET /api/trades/:leagueId/trends` is 17th of the 27 fantasy ones — a list
anyone reads top to bottom.

## The rendering was the actual bug

None of this reached a reader, because `toMarkdown` prints bulk rules as a
file-count table and names nothing:

```
| server/routes/decision-inbox.js | 4 |
| server/routes/trades.js        | 18 |
```

Both dead endpoints are inside those two numbers. Counted, never named, found by
hand. `bulkInScope()` now names every non-betting row in full, heaviest first,
and leaves betting to the count. All three appear by name:

```
WIRING-MAP.md:1679  POST /api/decision-inbox/:id/resolve  [shared]  w43
WIRING-MAP.md:1717  GET /api/trades/:leagueId/trends      [fantasy] w24
WIRING-MAP.md:1725  GET /api/decision-inbox               [shared]  w22
```

## The control, supplied by the feature-audit thread

They challenged the number before it could be ranked, and were right to: 405
uncalled of **548 handlers in 31 files** is 74% of the app. They named four
routes with handler and client call site that are certainly called, every one
reached through a template literal with an interpolation — the shape a literal
matcher misses, since there is no contiguous `/trades/:leagueId/evaluate`
anywhere in the client.

```
absent (correct)  POST /api/trades/:leagueId/evaluate      TradeLab.tsx:1022
absent (correct)  POST /api/trades/:leagueId/sense-check   TradeCard.tsx:167
absent (correct)  GET  /api/drafts/:id/assist              LiveDraft.tsx:174
absent (correct)  POST /api/players/:id/analyze            PlayerCard.tsx:96
```

All four pass, and they are now a permanent test case (case 41) with the real
call sites copied verbatim. The injection that matters: requiring the whole
route path contiguously — the naive matcher they described — fails that case
and three others.

## Where the 74% actually comes from

Split by scope, the alarming number resolves into one true fact and two ordinary
ones:

```
betting   324 / 335 = 97%
shared     54 /  91 = 59%
fantasy    27 /  79 = 34%
(43 routes in files with no findings at all: 0% flagged)
```

**There is no betting UI.** Five client files mention betting anywhere
(`App.tsx`, `api.ts`, `navigation.ts`, `NotFound.tsx`, `PageExplainAssistant.tsx`)
and not one of them is a page. So 335 betting handlers with 324 uncalled is not
a matcher failure — it is a 335-route API with no front end, which is a real
fact about this repository and out of scope for work.

The number to carry is not 405 and not 74%. It is **81 in-scope routes, 27 of
them fantasy.**

## Known limitation, not fixed here

The top in-scope row is `GET /api/auth/google/callback` (w111). Nothing in the
client calls it and nothing should — Google does. Routes with an external caller
are a category this rule cannot see, and there are others like it in the 81.
Flagged for the Google sign-in thread rather than silently annotated away.

## Verification

```
npm run check      exit 0 (typecheck, lint, client build, start:smoke — 32 teams)
npm test           3004 tests, 2963 pass, 0 fail, 41 skipped
node --test test/wiring-map.test.js   55/55
```
