# Gridiron HQ — 2026 Fantasy Football Command Center

A local full-stack fantasy dashboard: a trade engine that finds and prices deals across your
league, weekly matchup analytics built from four seasons of real boxscores, a rankings and mock
draft room, X's-and-O's breakdowns for all 32 NFL teams, and ESPN/Sleeper league sync.

Everything runs on your own machine. No hosting, no accounts, no telemetry — data lives in a
local SQLite file.

---

## Install

No command line needed:

1. On this page, click **Code → Download ZIP**, then unzip it.
2. **macOS**: double-click **`Install Gridiron HQ.command`**.
   **Windows**: double-click **`Install Gridiron HQ.cmd`**.
3. The first time, your OS will warn that the file is from an unidentified source. This is
   normal for anything downloaded from the internet that isn't from a paid Apple/Microsoft
   developer account, and it only happens once — after this one-time step, every future
   double-click just works, no warning.
   - **Windows**: click **More info → Run anyway**.
   - **Mac**: double-click the file. If nothing happens, open **System Settings → Privacy &
     Security**, scroll to the bottom, click **Open Anyway** next to "Install Gridiron HQ.command
     was blocked," confirm with your password or Touch ID, then double-click the file once more.

A window opens and does everything: installs Node.js if you don't have it, installs every
package, builds the interface, seeds the database, pulls live NFL data, and puts a **Gridiron HQ**
icon on your Desktop. Double-click that icon any time afterward to start the app — the installer
is only for the first run.

If Node had to be installed fresh, you may need to double-click the installer file a second time
to pick it up.

<details>
<summary>Prefer the command line?</summary>

**macOS / Linux**

```bash
git clone https://github.com/BouncySlime1215/gridiron-hq.git && cd gridiron-hq && ./install.sh
```

**Windows** (PowerShell)

```powershell
git clone https://github.com/BouncySlime1215/gridiron-hq.git; cd gridiron-hq; powershell -ExecutionPolicy Bypass -File install.ps1
```

Same installer either way — cloning with git instead of downloading a ZIP just makes `git pull`
available later for updates. Flags: `--no-shortcut` (skip the Desktop launcher), `--no-data`
(skip the live data pull), `--quick` (one season of boxscores instead of three), `--key sk-ant-...`
(set the API key non-interactively).
</details>

Requires **Node.js 22.5+** (the app uses Node's built-in SQLite, so there is nothing to compile
and no native build step to go wrong) — the installer gets this for you automatically where it can.

### Your Claude API key

**Optional.** Every number in the app — projections, trade scores, matchup ratings, opponent
history, the scouting report — is computed locally and works with no key at all.

A key adds the *written* layer: trade pitch copy, scouting prose, and buy/sell verdicts. It uses
Claude Haiku and costs a few cents a month. The installer offers to save one, or add it later in
the app under **Dev Hub** (top right). It is stored in a git-ignored `.env` and never leaves your
machine.

### Connecting your league

On the **My Leagues** page, add an ESPN or Sleeper league.

- **Sleeper** and **public ESPN** leagues need only the league ID.
- **Private ESPN** leagues also need your `espn_s2` and `SWID` cookies — the **ESPN Settings**
  page walks you through finding them in your browser. They are stored only in the local SQLite
  file and are sent only to ESPN.

---

## What's in it

### Trade Lab

The core of the app. Every deal is scored on one currency: **points your optimal starting lineup
projects for**, adjusted for how each defense actually treats that position. A roster is only as
good as the players it can start, so a trade is a win when your lineup projects higher afterwards
— regardless of how the raw player values add up.

- **Find deals** — enumerates realistic packages against all nine rivals, scores both sides, and
  ranks them. Flags the ones where *both* lineups improve, which is what makes a trade get
  accepted rather than laughed at.
- **Target a player** — name anyone in your league and get a three-rung offer ladder: what to
  open with, where to settle, and the point past which you are overpaying. Includes how
  replaceable he is to his current owner, which is the whole basis of your leverage. If he
  wouldn't crack your lineup, it says so and tells you what bar a real upgrade has to clear.
- **Mock a trade** — pick any players from two rosters and see who wins, with before/after
  lineups, market fairness, weekly floor/ceiling shift, and playoff-week impact.
- **Matchups** — defense-vs-position rankings computed from four seasons of weekly boxscores.

### My Team → Scouting report

Where you're strong, where you're thin, and what to do about it: position-by-position strength
against the other teams in *your* league, what your lineup loses if your best player at each spot
goes down, bye-week collisions among starters, whose Weeks 15–17 schedule turns, and a
priority-ordered fix list.

### The rest

- **Players** — one board with projections, VOR, ADP, market value, weekly floor/ceiling, boom and
  bust rates, schedule strength, and sparklines.
- **Draft Room** — mock drafts and live-draft tracking, best-available driven by *your* board.
- **32 Teams** — offense/defense/special-teams formation views, scheme and coach breakdowns,
  unit-level analysis. Reflects the 2026 offseason.
- **Camp News** — team news feeds with optional AI scheme and fantasy analysis.

---

## Running it

```bash
npm start
```

Opens at <http://localhost:5177>. That's the Desktop launcher's job too.

For development with hot reload:

```bash
npm run dev
```

Frontend on 5178, API on 5177.

### Refreshing data

The **Refresh data** button in the app header repulls rosters, news, projections and market
values. From the command line:

```bash
npm run sync:data
```

Add `--quick` for one season of boxscores instead of three.

---

## How the analytics work

**Defense vs position** is computed from `player_gamelog` — every weekly boxscore for the top 400
players across the last several seasons. For each defense and position it takes the weighted mean
fantasy points allowed, expressed as a multiplier of league average. Recent seasons count more.
Only games where the player cleared a startable score count: including every WR5 who played six
snaps drags every defense toward the same number and washes out the signal.

**Opponent history** is the same data cut per player: his average against a given team versus his
own weighted baseline. Relative to his own norm, so a 22-ppg receiver isn't flagged as "great
against Dallas" for a 20-point game.

**Schedule adjustment** multiplies each player's per-game projection by the mean matchup
multiplier of his remaining slate, with the fantasy-playoff weeks (15–17) tracked separately —
that stretch is the only one that decides a title.

**Lineup solving** fills dedicated slots with the top player at each position, then flex slots
from whoever is left. That greedy order is optimal here because flex eligibility is a superset of
the dedicated slots it competes with.

**Market value** comes from FantasyCalc, priced per league format — a superflex QB is worth
roughly double his 1QB value, so each league shape gets its own value set. It is tracked as a
*separate* axis from lineup points, because "did I improve" and "did I get fleeced" are different
questions and a good deal answers both.

Kickers and defenses are deliberately excluded from lineup scoring: they're near-random week to
week and roughly interchangeable, so including them only adds noise to every comparison.

---

## Notes

- ESPN cookies and your API key live only in local files (`server/data.sqlite`, `.env`), both
  git-ignored.
- To reset everything, delete `server/data.sqlite*` and restart — the seed reloads.
- Depth charts and coaching data are a July 2026 snapshot; the live syncs update rosters and
  ownership on top of it.
