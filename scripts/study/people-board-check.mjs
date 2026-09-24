#!/usr/bin/env node
/**
 * PEOPLE-BOARD check on a real DB: builds the War Room view and the clone rows for one
 * league exactly as the routes do, joins them with the client's own peopleTiles(), and
 * prints COUNTS ONLY (no team, manager or player names, no chat text): tiles, greyed
 * tiles and whose word greyed them, and per slot how many tiles are ok / unknown /
 * failed with each distinct unknown reason.
 *
 *   GRIDIRON_WARROOM_ENABLED=1 GRIDIRON_WARROOM_PEOPLE_ENABLED=1 node scripts/study/people-board-check.mjs 4
 *
 * Reads GRIDIRON_DB_PATH, GRIDIRON_CHAT_DB_PATH and the plans file (GRIDIRON_WARROOM_PLANS
 * or ~/gridiron-local/warroom/plans.json). Writes nothing.
 */
import { warRoomView } from '../../server/services/war-room-view.js';
import { warRoomClones } from '../../server/services/warroom-clones.js';
import { peopleBoardFlag } from '../../server/services/warroom-flag.js';
import { loadWarRoom } from '../../test/helpers/warroom-tsx.mjs';

const leagueId = Number(process.argv[2] ?? 4);
if (!Number.isInteger(leagueId) || leagueId < 1) throw new Error(`league id must be a positive integer, got ${process.argv[2]}`);

const flag = peopleBoardFlag();
const view = await warRoomView(leagueId);
if (!view.enabled) throw new Error('The War Room is off: set GRIDIRON_WARROOM_ENABLED=1.');
const clones = { ...warRoomClones(leagueId), people_board: flag };

const wr = await loadWarRoom();
try {
  const { peopleTiles } = await wr.mod('PeopleBoard');
  const tiles = peopleTiles(view, clones);
  const statusOf = f => f?.status ?? 'missing';
  const slots = ['mood', 'wants', 'credibility', 'p_responds', 'fatigue', 'last_contact', 'approach'];
  const out = {
    league: leagueId,
    flag,
    view_error: view.error ?? null,
    partners: statusOf(view.partners),
    partners_reason: view.partners?.status === 'ok' ? undefined : view.partners?.reason,
    partners_n: view.partners?.status === 'ok' ? view.partners.value.length : 0,
    clones: statusOf(clones.clones),
    clones_reason: clones.clones?.status === 'ok' ? undefined : clones.clones?.reason,
    clone_rows_n: clones.clones?.status === 'ok' ? clones.clones.value.length : 0,
    tiles: tiles.length,
    greyed: tiles.filter(t => t.grey).length,
    greyed_by_nick: tiles.filter(t => t.grey?.startsWith('Nick')).length,
    greyed_by_plan: tiles.filter(t => t.grey && !t.grey.startsWith('Nick')).length,
    checked_out: tiles.filter(t => t.checked_out).length,
    with_named_want: tiles.filter(t => t.wants.status === 'ok' && t.wants.value.length).length,
    with_roster_holes: tiles.filter(t => t.holes.length).length,
    slots: Object.fromEntries(slots.map(k => {
      const counts = { ok: 0, unknown: 0, failed: 0 };
      const reasons = {};
      for (const t of tiles) {
        const f = t[k];
        counts[f.status] = (counts[f.status] ?? 0) + 1;
        // Reasons are template sentences with counts; digits are masked so identical kinds group.
        if (f.status !== 'ok') { const r = String(f.reason ?? '').replace(/\d+/g, 'N'); reasons[r] = (reasons[r] ?? 0) + 1; }
      }
      return [k, { ...counts, reasons }];
    })),
  };
  console.log(JSON.stringify(out, null, 2));
} finally {
  wr.cleanup();
}
