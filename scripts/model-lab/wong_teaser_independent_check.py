#!/usr/bin/env python3
"""
Independent re-measurement of the Wong-teaser leg rate (registry Tests 1-4 / hunt SB1),
on a DIFFERENT source from the one the registry used (nflverse nfldata_games, not game_lines),
with the things the original never did: a placebo, a bet-everything control, an explicit
break-even price with a confidence interval, and a bootstrap.

Why this one: the Jev audit ranked the teaser family's kill among the weakest in the corpus
(SB1 0.12/4, T01 0.46, T02 0.43, T04 0.32), and the whole family is "blocked on a price" --
so the number that decides it is the break-even PRICE, which the registry reports without
an interval. This computes it with one.

Read-only. Usage: python3 scripts/model-lab/wong_teaser_independent_check.py
"""
import sqlite3, random, math
from pathlib import Path

DB = Path(__file__).resolve().parents[2] / 'data/line-history/nflverse.sqlite'
con = sqlite3.connect(f'file:{DB}?mode=ro', uri=True)

rows = con.execute("""
  SELECT season, game_type, home_team, away_team, result, spread_line,
         home_spread_odds, away_spread_odds
  FROM nfldata_games
  WHERE spread_line IS NOT NULL AND result IS NOT NULL AND season <= 2025
""").fetchall()
print(f'{len(rows):,} completed games with a spread, 1999-2025')

TEASE = 6.0
def legs(rows, wong_only=True):
    """One record per qualifying side. line is in betting notation (negative = favourite)."""
    out = []
    for season, gt, h, a, result, sl, hp, ap in rows:
        for side, line, margin, price in (('home', -sl, result, hp), ('away', sl, -result, ap)):
            wong = (-8.5 <= line <= -7.5) or (1.5 <= line <= 2.5)
            if wong_only and not wong:
                continue
            if (not wong_only) and wong:
                continue
            v = margin + line + TEASE
            out.append(dict(season=season, gt=gt, side=side, line=line, margin=margin,
                            price=price, win=1 if v > 0 else (0 if v < 0 else None)))
    return out

def rate(ls):
    g = [l['win'] for l in ls if l['win'] is not None]
    n = len(g); p = sum(g) / n
    se = math.sqrt(p * (1 - p) / n)
    return n, p, se, len(ls) - n

def breakeven_price(p):
    """2-leg teaser: need p^2 * (1+b) = 1 -> b = 1/p^2 - 1. Return American odds."""
    b = 1 / (p * p) - 1
    return (-100 / b) if b < 1 else (100 * b)

wong = legs(rows, True)
n, p, se, pushes = rate(wong)
lo, hi = p - 1.96 * se, p + 1.96 * se
print(f'\nWONG LEGS (fav -7.5/-8.5, dog +1.5/+2.5, teased {TEASE:.0f} pts)')
print(f'  n = {n:,} graded legs ({pushes} pushes dropped), win rate {p*100:.2f}%  95% CI [{lo*100:.2f}, {hi*100:.2f}]')
print(f'  break-even leg rate at -110 is 72.38%  ->  beats it by {(p-0.72375)*100:+.2f}pp = {(p-0.72375)/se:+.2f} SE')
print(f'  FAIR 2-leg teaser price implied by the point estimate: {breakeven_price(p):+.1f}')
print(f'  ... at the CI bounds: {breakeven_price(hi):+.1f} (optimistic) to {breakeven_price(lo):+.1f} (pessimistic)')

# bootstrap the break-even price, by game (each leg is from a distinct game here, one side only)
random.seed(7)
g = [l['win'] for l in wong if l['win'] is not None]
bs = sorted(breakeven_price(sum(random.choices(g, k=len(g))) / len(g)) for _ in range(4000))
print(f'  bootstrap (4,000 reps) 95% interval on the fair price: '
      f'{bs[int(.975*len(bs))]:+.1f} to {bs[int(.025*len(bs))]:+.1f}')

# ---- control: every non-Wong side, teased the same 6 points
ctrl = legs(rows, False)
cn, cp, cse, _ = rate(ctrl)
print(f'\nCONTROL -- every NON-Wong side, teased the same {TEASE:.0f} points')
print(f'  n = {cn:,}  win rate {cp*100:.2f}%  (SE {cse*100:.2f})  '
      f'fair 2-leg price {breakeven_price(cp):+.1f}')
print(f'  Wong minus control: {(p-cp)*100:+.2f}pp, t = {(p-cp)/math.sqrt(se**2+cse**2):+.2f}')

# ---- placebo: random sides, matched on count, drawn from the same seasons
print(f'\nPLACEBO -- 500 random draws of {n:,} sides from ALL sides, teased the same {TEASE:.0f} pts')
allsides = legs(rows, False) + wong
pool = [l['win'] for l in allsides if l['win'] is not None]
null = sorted(sum(random.choices(pool, k=n)) / n for _ in range(500))
above = sum(1 for x in null if x >= p)
print(f'  null mean {sum(null)/len(null)*100:.2f}%  sd {(sum((x-sum(null)/len(null))**2 for x in null)/len(null))**.5*100:.2f}pp'
      f'   real {p*100:.2f}%  -> percentile {100*(1-above/len(null)):.1f}, '
      f'z = {(p - sum(null)/len(null))/((sum((x-sum(null)/len(null))**2 for x in null)/len(null))**.5):+.2f}')

# ---- bet-everything baseline at the REAL posted straight-spread price (pipeline control)
priced = [l for l in legs(rows, False) + wong
          if l['price'] is not None and l['win'] is not None]
# regrade at the untease line for the straight-bet control
tot = 0.0; m = 0
for season, gt, h, a, result, sl, hp, ap in rows:
    for line, margin, price in ((-sl, result, hp), (sl, -result, ap)):
        if price is None:
            continue
        v = margin + line
        if v == 0:
            continue
        b = (price / 100) if price > 0 else (100 / -price)
        tot += b if v > 0 else -1.0
        m += 1
print(f'\nBET-EVERYTHING CONTROL (straight spreads, real posted prices from nfldata_games)')
print(f'  n = {m:,} sides, EV per bet = {tot/m*100:+.2f}%   (must land near -4.3% to -4.9%)')

# ---- era split with intervals
print(f'\nERA SPLIT (the registry reported "no decay" with no interval)')
for lo_s, hi_s in ((1999, 2007), (2008, 2016), (2017, 2025), (2015, 2025)):
    ls = [l for l in wong if lo_s <= l['season'] <= hi_s]
    nn, pp, ss, _ = rate(ls)
    print(f'  {lo_s}-{hi_s}: n={nn:5,}  {pp*100:5.2f}% ± {ss*100:4.2f}   '
          f'fair price {breakeven_price(pp):+7.1f}   beats -110 by {(pp-0.72375)/ss:+5.2f} SE')

# ---- the price question, stated as the decision
print(f'\nTHE DECISION, AS A PRICE')
for american, label in ((-110, 'the price the claim needs'), (-120, 'typical US book'), (-130, 'worse book')):
    b = 100 / -american
    need = math.sqrt(1 / (1 + b))
    t = (p - need) / se
    print(f'  at {american}: need {need*100:.2f}% per leg, have {p*100:.2f}%  -> {t:+.2f} SE  '
          f'({"CLEARS" if t > 1.96 else "does not clear"})   [{label}]')
