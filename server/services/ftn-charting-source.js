/**
 * FTN's hand-charted play data (play action, motion, RPO, catchable, contested)
 * reaches this app through an nflverse-data release, but it is not covered by
 * nflverse-data's CC BY 4.0. FTN Data provides it under its own terms, stated in
 * nflreadr's loader docs (R/load_ftn_charting.R, read 2026-09-22 at nflreadr
 * main 23f915a5): "released under the CC-BY-SA 4.0 Creative Commons license
 * and attribution must be made to FTN Data via nflverse". So it gets its own
 * descriptor on the freshness report's `sources`, and its own credit on screen.
 *
 * The fetch itself is `ingestCharting` in nfl-formations.js, which writes
 * `nfl_play_charting`. This lives apart from that file only so the descriptor
 * could land without editing it; test/data-credit-line.test.js fails if
 * `release_url` stops matching the URL that loader fetches.
 */
export const FTN_CHARTING_SOURCE = Object.freeze({
  repo: 'nflverse/nflverse-data',
  dataset: 'ftn_charting',
  creator: 'FTN Data',
  attribution: 'FTN Data via nflverse',
  release_url: 'https://github.com/nflverse/nflverse-data/releases/download/ftn_charting',
  data_license: 'CC BY-SA 4.0',
  license_url: 'https://creativecommons.org/licenses/by-sa/4.0/',
  license_source: 'https://nflreadr.nflverse.com/reference/load_ftn_charting.html',
  modified: true,
  modification: 'Stored per play and averaged into weekly team features.',
  code_copied: false
});
