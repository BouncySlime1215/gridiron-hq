# The league outlook panel — RED/GREEN evidence

`client/src/lib/outlook.js`, `client/src/lib/percent.js`,
`client/src/components/league/OutlookPanel.tsx`, the `outlook_probability`
glossary entry, and `test/league-outlook-panel.test.js`.

Retroactive RED by mutation. Built behind the payload's presence: the route
does not exist on every deployment yet, and the panel renders nothing until it
answers.

## Two different playoff numbers, deliberately kept apart

`GET /api/leagues/:id/outlook` is **not** the simulation that produces the
championship number higher up the same page. That one plays the rest of the
season out thousands of times. This one is a model fitted on finished seasons
reading the season so far. Two methods, two answers.

They have two glossary entries — `outlook_probability` ("Chance to qualify")
and `playoff_odds` ("Playoff chance") — for exactly the reason the glossary
exists: `floor` already means two things on one screen in this codebase, and
one name over two methods is how that happened. The mutation that folds one
entry's `raw` into the other goes red.

## The clamp is on the string, and it lives in one place

The payload guarantees `probability` is never 0 and never 1. That is not
enough. At one decimal place 0.9999 renders `100.0%` and 0.00004 renders
`0.0%`: the value obeys the promise and the screen still tells a manager his
season is decided in week 3.

So the clamp is applied to the **rendered string**, by rounding first and then
asking whether the result is one of the two claims that may not be made. A
hand-chosen epsilon instead would clamp a number that renders fine and miss one
that does not — the first draft of this used one and did both.

It lives in `client/src/lib/percent.js`, used by `formatValue` through the
glossary entry's `neverCertain` flag **and** by the panel. Two
implementations would drift and only one of them would be the one on screen.
Nothing else in the app silently gains a hedge: without the flag `percentText`
is an ordinary percentage, and the mutation that removes that guard goes red.

## `act` is never synthesised

The server sends `fine`, `watch` and `act_candidate` and never `act`. Act means
a specific move exists that raises these odds, and only a caller holding the
trade engine's best move can know that. A panel that upgraded the label itself
would be telling a manager to do something without having found anything for
him to do.

`verdictOf('act')` returns null, and the panel says the limit out loud rather
than leaving an absent button: *"Worth a look" marks where a move would matter
most. Whether a move is actually available is a different question, and this
panel does not answer it — Trade Lab does.* Both mutations go red.

## The decomposition

Shown in the server's stated `order`, because the three parts are not equally
important in every league and the server knows which dominates — a fixed order
would put the biggest one last in half of them.

`real` is a **remainder**: what is left after luck and noise, not a separately
measured quantity. `real_is` carries the server's sentence saying so, it is
attached to `real` alone, and the mutation that attaches it to every part goes
red — a caveat on everything is a caveat on nothing.

`no_results_yet` is the same model with the result features neutral. It is
rendered as *"With everything that has happened this season set aside…"* and
never as a preseason forecast, which would invent a comparison the server did
not run.

With no weeks played the three parts are a split of nothing, so they are not
shown at all. A chart of zero is a claim.

A part the server did not send is a dash, never a zero.

## Not ready is a sentence, printed as it arrives

Five distinct reasons, two of which are deliberate refusals rather than missing
data. The sentence is the only thing that distinguishes them and the server
wrote them finished, so the panel prints `outlook.reason` and has no wording of
its own. The mutation that substitutes "Not ready yet." goes red.

The route's own absence is different again and is silent: "this build has no
outlook route" is not something a manager can act on, and an error card there
would be the page reporting its own roadmap.

## An assertion that watched a symbol, for the third time in this stack

"the glossary entry lost its flag" matched `/neverCertain: true/` against the
whole file. Removing the flag from the entry left `formatValue`'s own call site
— `percentText(value, t.precision, { neverCertain: true })` — further down, so
the mutation came back **green**. It now slices to the entry.

This is the third instance: a slice on a common token, an identifier checked
instead of a guard, and now a literal matched anywhere in a file. Same lesson
each time — assert the decision, not the symbol — and the mutation run is what
tells them apart.

## Mutation runs

Baseline: 8 tests, 8 pass, 0 fail. All sixteen red.

| Mutation | Result | Caught by |
|---|---|---|
| the clamp is dropped, so 0.9999 reads 100% | 6/**2** | never reads as certain; clamp in one place |
| the clamp is applied to every percentage in the app | 7/**1** | clamp in one place |
| the outlook glossary entry loses its flag | 7/**1** | clamp in one place |
| `formatValue` stops applying the clamp | 7/**1** | clamp in one place |
| the outlook number is folded into the simulation's entry | 7/**1** | clamp in one place |
| the panel invents an `act` verdict | 7/**1** | act is never produced |
| the panel stops saying it cannot tell you what to do | 7/**1** | act is never produced |
| the decomposition order is hard-coded | 7/**1** | shown in the server's order |
| the remainder caveat is dropped | 7/**1** | shown in the server's order |
| the caveat is attached to every part | 7/**1** | shown in the server's order |
| a missing part becomes zero | 7/**1** | shown in the server's order |
| the decomposition shows with nothing played | 7/**1** | nothing to take apart |
| the not-ready reason is reworded | 7/**1** | printed as it arrives |
| `no_results_yet` is called a preseason forecast | 7/**1** | not a preseason forecast |
| the page surfaces an error for a route that may not exist | 7/**1** | rendered beside the simulation |
| the panel is removed from the page | 7/**1** | rendered beside the simulation |

## One assertion was scoped to what is shown

Two checks forbid wording the panel must not use — "preseason", "not ready
yet". The panel's own header explains that `no_results_yet` is *not* a
preseason forecast, and a whole-file check forbade the explanation along with
the mistake. The checks now run against the file with its comments stripped.
Naming what was avoided is the opposite of doing it.
