/**
 * A real ESPN scoringSettings.scoringItems payload, shape-for-shape as stored on
 * leagues.payload — confirmed against a real synced league (see test/scoring.test.js,
 * which carries the same fixture inline; kept here too so a second test file can use
 * it without importing a test file as a module).
 */
export const REAL_1PPR_ITEMS = [
  { statId: 20, points: -2 }, { statId: 72, points: -2 },
  { statId: 3, points: 0.04 }, { statId: 24, points: 0.1 }, { statId: 42, points: 0.1 },
  { statId: 53, points: 1 }, { statId: 86, points: 1 }, { statId: 209, points: 1 },
  { statId: 19, points: 2 }, { statId: 26, points: 2 }, { statId: 44, points: 2 }, { statId: 206, points: 2 },
  { statId: 4, points: 4 },
  { statId: 25, points: 6 }, { statId: 43, points: 6 }, { statId: 104, points: 6 }
];
