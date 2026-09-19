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

import injury_admission
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
    """Home-perspective game rows, in chronological order.

    `open_spread`/`open_total` alongside the closing `spread`/`total`: both
    are legitimately pregame-known (the opener sets days before kickoff, the
    closer settles before it), so unlike the outcome fields neither is an
    information-boundary risk on its own. They stay gated behind
    `include_labels` below anyway, matching where `spread`/`total` already
    live -- one place market data is grouped, not a second ungated path in.
    """
    return [dict(x) for x in con.execute(
        '''SELECT season,week,team,opponent,spread,total,open_spread,open_total,
                  team_score,opp_score,gameday,rest_days,div_game,roof
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


def build_chronology(games, quarantine=None):
    """Publication times, result history and a game index, from the same rows.

    Returns `(history, week_end, game_map)`:

      history   team -> [(publishable_at, margin, total)], sorted
      week_end  (season, week) -> the last instant that week became publishable
      game_map  (season, week, home_team) -> the game row

    `week_end` is the LAST game of the week rather than the first: a team-week
    feature derived from a full week of play cannot be knowable before the
    week's final game has been played and published.

    `quarantine`, if given, is a dict this function appends to under
    `'games_excluded'` for every row it drops, naming the identity and reason
    -- so an unusable game is counted and named rather than vanishing with no
    trace (Codex plan Stage 1: quarantine invalid records, don't silently
    erase them). Optional and additive so existing direct callers/tests that
    only want `(history, week_end, game_map)` are unaffected.
    """
    history = collections.defaultdict(list)
    week_end = {}
    game_map = {}
    for g in games:
        game_map[(g['season'], g['week'], g['team'])] = g
        day = stamp(g['gameday'])
        if day is None or g['team_score'] is None or g['opp_score'] is None:
            if quarantine is not None:
                reason = 'unparseable_or_missing_gameday' if day is None else 'missing_final_score'
                quarantine.setdefault('games_excluded', []).append({
                    'season': g['season'], 'week': g['week'], 'team': g['team'],
                    'opponent': g.get('opponent'), 'reason': reason})
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


def load_team_week_features(con, week_end, through_season=2025, quarantine=None):
    """Play-by-play derived team-week features, stamped with publication time.

    A week whose publication instant is unknown is DROPPED rather than given a
    default. A feature with no knowable availability cannot be used by a
    cutoff-safe model, and assigning it one is exactly the leak this module
    exists to prevent.

    `quarantine`, if given, collects every dropped row under
    `'team_week_features_excluded'` with its identity and reason. Optional and
    additive, same contract as `build_chronology`'s `quarantine` parameter.
    """
    pbp = collections.defaultdict(list)
    for r in con.execute(
            'SELECT season,week,team,features FROM nfl_team_week_features WHERE season<=?',
            (through_season,)):
        ready = week_end.get((r['season'], r['week']))
        if ready is None:
            if quarantine is not None:
                quarantine.setdefault('team_week_features_excluded', []).append({
                    'season': r['season'], 'week': r['week'], 'team': r['team'],
                    'reason': 'no_publication_instant_for_week'})
            continue
        try:
            parsed = json.loads(r['features'])
        except (TypeError, ValueError):
            if quarantine is not None:
                quarantine.setdefault('team_week_features_excluded', []).append({
                    'season': r['season'], 'week': r['week'], 'team': r['team'],
                    'reason': 'unparseable_json'})
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


def football_feature_row(game, setup, cutoff, *, history_window=8, include_labels=False):
    """One shared feature row for historical learning and upcoming-game scoring.

    Caller supplies a retained/read-only setup and an explicit information
    cutoff. Outcome fields are omitted for inference, including when a caller
    happens to have a later final score in its input snapshot.
    """
    g = game
    day = stamp(cutoff)
    if day is None:
        raise ValueError('feature cutoff is required')
    history, pbp = setup['history'], setup['pbp']
    rest = setup['rest_by_team_week']
    home_hist = history_before(history, g['team'], day, limit=history_window)
    away_hist = history_before(history, g['opponent'], day, limit=history_window)
    home_pbp = features_before(pbp, g['team'], day)
    away_pbp = features_before(pbp, g['opponent'], day)
    row = {
        'season': g['season'], 'week': g['week'], 'home': g['team'], 'away': g['opponent'],
        'gameday': g['gameday'], 'decision_at': day.isoformat(),
        'home_rest': rest.get((g['season'], g['week'], g['team'])),
        'away_rest': rest.get((g['season'], g['week'], g['opponent'])),
        'div_game': g.get('div_game'), 'roof': g.get('roof'),
        'home_prior_games': [{'at': r[0].isoformat(), 'margin': r[1], 'total': r[2]} for r in home_hist],
        'away_prior_games': [{'at': r[0].isoformat(), 'margin': r[1], 'total': r[2]} for r in away_hist],
        'home_pbp_features': home_pbp, 'away_pbp_features': away_pbp,
        'pbp_available': home_pbp is not None and away_pbp is not None,
    }
    # Absent unless the caller opted in, so the dataset every existing
    # baseline was measured on is reproduced exactly.
    if setup.get('availability'):
        row.update(availability_features(
            setup['availability'], season=g['season'], week=g['week'],
            home=g['team'], away=g['opponent']))
    # Same opt-in discipline as availability above: RECIPE_V3 (RUNBOOK
    # Sec4.1, starting-QB-quality) only sees these keys when the caller
    # passed `qb_quality_path=...`, so every existing baseline -- including
    # ones already measured with `availability_path` but not this -- still
    # reproduces byte for byte with no path given.
    if setup.get('qb_quality'):
        row.update(qb_quality_features(
            setup['qb_quality'], season=g['season'], week=g['week'],
            home=g['team'], away=g['opponent']))
    if include_labels:
        open_spread = g.get('open_spread')
        row.update(actual_margin=g['team_score'] - g['opp_score'],
                   actual_total=g['team_score'] + g['opp_score'],
                   market_spread=g.get('spread'), market_total=g.get('total'),
                   open_spread=open_spread, open_total=g.get('open_total'),
                   # Positive means the closing line moved toward the home
                   # team relative to the opener (spread more negative =
                   # bigger home favorite); None when either side is missing,
                   # never a fabricated zero.
                   market_movement=(-(g['spread'] - open_spread))
                       if g.get('spread') is not None and open_spread is not None else None)
    return row


def build_football_dataset(db_path, min_season=1999, through_season=2025, history_window=8,
                           availability_path=None, qb_quality_path=None):
    """Broad, price-agnostic dataset spanning every season with a final score.

    Stage 2 of the Codex plan: `market_lab.py`/`tree_lab.py` both hard-require
    archived Pinnacle opening prices and gate to season>=2022, which starves
    team/player-strength learning to roughly 200 games per fold even though
    `game_lines` itself holds results back to 1999. This builder needs no
    quote at all -- the label is the actual game outcome (margin, total), not
    a market-movement target -- so nothing here is gated to 2022+.

    Advanced team-week features (EPA etc, from `nfl_team_week_features`) only
    exist from the 2016 season forward. Rows from earlier seasons are NOT
    dropped: they carry `pbp_available: False` and null pbp fields, because
    prior-game scoring history (`history_before`) is real signal across the
    full window on its own, and a model consuming this dataset can condition
    on `pbp_available` rather than lose 17 seasons of results outright.

    Each row's decision instant is the game's own kickoff (`gameday`), not
    the week's publication instant used elsewhere in this module: this is a
    PREGAME feature row, so only history and features knowable strictly
    before this game's own kickoff may appear on it -- `history_before` and
    `features_before` already enforce that "strictly before" boundary.
    """
    setup = shared_setup(db_path, through_season, availability_path=availability_path,
                         qb_quality_path=qb_quality_path)
    history, pbp = setup['history'], setup['pbp']
    rest, game_map = setup['rest_by_team_week'], setup['game_map']
    out = []
    for g in setup['games']:
        if g['season'] < min_season:
            continue
        day = stamp(g['gameday'])
        if day is None or g['team_score'] is None or g['opp_score'] is None:
            continue  # already quarantined by build_chronology inside shared_setup
        out.append(football_feature_row(g, setup, day, history_window=history_window, include_labels=True))
    out.sort(key=lambda r: (r['season'], r['week'], r['home']))
    return {
        'dataset_version': DATASET_VERSION + '-football',
        'min_season': min_season, 'through_season': through_season,
        'availability': {k: v for k, v in (setup['availability'] or {}).items() if k != 'index'} or None,
        'qb_quality': {k: v for k, v in (setup['qb_quality'] or {}).items() if k != 'index'} or None,
        'rows': out,
        'quarantine': setup['quarantine'],
    }


def paired_quotes(con, game_map, min_season=2022, through_season=2025, quarantine=None):
    """Pinnacle open/close spread and total quotes, paired per game and validated.

    THE CHRONOLOGY-CRITICAL BLOCK. `market_lab.py` and `tree_lab.py` each
    independently implement this exact archive join, timestamp validation and
    decision-time computation -- `tree_lab.build_dataset`'s own docstring
    names the risk: "two extractors that are meant to agree on what a
    decision-time-safe row looks like can drift apart silently... A follow-up
    worth doing is factoring the shared chronology block into one importable
    function both scripts call." This is that function.

    Feature construction is deliberately NOT done here: the two labs build
    different feature sets (`tree_lab` adds interaction terms, a second
    recent-form window and extra pbp keys `market_lab` never extracts) from
    the same validated ingredients. Forcing one feature set into this shared
    layer would either shrink `tree_lab`'s or bloat `market_lab`'s.

    Returns a list of dicts, one per (event, market) that survives every
    check, sorted by decision time: `eid`, `market`, `season`, `week`,
    `home`, `away`, `sample` (the raw archive row used for team names), `o`/
    `opposite`/`c` (open positive-side, open negative-side, close
    positive-side quote rows), `g` (the matching `game_lines` row), `decision`
    (the aware UTC instant a decision could legally be made -- the later of
    the two opening quotes' `book_updated_at`), `kick`, `ct` (close time).
    """
    archive = [dict(x) for x in con.execute(
        '''SELECT eid,season,week,home,away,commence_time,market,side,phase,line,price,
                  book_updated_at,source FROM nfl_odds_archive
           WHERE book='pinnacle' AND market IN ('spreads','totals')
             AND season BETWEEN ? AND ?''', (min_season, through_season))]
    by_game = collections.defaultdict(dict)
    for q in archive:
        by_game[(q['eid'], q['market'])][(q['phase'], q['side'])] = q

    def drop(eid, market, reason):
        if quarantine is not None:
            quarantine.setdefault('quote_pairs_excluded', []).append(
                {'eid': str(eid), 'market': market, 'reason': reason})

    out = []
    for (eid, market), qs in by_game.items():
        sample = next(iter(qs.values()))
        pos = sample['home'] if market == 'spreads' else 'Over'
        neg = sample['away'] if market == 'spreads' else 'Under'
        o = qs.get(('open', pos)); opposite = qs.get(('open', neg)); c = qs.get(('close', pos))
        g = game_map.get((sample['season'], sample['week'], sample['home']))
        if not all([o, opposite, c, g]):
            drop(eid, market, 'missing_pair_or_result'); continue
        ot, nt, ct, kick = [stamp(v) for v in [o['book_updated_at'], opposite['book_updated_at'],
                                                 c['book_updated_at'], sample['commence_time']]]
        if any(t is None for t in [ot, nt, ct, kick]) or not (ot <= ct < kick) or abs((nt - ot).total_seconds()) > 60:
            drop(eid, market, 'invalid_or_unpaired_timestamps'); continue
        decision = max(ot, nt)
        if not decision < ct or decision >= kick or g['team_score'] is None or g['opp_score'] is None:
            drop(eid, market, 'no_future_close_or_score'); continue
        if any(american_profit(q['price']) is None for q in [o, opposite]):
            drop(eid, market, 'missing_real_prices'); continue
        if not all(isinstance(q['line'], (int, float)) and math.isfinite(q['line']) for q in [o, opposite, c]):
            drop(eid, market, 'bad_line'); continue
        if (market == 'spreads' and abs(o['line'] + opposite['line']) > 1e-9) or \
           (market == 'totals' and o['line'] != opposite['line']):
            drop(eid, market, 'different_contracts'); continue
        out.append({'eid': str(eid), 'market': market, 'season': g['season'], 'week': g['week'],
            'home': sample['home'], 'away': sample['away'], 'sample': sample,
            'o': o, 'opposite': opposite, 'c': c, 'g': g,
            'decision': decision, 'kick': kick, 'ct': ct})
    out.sort(key=lambda r: (r['decision'], r['eid'], r['market']))
    return out


def build_betting_dataset(db_path, min_season=2022, through_season=2025):
    """Everything both labs need for a price-gated, decision-time-safe row.

    The shared chronology (games/history/pbp/rest, same as `shared_setup`)
    plus validated, paired Pinnacle open/close quotes (`paired_quotes`), all
    read from ONE connection and ONE transaction snapshot -- deliberately not
    built on top of `shared_setup` itself, because that closes its connection
    before returning and a second connection here would let the live
    collector's writes land between two "consistent" reads that were never
    actually consistent with each other.

    Feature engineering is deliberately left to each lab; see `paired_quotes`.
    Kept separate from `build_football_dataset` because this one is gated to
    seasons with a real archived quote (2022+ today) and that one is not.
    """
    con = read_only_connection(db_path)
    quarantine = {'games_excluded': [], 'team_week_features_excluded': [], 'quote_pairs_excluded': []}
    try:
        games = load_games(con, through_season)
        rest = rest_by_team_week(con)
        history, week_end, game_map = build_chronology(games, quarantine=quarantine)
        pbp = load_team_week_features(con, week_end, through_season, quarantine=quarantine)
        quote_pairs = paired_quotes(con, game_map, min_season, through_season, quarantine=quarantine)
    finally:
        con.close()
    return {
        'dataset_version': DATASET_VERSION + '-betting',
        'min_season': min_season, 'through_season': through_season,
        'games': games, 'rest_by_team_week': rest,
        'history': history, 'week_end': week_end, 'game_map': game_map, 'pbp': pbp,
        'quote_pairs': quote_pairs,
        'result_publication_lag_days': RESULT_PUBLICATION_LAG.days,
        'settled_label_lag_days': SETTLED_LABEL_LAG.days,
        'quarantine': {
            'games_excluded_count': len(quarantine['games_excluded']),
            'games_excluded': quarantine['games_excluded'],
            'team_week_features_excluded_count': len(quarantine['team_week_features_excluded']),
            'team_week_features_excluded': quarantine['team_week_features_excluded'],
            'quote_pairs_excluded_count': len(quarantine['quote_pairs_excluded']),
            'quote_pairs_excluded': quarantine['quote_pairs_excluded'],
        },
    }


def load_availability(path):
    """Per-game weighted injury deficits exported by the JS module that owns them.

    The player-specific weighting -- each absence costing the snap share that
    player was actually taking, times a positional replacement weight, times a
    report-status factor -- lives in `server/services/nfl-availability.js` and
    is NOT reimplemented here. `scripts/export-availability-features.mjs`
    computes it at each game's own cutoff and writes the JSON this reads, so
    there is one copy of those weights rather than a Python second opinion
    that can drift from the one the production ensemble uses.

    Measured coverage on the current database: 1,083 of 7,548 games (14.4%).
    Injury rows exist only from 2021, and 2025/2026 rows carry no
    modification time at all, so they are inadmissible for historical use.
    """
    with open(path) as handle:
        payload = json.load(handle)
    index = {}
    for record in payload['records']:
        index[(record['season'], record['week'],
               injury_admission.canonical_team(record['home']),
               injury_admission.canonical_team(record['away']))] = record
    return {'schema': payload['schema'], 'source': payload['source'],
            'games_with_evidence': payload['games_with_evidence'],
            'games': payload['games'], 'index': index}


def availability_features(availability, *, season, week, home, away):
    """Weighted deficits for one game, or explicit absence of evidence.

    `None`, never zero, when there is no admissible evidence: zero is the
    claim "everyone who matters is playing", and this data cannot make that
    claim on a game it has no report for.
    """
    empty = {'home_availability_deficit': None, 'away_availability_deficit': None,
             'availability_evidence': False}
    if not availability:
        return empty
    record = availability['index'].get(
        (season, week, injury_admission.canonical_team(home), injury_admission.canonical_team(away)))
    if not record or not record.get('evidence'):
        return empty
    return {'home_availability_deficit': record['home_deficit'],
            'away_availability_deficit': record['away_deficit'],
            'availability_evidence': True}


def load_qb_quality(path):
    """Per-game starting-QB-quality signal exported by the JS module that owns it.

    RUNBOOK Sec4.1 (the next signal after injuries/availability measured no
    difference): the current week's starting quarterback -- identified from
    the public depth chart, which is legitimately known pregame -- matched by
    name into his own prior-weeks QBR history. That identification and
    matching lives in `server/services/nfl-qb-quality.js` and is NOT
    reimplemented here, for the same reason `load_availability` above does
    not reimplement the injury weighting: one copy of the matching logic,
    not a Python second opinion that can drift from it.
    `scripts/export-qb-quality-features.mjs` computes it at each game's own
    (season, week) and writes the JSON this reads.
    """
    with open(path) as handle:
        payload = json.load(handle)
    index = {}
    for record in payload['records']:
        index[(record['season'], record['week'],
               injury_admission.canonical_team(record['home']),
               injury_admission.canonical_team(record['away']))] = record
    return {'schema': payload['schema'], 'source': payload['source'],
            'games_with_evidence': payload['games_with_evidence'],
            'games': payload['games'], 'index': index}


def qb_quality_features(qbq, *, season, week, home, away):
    """Starting-QB-quality signal for one game, or explicit absence of evidence.

    `None`, never a fabricated league-average QBR, when either side has no
    identified starter or no admissible prior QBR history (a true rookie, or
    anyone whose first career start is this game) -- mirrors
    `availability_features`'s own never-zero-for-missing-evidence discipline.
    """
    empty = {'home_qb_qbr': None, 'away_qb_qbr': None, 'qb_quality_evidence': False}
    if not qbq:
        return empty
    record = qbq['index'].get(
        (season, week, injury_admission.canonical_team(home), injury_admission.canonical_team(away)))
    if not record or not record.get('evidence'):
        return empty
    return {'home_qb_qbr': record['home_qb_qbr'],
            'away_qb_qbr': record['away_qb_qbr'],
            'qb_quality_evidence': True}


def shared_setup(db_path, through_season=2025, availability_path=None, qb_quality_path=None):
    """Everything both labs build before they diverge.

    This is literally the block `tree_lab.build_dataset` marks with
    "everything above this line mirrors market_lab.build_dataset's setup".

    `availability_path` and `qb_quality_path` are both opt-in and default off
    so that the dataset the existing baselines were measured on is reproduced
    byte for byte.
    """
    con = read_only_connection(db_path)
    quarantine = {'games_excluded': [], 'team_week_features_excluded': []}
    try:
        games = load_games(con, through_season)
        rest = rest_by_team_week(con)
        history, week_end, game_map = build_chronology(games, quarantine=quarantine)
        pbp = load_team_week_features(con, week_end, through_season, quarantine=quarantine)
    finally:
        con.close()
    # Read from the exported JSON, not the database: the weighting/matching
    # that produced each lives in the JS module that owns it.
    availability = load_availability(availability_path) if availability_path else None
    qb_quality = load_qb_quality(qb_quality_path) if qb_quality_path else None
    return {
        'dataset_version': DATASET_VERSION,
        'games': games, 'rest_by_team_week': rest, 'availability': availability, 'qb_quality': qb_quality,
        'history': history, 'week_end': week_end, 'game_map': game_map, 'pbp': pbp,
        'result_publication_lag_days': RESULT_PUBLICATION_LAG.days,
        'settled_label_lag_days': SETTLED_LABEL_LAG.days,
        # Every game/feature row this setup excluded, named and counted rather
        # than silently vanished -- see build_chronology/load_team_week_features.
        'quarantine': {
            'games_excluded_count': len(quarantine['games_excluded']),
            'games_excluded': quarantine['games_excluded'],
            'team_week_features_excluded_count': len(quarantine['team_week_features_excluded']),
            'team_week_features_excluded': quarantine['team_week_features_excluded'],
        },
    }
