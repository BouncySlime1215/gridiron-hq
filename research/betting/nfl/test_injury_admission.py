import unittest
from injury_admission import injury_as_of


class InjuryAdmissionTests(unittest.TestCase):
    def base(self, **overrides):
        return {'season': 2024, 'week': 1, 'team': 'LA', 'gsis_id': 'player-1',
                'report_status': 'Questionable', 'date_modified': '2024-09-06T12:00:00Z',
                'received_at': '2026-09-15T12:00:00Z', 'historical_version_verified': True, **overrides}

    def reduce(self, records, **kwargs):
        return injury_as_of(records, season=2024, week=1, team='LAR',
                            cutoff_at='2024-09-08T12:00:00Z', **kwargs)

    def test_later_correction_cannot_change_earlier_status(self):
        before = self.base()
        later = self.base(report_status='Out', date_modified='2024-09-09T12:00:00Z')
        result = self.reduce([later, before])
        self.assertEqual(result['status_counts'], {'questionable': 1})
        self.assertEqual(result['rejected'], {'published_after_cutoff': 1})

    def test_missing_time_or_unverified_version_never_implies_healthy(self):
        result = self.reduce([self.base(date_modified=None), self.base(historical_version_verified=False)])
        self.assertTrue(result['missing'])
        self.assertEqual(result['status_counts'], {})
        self.assertEqual(result['accepted_rows'], 0)

    def test_backfill_receipt_cannot_become_historical_observation(self):
        result = self.reduce([self.base()], mode='observed')
        self.assertEqual(result['rejected'], {'not_received_by_cutoff': 1})

    def test_versioned_history_resolves_latest_and_deduplicates(self):
        early = self.base(date_modified='2024-09-05T12:00:00Z', report_status='Doubtful')
        late = self.base()
        result = self.reduce([late, early, late])
        self.assertEqual(result['accepted_rows'], 1)
        self.assertEqual(result['status_counts'], {'questionable': 1})

    def test_conflicting_versions_fail_closed(self):
        result = self.reduce([self.base(), self.base(report_status='Out')])
        self.assertFalse(result['available'])
        self.assertEqual(result['rejected'], {'conflicting_same_time_versions': 1})

    def test_wrong_team_week_or_player_is_not_joined(self):
        result = self.reduce([self.base(team='KC'), self.base(week=2), self.base(gsis_id=None)])
        self.assertEqual(result['accepted_rows'], 0)
        self.assertEqual(result['rejected'], {'missing_player_identity': 1})


class UnmodifiedSinceModeTests(InjuryAdmissionTests):
    """The regime a current-state table (one row per key, updated in place)
    can actually support -- `nfl_injuries` has no version history at all."""

    def test_a_row_untouched_since_before_the_cutoff_is_admitted(self):
        # No archival verification exists for this row, and it must not need
        # any: the claim is only "nothing has rewritten this since".
        row = self.base(historical_version_verified=None, received_at=None)
        result = self.reduce([row], mode='unmodified_since')
        self.assertEqual(result['accepted_rows'], 1)
        self.assertEqual(result['status_counts'], {'questionable': 1})

    def test_a_row_modified_after_the_cutoff_is_rejected_not_read_as_earlier_text(self):
        # In-place mutation destroyed whatever it said before; the current
        # content is a later revision and cannot stand in for the earlier one.
        row = self.base(date_modified='2024-09-09T12:00:00Z', report_status='Out')
        result = self.reduce([row], mode='unmodified_since')
        self.assertTrue(result['missing'])
        self.assertEqual(result['rejected'], {'modified_after_cutoff': 1})

    def test_a_row_with_no_modification_time_is_rejected(self):
        # 2025 and 2026 rows in the real table are exactly this case.
        result = self.reduce([self.base(date_modified=None)], mode='unmodified_since')
        self.assertTrue(result['missing'])
        self.assertEqual(result['rejected'], {'missing_publication_timestamp': 1})

    def test_it_never_reports_itself_as_an_archived_version(self):
        result = self.reduce([self.base()], mode='unmodified_since')
        self.assertIn('NOT an archived version', result['evidence_strength'])
        self.assertNotEqual(result['evidence_strength'],
                            self.reduce([self.base()])['evidence_strength'])

    def test_an_unknown_mode_is_refused(self):
        with self.assertRaises(ValueError):
            self.reduce([self.base()], mode='whatever_is_convenient')


if __name__ == '__main__':
    unittest.main()
