export const name = '080_trade_outcomes_offer_loop';
/**
 * CLONE-01b b1, the offer loop: three columns on `trade_outcomes`, additive only.
 *
 * WHY A MIGRATION AT ALL. An `app_proposed` row today means "the app suggested
 * this", written by `recordProposalSlate` when the proposals run picks it. It
 * does not mean Nick sent it, and a calibration of P(accept) over suggestions
 * nobody sent would grade replies that never happened. `sent_at` is the one
 * fact that separates the two, and it has nowhere else to live.
 *
 *   sent_at        when Nick tapped "I sent this". NULL = suggested, not sent.
 *   matched_tx_id  the ESPN TRADE_PROPOSAL this offer was matched to. NOT
 *                  `espn_tx_id`: that column is the observed writer's
 *                  idempotency key (unique per league-season), so putting the
 *                  same id on the app row would collide with, or silently stand
 *                  in for, the observed row for the same proposal.
 *   settle_reason  why the settle job left the row where it is ("no ESPN
 *                  proposal matched yet", "matched, no answer yet", ...). A
 *                  pending row with no reason reads the same whether the
 *                  collector never ran or the manager is sitting on it.
 *
 * The partial unique index makes one ESPN proposal settle at most one sent
 * offer: two taps on two similar deals must not both claim the same reply.
 */
const COLUMNS = [['sent_at', 'TEXT'], ['matched_tx_id', 'TEXT'], ['settle_reason', 'TEXT']];
const cols = db => db.prepare('PRAGMA table_info(trade_outcomes)').all().map(c => c.name);

export function up(db) {
  const have = cols(db);
  if (!have.length) return; // 067 creates the table; nothing to extend without it
  for (const [c, t] of COLUMNS) if (!have.includes(c)) db.exec(`ALTER TABLE trade_outcomes ADD COLUMN ${c} ${t}`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_trade_outcomes_matched_tx
             ON trade_outcomes(league_id, season, matched_tx_id)
             WHERE matched_tx_id IS NOT NULL`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_trade_outcomes_sent
             ON trade_outcomes(league_id, season, status)
             WHERE sent_at IS NOT NULL`);
}

export function down(db) {
  db.exec('DROP INDEX IF EXISTS idx_trade_outcomes_sent');
  db.exec('DROP INDEX IF EXISTS idx_trade_outcomes_matched_tx');
  const have = cols(db);
  for (const [c] of COLUMNS) if (have.includes(c)) db.exec(`ALTER TABLE trade_outcomes DROP COLUMN ${c}`);
}
