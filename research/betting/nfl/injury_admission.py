"""Shared injury evidence admission; missingness is not a healthy-team claim.

Archive rows need a documented historical version to enter the strict training
cohort. A final season CSV with a modified time alone remains an exploratory
source claim. Current snapshots instead rely on actual receipt before cutoff.
This module returns evidence and status counts, never an invented point spread.

Three information regimes, deliberately separate because they support
different claims:

  historical   An archived version whose publication time is documented AND
               whose archival was verified. The strongest claim, and the only
               one that may be called a reconstruction of what was published.
  observed     A row we actually received before the cutoff, by our own
               receipt clock. The strongest claim about what WE knew.
  unmodified_since
               A row from a CURRENT-STATE table (one row per key, updated in
               place) whose last modification precedes the cutoff. Because
               the row has not been touched since, its present content is its
               content as of that modification -- so it is admissible, but it
               is NOT an archived version and must never be reported as one:
               nothing here proves what the row said before that modification,
               only that nothing has changed it since.

               This regime is only as good as the writer that maintains the
               timestamp. It assumes every write to the source table bumps the
               modification time. A write path that updates content without
               touching that column breaks the guarantee silently, so a table
               relying on this mode needs that invariant enforced at the
               writer, not assumed here.
"""
from collections import Counter
from datetime import datetime


def canonical_team(team):
    return {'LA': 'LAR', 'STL': 'LAR', 'JAC': 'JAX', 'SD': 'LAC', 'OAK': 'LV'}.get(team, team)


def timestamp(value):
    if not value or not isinstance(value, str):
        return None
    try:
        date = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return date if date.tzinfo is not None else None
    except ValueError:
        return None


def injury_as_of(records, *, season, week, team, cutoff_at, mode='historical'):
    cutoff = timestamp(cutoff_at)
    if cutoff is None:
        raise ValueError('timezone-qualified injury cutoff required')
    if mode not in ('historical', 'observed', 'unmodified_since'):
        raise ValueError('unknown injury admission mode')
    rejected = Counter(); candidates = []
    for row in records:
        if row.get('season') != season or row.get('week') != week or canonical_team(row.get('team')) != canonical_team(team):
            continue
        if not row.get('gsis_id'):
            rejected['missing_player_identity'] += 1; continue
        modified = timestamp(row.get('date_modified'))
        received = timestamp(row.get('received_at'))
        if mode == 'historical':
            if modified is None:
                rejected['missing_publication_timestamp'] += 1; continue
            if modified > cutoff:
                rejected['published_after_cutoff'] += 1; continue
            if row.get('historical_version_verified') is not True:
                rejected['historical_version_unverified'] += 1; continue
            known = modified
        elif mode == 'unmodified_since':
            # The row's CURRENT content is its content as of `modified`, and
            # only because nothing has rewritten it since. A row touched after
            # the cutoff may hold a later revision, and the earlier text is
            # gone -- so it is rejected rather than read as if it were the
            # pre-cutoff version.
            if modified is None:
                rejected['missing_publication_timestamp'] += 1; continue
            if modified > cutoff:
                rejected['modified_after_cutoff'] += 1; continue
            known = modified
        else:
            if received is None or received > cutoff:
                rejected['not_received_by_cutoff'] += 1; continue
            if modified is not None and modified > cutoff:
                rejected['published_after_cutoff'] += 1; continue
            known = received
        candidates.append((known, row))
    latest = {}
    for known, row in sorted(candidates, key=lambda item: (item[0], item[1].get('source_hash', ''))):
        key = row['gsis_id']
        # Conflicting simultaneous versions cannot be resolved by file order.
        if key in latest and latest[key][0] == known and latest[key][1] != row:
            rejected['conflicting_same_time_versions'] += 1
            latest[key] = (known, None)
        elif key not in latest or latest[key][0] < known:
            latest[key] = (known, row)
    admitted = [row for _, row in latest.values() if row is not None]
    status_counts = Counter((r.get('report_status') or 'not_designated').lower() for r in admitted)
    return {
        'available': bool(admitted), 'missing': not admitted, 'team': canonical_team(team),
        'season': season, 'week': week, 'cutoff_at': cutoff_at, 'mode': mode,
        'accepted_rows': len(admitted), 'rejected': dict(rejected),
        'status_counts': dict(status_counts), 'records': admitted,
        'coverage': 'listed players only; absence of records does not establish a healthy roster',
        'evidence_strength': {
            'historical': 'archived version, publication time documented and archival verified',
            'observed': 'received before the cutoff by our own receipt clock',
            'unmodified_since': 'current-state row untouched since before the cutoff; NOT an '
                                'archived version, and silent if the source stops maintaining '
                                'its modification timestamp',
        }[mode],
    }
