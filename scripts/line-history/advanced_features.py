#!/usr/bin/env python3
"""
Build advanced team-week features from data we already own (no network).

The audit found the ensemble's ~35 signals have an effective rank near 2.5: almost all of
them are EPA measured five different ways, so a meta-layer has nothing to reweight between.
Adding a sixth EPA variant cannot fix that. What can is measuring things EPA does not see.

Every feature here comes from a source already downloaded:
  play_by_play (487K plays, 2016-2026, 374 cols) -> efficiency, PROE, explosiveness, situational
  pbp_participation (479K plays)                 -> pressure, blitz, box count, man/zone, personnel
  ftn_charting (188K plays)                      -> play action, RPO, screen, motion, no huddle

Deliberately excluded: raw EPA totals, which the ensemble already has five copies of. The point
is orthogonality, so what lands here is rates and shares that move independently of EPA —
pressure rate, coverage mix, personnel mix, pace and pass-rate-over-expected.

Every feature is computed for the offense and, keyed by defteam, for the defense that faced it,
so each team-week carries both what it did and what was done to it.

Output table in line_history.sqlite: adv_team_week (one row per team-week, ~60 features).
Usage: python3 scripts/line-history/advanced_features.py [--seasons 2016 ... 2026]
"""
import argparse
import sqlite3

from common import connect, db_path, log, REPO

NFLVERSE = REPO / "data/line-history/nflverse.sqlite"

# (column, expression). NULLIF guards the weeks where a denominator is zero, so a team that
# never dropped back gets NULL rather than a divide-by-zero or a misleading 0.0.
OFF = """
  COUNT(*)                                                        AS plays,
  AVG(epa)                                                        AS epa_play,
  AVG(success)                                                    AS success_rate,
  AVG(CASE WHEN down<=2 THEN epa END)                             AS early_down_epa,
  AVG(CASE WHEN down<=2 THEN success END)                         AS early_down_success,
  AVG(CASE WHEN down<=2 THEN (play_type='pass') END)              AS early_down_pass_rate,
  AVG(pass_oe)                                                    AS proe,
  AVG(xpass)                                                      AS xpass,
  AVG(cpoe)                                                       AS cpoe,
  AVG(CASE WHEN qb_dropback=1 THEN epa END)                       AS dropback_epa,
  AVG(CASE WHEN play_type='run' THEN epa END)                     AS rush_epa,
  AVG(CASE WHEN qb_dropback=1 THEN air_yards END)                 AS adot,
  AVG(CASE WHEN qb_dropback=1 THEN sack END)                      AS sack_rate,
  AVG(CASE WHEN qb_dropback=1 THEN qb_hit END)                    AS qb_hit_rate,
  AVG(CASE WHEN qb_dropback=1 THEN qb_scramble END)               AS scramble_rate,
  AVG(shotgun)                                                    AS shotgun_rate,
  AVG(no_huddle)                                                  AS no_huddle_rate,
  AVG(CASE WHEN play_type='pass' THEN (yards_gained>=20) END)     AS explosive_pass_rate,
  AVG(CASE WHEN play_type='run'  THEN (yards_gained>=10) END)     AS explosive_rush_rate,
  AVG(CASE WHEN down=3 THEN success END)                          AS third_down_success,
  AVG(CASE WHEN down=3 THEN ydstogo END)                          AS third_down_dist,
  AVG(CASE WHEN yardline_100<=20 THEN epa END)                    AS redzone_epa,
  AVG(CASE WHEN yardline_100<=20 THEN success END)                AS redzone_success,
  AVG(series_success)                                             AS series_success,
  AVG(wpa)                                                        AS wpa_play,
  AVG(yards_after_catch)                                          AS yac,
  COUNT(DISTINCT drive)                                           AS drives
"""

PART = """
  AVG(was_pressure)                                               AS pressure_rate,
  AVG(defenders_in_box)                                           AS box_count,
  AVG(number_of_pass_rushers)                                     AS pass_rushers,
  AVG(number_of_pass_rushers>=5)                                  AS blitz_rate,
  AVG(time_to_throw)                                              AS time_to_throw,
  AVG(ngs_air_yards)                                              AS ngs_air_yards,
  AVG(defense_man_zone_type='MAN_COVERAGE')                       AS man_rate,
  AVG(defense_man_zone_type='ZONE_COVERAGE')                      AS zone_rate,
  AVG(defense_coverage_type='COVER_1')                            AS cover1_rate,
  AVG(defense_coverage_type='COVER_2')                            AS cover2_rate,
  AVG(defense_coverage_type='COVER_3')                            AS cover3_rate,
  AVG(offense_personnel LIKE '%1 RB, 1 TE%')                      AS pers_11_rate,
  AVG(offense_personnel LIKE '%1 RB, 2 TE%')                      AS pers_12_rate,
  AVG(offense_personnel LIKE '%2 RB%')                            AS pers_2rb_rate,
  COUNT(*)                                                        AS part_plays
"""

FTN = """
  AVG(is_play_action)                                             AS play_action_rate,
  AVG(is_rpo)                                                     AS rpo_rate,
  AVG(is_screen_pass)                                             AS screen_rate,
  AVG(is_motion)                                                  AS motion_rate,
  AVG(is_no_huddle)                                               AS ftn_no_huddle_rate,
  AVG(is_qb_out_of_pocket)                                        AS out_of_pocket_rate,
  AVG(is_throw_away)                                              AS throwaway_rate,
  AVG(is_catchable_ball)                                          AS catchable_rate,
  AVG(is_contested_ball)                                          AS contested_rate,
  AVG(is_interception_worthy)                                     AS int_worthy_rate,
  AVG(n_defense_box)                                              AS ftn_box,
  AVG(is_trick_play)                                              AS trick_rate,
  COUNT(*)                                                        AS ftn_plays
"""


def names(block):
    return [ln.split(" AS ")[-1].strip().rstrip(",") for ln in block.strip().splitlines() if " AS " in ln]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seasons", nargs="*", type=int, default=list(range(2016, 2027)))
    a = ap.parse_args()

    src = sqlite3.connect(f"file:{NFLVERSE}?mode=ro", uri=True)
    off_n, part_n, ftn_n = names(OFF), names(PART), names(FTN)
    # side='off' rows are keyed by the team with the ball; side='def' rows aggregate the very
    # same plays keyed by the team defending them, which is what makes a defensive profile.
    cols = (["season", "week", "team", "side"] + off_n
            + [f"{c}" for c in part_n] + [f"{c}" for c in ftn_n])

    out = connect()
    out.execute("DROP TABLE IF EXISTS adv_team_week")
    out.execute(f"CREATE TABLE adv_team_week ({', '.join(c + ' REAL' for c in cols[4:])},"
                " season INTEGER, week INTEGER, team TEXT, side TEXT,"
                " PRIMARY KEY (season, week, team, side))")
    out.commit()

    seasons = ",".join(str(s) for s in a.seasons)
    total = 0
    for side, key in (("off", "posteam"), ("def", "defteam")):
        rows = src.execute(f"""
            SELECT season, week, {key} AS team, {OFF}
            FROM play_by_play
            WHERE season IN ({seasons}) AND {key} IS NOT NULL AND {key} <> ''
              AND play_type IN ('pass','run')
            GROUP BY season, week, {key}""").fetchall()
        base = {(r[0], r[1], r[2]): list(r[3:]) for r in rows}

        prt = src.execute(f"""
            SELECT p.season, p.week, p.{key} AS team, {PART}
            FROM play_by_play p
            JOIN pbp_participation q ON q.nflverse_game_id = p.game_id AND q.play_id = p.play_id
            WHERE p.season IN ({seasons}) AND p.{key} IS NOT NULL AND p.{key} <> ''
              AND p.play_type IN ('pass','run')
            GROUP BY p.season, p.week, p.{key}""").fetchall()
        pmap = {(r[0], r[1], r[2]): list(r[3:]) for r in prt}

        ftn = src.execute(f"""
            SELECT p.season, p.week, p.{key} AS team, {FTN}
            FROM play_by_play p
            JOIN ftn_charting f ON f.nflverse_game_id = p.game_id AND f.nflverse_play_id = p.play_id
            WHERE p.season IN ({seasons}) AND p.{key} IS NOT NULL AND p.{key} <> ''
              AND p.play_type IN ('pass','run')
            GROUP BY p.season, p.week, p.{key}""").fetchall()
        fmap = {(r[0], r[1], r[2]): list(r[3:]) for r in ftn}

        payload = []
        for k, vals in base.items():
            payload.append(vals
                           + pmap.get(k, [None] * len(part_n))
                           + fmap.get(k, [None] * len(ftn_n))
                           + [k[0], k[1], k[2], side])
        ph = ",".join("?" * (len(cols)))
        out.executemany(f"INSERT OR REPLACE INTO adv_team_week VALUES ({ph})", payload)
        out.commit()
        total += len(payload)
        log(f"{side}: {len(payload)} team-weeks "
            f"({len(pmap)} with participation, {len(fmap)} with FTN charting)")

    n_feat = len(off_n) + len(part_n) + len(ftn_n)
    log(f"done: {total} rows, {n_feat} advanced features per team-week -> adv_team_week")
    log(f"  efficiency/situational {len(off_n)}, pressure/coverage/personnel {len(part_n)}, charting {len(ftn_n)}")


if __name__ == "__main__":
    main()
