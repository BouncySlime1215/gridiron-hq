"""Shared, cutoff-safe dataset foundations for the NFL spread research labs.

Codex plan section 6.4 and section 10.3: "Extract a shared cutoff-safe dataset
builder from the overlapping `market_lab.py` and `tree_lab.py` logic," and
"`research/betting/nfl/dataset.py` -- Shared earlier-only feature/label
construction extracted from existing labs, with consumer parity tests."

The duplication was not subtle. `tree_lab.build_dataset` carries a comment that
says so in as many words:

    # --- everything above this line mirrors market_lab.build_dataset's setup ---

Two copies of a chronology is two chronologies. They agree today because
someone kept them in step by hand; the first time one is fixed and the other is
not, two experiments quietly stop being comparable, and nothing fails.

WHAT THIS MODULE OWNS.

  * The read-only snapshot connection. Both labs open the live database while a
    collector may be writing to it, and both wrap the read in a transaction to
    get a consistent view. That is a correctness property, not a nicety.

  * The publication proxy. A game's result is treated as knowable three days
    after its gameday, and a week's derived team features are treated as
    knowable at the LAST such instant in that week. Conservative on purpose:
    the alternative is to assume a stat was available the moment the whistle
    blew, which it was not.

  * Earlier-only lookups. `history_before` and `features_before` return what
    was publishable strictly before a decision instant, and nothing else.

WHAT IT DELIBERATELY DOES NOT OWN. It does not build labels. `market_lab` and
`tree_lab` label against the OPENING line; the T-60 experiment in section 6.4
must label against the exact offered contract at the cutoff, which is a
different question about a different number. Sharing the chronology while
keeping the labels separate is the point: the thing that must not drift is what
was knowable when.
"""
from __future__ import annotations

import collections
import json
import math
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

# The conservative publication proxy both labs already use: a result is treated
# as knowable three days after its gameday, not at the final whistle.
RESULT_PUBLICATION_LAG = timedelta(days=3)

# The settled-label cutoff both labs apply before fitting: training rows must
# have settled a week before the earliest decision being scored.
SETTLED_LABEL_LAG = timedelta(days=7)

DATASET_VERSION = 'nfl-shared-dataset-v1'


def stamp(value):
    """Parse a timestamp to an aware UTC datetime, or None.

    Returns None rather than raising, and rather than guessing: an unparseable
    clock is missing information, and a row whose time cannot be established
    must be dropped by the caller, never assigned a plausible one.
    """
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    text = str(value).strip()
    if not text:
        return None
    if text.endswith('Z'):
        text = text[:-1] + '+00:00'
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        for fmt in ('%Y-%m-%d', '%Y-%m-%d %H:%M:%S'):
            try:
                parsed = datetime.strptime(text, fmt)
                break
            except ValueError:
                continue
        else:
            return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def read_only_connection(db_path):
    """A consistent read snapshot of the live database.

    `mode=ro` because a research lab must never write to the application's
    database, and BEGIN because the live collector may be writing while this
    reads -- without it, two queries in the same build can see different states
    of the world and produce a dataset that never existed at any instant.
    """
    con = sqlite3.connect(Path(db_path).resolve().as_uri() + '?mode=ro', uri=True)
    con.row_factory = sqlite3.Row
    con.execute('BEGIN')
    return con


def load_games(con, through_season=2025):
    """Home-perspective game rows, in chronological order."""
    return [dict(x) for x in con.execute(
        '''SELECT season,week,team,opponent,spread,total,team_score,opp_score,gameday,
                  rest_days,div_game,roof
             FROM game_lines WHERE home=1 AND season<=? ORDER BY season,week''', (through_season,))]


def rest_by_team_week(con):
    """Every team's OWN rest days.

    The home-only game query carries only the home team's rest; the away team's
    rest lives on its own row. Reading it from the home row for both sides --
    which is the obvious shortcut -- silently assigns one team's schedule to the
    other.
    """
    return {(r['season'], r['week'], r['team']): r['rest_days']
            for r in con.execute('SELECT season,week,team,rest_days FROM game_lines')}


def build_chronology(games):
    """Publication times, result history and a game index, from the same rows.

    Returns `(history, week_end, game_map)`:

      history   team -> [(publishable_at, margin, total)], sorted
      week_end  (season, week) -> the last instant that week became publishable
      game_map  (season, week, home_team) -> the game row

    `week_end` is the LAST game of the week rather than the first: a team-week
    feature derived from a full week of play cannot be knowable before the
    week's final game has been played and published.
    """
    history = collections.defaultdict(list)
    week_end = {}
    game_map = {}
    for g in games:
        game_map[(g['season'], g['week'], g['team'])] = g
        day = stamp(g['gameday'])
        if day is None or g['team_score'] is None or g['opp_score'] is None:
            continue
        ready = day + RESULT_PUBLICATION_LAG
        key = (g['season'], g['week'])
        week_end[key] = max(week_end.get(key, ready), ready)
        margin = g['team_score'] - g['opp_score']
        total = g['team_score'] + g['opp_score']
        for team, signed in ((g['team'], margin), (g['opponent'], -margin)):
            history[team].append((ready, signed, total))
    for values in history.values():
        values.sort(key=lambda z: z[0])
    return history, week_end, game_map


def load_team_week_features(con, week_end, through_season=2025):
    """Play-by-play derived team-week features, stamped with publication time.

    A week whose publication instant is unknown is DROPPED rather than given a
    default. A feature with no knowable availability cannot be used by a
    cutoff-safe model, and assigning it one is exactly the leak this module
    exists to prevent.
    """
    pbp = collections.defaultdict(list)
    for r in con.execute(
            'SELECT season,week,team,features FROM nfl_team_week_features WHERE season<=?',
            (through_season,)):
        ready = week_end.get((r['season'], r['week']))
        if ready is None:
            continue
        try:
            parsed = json.loads(r['features'])
        except (TypeError, ValueError):
            continue
        pbp[r['team']].append((ready, parsed))
    for values in pbp.values():
        values.sort(key=lambda z: z[0])
    return pbp


def history_before(history, team, decision_at, limit=None):
    """That team's results publishable STRICTLY before `decision_at`."""
    rows = [entry for entry in history.get(team, ()) if entry[0] < decision_at]
    return rows[-limit:] if limit else rows


def features_before(pbp, team, decision_at):
    """The latest team-week feature set publishable strictly before the cutoff."""
    latest = None
    for ready, values in pbp.get(team, ()):
        if ready < decision_at:
            latest = values
        else:
            break
    return latest


def american_profit(price):
    """Profit per unit risked at an American price, or None.

    Shared with the Node contract in
    `server/betting/nfl/contracts/spread-probabilities.js`, deliberately: two
    implementations of a payout formula is how a research result and a
    production decision come to disagree about what a bet was worth.
    """
    if price is None:
        return None
    try:
        value = float(price)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(value) or abs(value) < 100:
        return None
    return value / 100.0 if value > 0 else 100.0 / abs(value)


def fold_cutoff(scored_rows, lag=SETTLED_LABEL_LAG):
    """The settled-label cutoff for a fold: a week before its earliest decision.

    Both labs compute this identically today, in four separate places between
    them. A training row whose label settled after this instant was not
    available to fit on, however far in the past its game was.
    """
    decisions = [stamp(r['decision_at']) for r in scored_rows]
    decisions = [d for d in decisions if d is not None]
    if not decisions:
        return None
    return min(decisions) - lag


def eligible_training_rows(rows, scored_rows, *, market=None, before_season=None):
    """Rows legal to FIT on, given the rows being scored.

    Two conditions, both required and both easy to get half right:
      * the row's season is strictly earlier than the fold being scored, and
      * its label had settled before the fold's cutoff.

    Applying only the first is the common mistake: it keeps a game from an
    earlier season whose label settled after the decision being scored, which
    looks chronological and is not.
    """
    cutoff = fold_cutoff(scored_rows)
    if cutoff is None:
        return []
    out = []
    for r in rows:
        if market is not None and r.get('market') != market:
            continue
        if before_season is not None and r['season'] >= before_season:
            continue
        settled = stamp(r.get('label_at'))
        if settled is None or settled >= cutoff:
            continue
        out.append(r)
    return out


def shared_setup(db_path, through_season=2025):
    """Everything both labs build before they diverge.

    This is literally the block `tree_lab.build_dataset` marks with
    "everything above this line mirrors market_lab.build_dataset's setup".
    """
    con = read_only_connection(db_path)
    try:
        games = load_games(con, through_season)
        rest = rest_by_team_week(con)
        history, week_end, game_map = build_chronology(games)
        pbp = load_team_week_features(con, week_end, through_season)
    finally:
        con.close()
    return {
        'dataset_version': DATASET_VERSION,
        'games': games, 'rest_by_team_week': rest,
        'history': history, 'week_end': week_end, 'game_map': game_map, 'pbp': pbp,
        'result_publication_lag_days': RESULT_PUBLICATION_LAG.days,
        'settled_label_lag_days': SETTLED_LABEL_LAG.days,
    }
