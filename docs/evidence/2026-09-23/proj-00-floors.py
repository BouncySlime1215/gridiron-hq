import csv, gzip, sys
csv.field_size_limit(10**9)
for s in range(2021, 2026):
    with gzip.open(f'play_by_play_{s}.csv.gz', 'rt', newline='') as f:
        r = csv.DictReader(f); n=0; games=set(); reg=0; pid=0
        for row in r:
            n+=1; games.add(row['game_id'])
            if row['play_id']!='' : pid+=1
            if row['season_type']=='REG': reg+=1
    with open(f'pbp_participation_{s}.csv', newline='') as f:
        r = csv.DictReader(f); m=0; g2=set(); op=0; players=0; rr=('route' in r.fieldnames)
        for row in r:
            m+=1; g2.add(row['nflverse_game_id'])
            ids=[x for x in (row.get('offense_players') or '').split(';') if x]
            if ids: op+=1; players+=len(ids)
    print(s, 'pbp_rows', n, 'with_play_id', pid, 'reg_rows', reg, 'games', len(games), '| part_rows', m, 'games', len(g2), 'rows_with_offense_players', op, 'offense_player_slots', players, 'route_col', rr)
